import * as vscode from "vscode";
import {
  TunnelManagementHttpClient,
  ManagementApiVersions,
} from "@microsoft/dev-tunnels-management";
import type { TunnelRequestOptions } from "@microsoft/dev-tunnels-management";
import {
  Tunnel,
  TunnelPort,
  TunnelAccessControlEntry,
  TunnelAccessControlEntryType,
  TunnelAccessScopes,
} from "@microsoft/dev-tunnels-contracts";
import { TunnelRelayTunnelHost } from "@microsoft/dev-tunnels-connections";

const STATE_KEY = "devTunnelInfo";

interface SavedTunnelInfo {
  tunnelId: string;
  clusterId: string;
}

let globalState: vscode.Memento | undefined;
let managementClient: TunnelManagementHttpClient | undefined;
let tunnelHost: TunnelRelayTunnelHost | undefined;
let activeTunnel: Tunnel | undefined;
let log: (msg: string) => void = () => {};

/**
 * Store a reference to globalState for persisting tunnel info across sessions.
 */
export function initTunnel(state: vscode.Memento, logger?: (msg: string) => void): void {
  globalState = state;
  if (logger) {
    log = logger;
  }
}

/**
 * Create or reuse a persistent Dev Tunnel and start hosting on the given local port.
 * Returns the public URI that Azure Bot Service should POST to.
 */
export async function openTunnel(localPort: number): Promise<vscode.Uri> {
  log("[Tunnel] openTunnel called for port " + localPort);
  const client = await getManagementClient();
  log("[Tunnel] Management client ready");

  const tunnel = await getOrCreateTunnel(client);
  log(`[Tunnel] Got tunnel: id=${tunnel.tunnelId} cluster=${tunnel.clusterId}`);

  // Create or update port with anonymous connect access
  const anonymousAccess: TunnelAccessControlEntry = {
    type: TunnelAccessControlEntryType.Anonymous,
    subjects: [],
    scopes: [TunnelAccessScopes.Connect],
  };

  const port: TunnelPort = {
    portNumber: localPort,
    protocol: "https",
    accessControl: { entries: [anonymousAccess] },
  };

  const portOptions: TunnelRequestOptions = {
    tokenScopes: [TunnelAccessScopes.Host],
  };

  log("[Tunnel] Creating tunnel port…");
  try {
    await client.createTunnelPort(tunnel, port, portOptions);
    log("[Tunnel] Port created");
  } catch (createPortErr: unknown) {
    const msg = createPortErr instanceof Error ? createPortErr.message : String(createPortErr);
    log(`[Tunnel] createTunnelPort failed: ${msg} — trying updateTunnelPort`);
    try {
      await client.updateTunnelPort(tunnel, port, portOptions);
      log("[Tunnel] Port updated");
    } catch (updatePortErr: unknown) {
      const umsg = updatePortErr instanceof Error ? updatePortErr.message : String(updatePortErr);
      log(`[Tunnel] updateTunnelPort also failed: ${umsg}`);
      throw updatePortErr;
    }
  }

  // Start hosting
  log("[Tunnel] Starting TunnelRelayTunnelHost…");
  tunnelHost = new TunnelRelayTunnelHost(client);
  tunnelHost.forwardConnectionsToLocalPorts = true;
  await tunnelHost.connect(tunnel);
  log("[Tunnel] Host connected");
  activeTunnel = tunnel;

  // Extract public URI
  const uri = extractTunnelUri(tunnel, localPort);
  log(`[Tunnel] Public URI: ${uri}`);
  return vscode.Uri.parse(uri);
}

/**
 * Stop hosting the tunnel (keeps the tunnel definition for reuse).
 */
export async function closeTunnel(): Promise<void> {
  if (tunnelHost) {
    try {
      tunnelHost.dispose();
    } catch {
      // Ignore dispose errors
    }
    tunnelHost = undefined;
  }
  activeTunnel = undefined;
  managementClient = undefined;
}

// ── Internal helpers ──────────────────────────────────────────────────

async function getGitHubToken(): Promise<string> {
  const session = await vscode.authentication.getSession(
    "github",
    ["user:email", "read:org"],
    { createIfNone: true }
  );
  return session.accessToken;
}

async function getManagementClient(): Promise<TunnelManagementHttpClient> {
  if (managementClient) {
    return managementClient;
  }
  managementClient = new TunnelManagementHttpClient(
    "copilotcli-teams-bridge/0.1",
    ManagementApiVersions.Version20230927preview,
    async () => `github ${await getGitHubToken()}`
  );
  return managementClient;
}

async function getOrCreateTunnel(
  client: TunnelManagementHttpClient
): Promise<Tunnel> {
  const saved = globalState?.get<SavedTunnelInfo>(STATE_KEY);
  log(`[Tunnel] Saved state: ${saved ? JSON.stringify(saved) : "none"}`);

  // Try to reuse saved tunnel
  if (saved) {
    log(`[Tunnel] Attempting getTunnel for saved id=${saved.tunnelId}…`);
    try {
      const existing = await client.getTunnel(
        { tunnelId: saved.tunnelId, clusterId: saved.clusterId },
        { tokenScopes: [TunnelAccessScopes.Host], includePorts: true }
      );
      if (existing) {
        log(`[Tunnel] Reusing existing tunnel id=${existing.tunnelId}`);
        return existing;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[Tunnel] getTunnel failed: ${msg} — clearing stale state`);
      await globalState?.update(STATE_KEY, undefined);
    }
  }

  // Create new tunnel (no custom name — let the service generate an ID)
  log("[Tunnel] Creating new tunnel…");
  const anonymousAccess: TunnelAccessControlEntry = {
    type: TunnelAccessControlEntryType.Anonymous,
    subjects: [],
    scopes: [TunnelAccessScopes.Connect],
  };

  let tunnel: Tunnel;
  try {
    tunnel = await client.createTunnel(
      { accessControl: { entries: [anonymousAccess] } },
      { tokenScopes: [TunnelAccessScopes.Host] }
    );
    log(`[Tunnel] Created tunnel id=${tunnel.tunnelId} cluster=${tunnel.clusterId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[Tunnel] createTunnel failed: ${msg}`);
    if (/limit/i.test(msg)) {
      throw new Error(
        "Dev Tunnels limit reached (max 10). Delete unused tunnels at https://devtunnels.ms and retry."
      );
    }
    throw err;
  }

  // Persist for reuse across sessions
  if (tunnel.tunnelId && tunnel.clusterId) {
    const info: SavedTunnelInfo = {
      tunnelId: tunnel.tunnelId,
      clusterId: tunnel.clusterId,
    };
    await globalState?.update(STATE_KEY, info);
    log(`[Tunnel] Saved tunnel info to globalState`);
  }

  return tunnel;
}

function extractTunnelUri(tunnel: Tunnel, port: number): string {
  // Prefer portForwardingUris from the tunnel port data
  const tunnelPort = tunnel.ports?.find((p: TunnelPort) => p.portNumber === port);
  if (tunnelPort?.portForwardingUris?.length) {
    return tunnelPort.portForwardingUris[0];
  }

  // Construct from tunnel metadata
  if (tunnel.tunnelId && tunnel.clusterId) {
    return `https://${tunnel.tunnelId}-${port}.${tunnel.clusterId}.devtunnels.ms`;
  }

  throw new Error("Unable to determine tunnel URI");
}
