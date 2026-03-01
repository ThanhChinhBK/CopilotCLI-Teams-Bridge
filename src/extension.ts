import * as vscode from "vscode";
import { AcpClient } from "./acp";
import { BotServer } from "./bot";
import { openTunnel } from "./tunnel";
import { ConversationState } from "./state";
import { parseCommand, handleCommand, handleCardAction, formatToolCall, formatPlan, buildCompletionActions, paginateMessage, stripAnsi, hasCodeBlocks, buildCodeCard } from "./commands";
import { buildPermissionCard, shortAlias } from "./cards";
import type { BridgeMessage, MessageReply, ToolCallInfo, PlanInfo, PermissionRequest, ModelInfo } from "./types";

let botServer: BotServer | undefined;
let acpClient: AcpClient | undefined;
let conversationState: ConversationState | undefined;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

function log(msg: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("copilotcli-teams-bridge");
  return {
    appId: cfg.get<string>("microsoftAppId", ""),
    appPassword: cfg.get<string>("microsoftAppPassword", ""),
    port: cfg.get<number>("localPort", 3978),
  };
}

async function handleTeamsMessage(
  msg: BridgeMessage,
  sendExtra: (reply: MessageReply) => Promise<void>
): Promise<MessageReply> {
  if (!acpClient || !conversationState) {
    return { text: "⚠️ ACP client is not running." };
  }

  // Handle Adaptive Card button clicks
  if (msg.value) {
    log(`Card action: ${JSON.stringify(msg.value)} (conversation: ${msg.conversationId})`);
    try {
      const result = await handleCardAction(msg.value, conversationState, acpClient);
      log(`Card action → ${(result.text ?? "card").slice(0, 100)}`);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Card action error: ${message}`);
      return { text: `⚠️ Action error: ${message}` };
    }
  }

  log(`Incoming: "${msg.text}" (conversation: ${msg.conversationId})`);

  // Handle permission text responses (fallback for when cards don't work)
  if (conversationState.pendingPermission) {
    const lower = msg.text.trim().toLowerCase();
    // Match option IDs or simple allow/deny
    const perm = conversationState.pendingPermission;
    const matchedOption = perm.options.find(
      (o) => o.optionId.toLowerCase() === lower || o.name.toLowerCase() === lower
    );
    if (matchedOption) {
      conversationState.pendingPermission = null;
      perm.resolve(matchedOption.optionId);
      return { text: `✅ Permission response: **${matchedOption.name}**` };
    }
    if (lower === "allow") {
      const allowOpt = perm.options.find((o) => o.kind.startsWith("allow"));
      if (allowOpt) {
        conversationState.pendingPermission = null;
        perm.resolve(allowOpt.optionId);
        return { text: `✅ Permission response: **${allowOpt.name}**` };
      }
    }
    if (lower === "deny" || lower === "reject") {
      const denyOpt = perm.options.find((o) => o.kind.startsWith("reject"));
      if (denyOpt) {
        conversationState.pendingPermission = null;
        perm.resolve(denyOpt.optionId);
        return { text: `✅ Permission response: **${denyOpt.name}**` };
      }
    }
  }

  // If there's a pending permission request, send card reminder
  if (conversationState.pendingPermission) {
    await sendExtra({ card: buildPermissionCard(conversationState.pendingPermission) });
  }

  // Check for slash commands
  const cmd = parseCommand(msg.text);
  if (cmd) {
    // /continue is special — sends "continue" as a prompt to the agent
    if (cmd.name === "continue") {
      try {
        await sendExtra({ text: "▶️ _Continuing…_" });
        botServer?.startTyping();
        const raw = await acpClient.prompt("continue");
        botServer?.stopTyping();
        const text = stripAnsi(raw);
        log(`Continue response: ${text.slice(0, 200)}…`);
        if (hasCodeBlocks(text)) {
          await sendExtra({ card: buildCodeCard(text) });
        } else {
          const pages = paginateMessage(text);
          for (const page of pages) {
            await sendExtra({ text: page });
          }
        }
        return { card: buildCompletionActions() };
      } catch (err: unknown) {
        botServer?.stopTyping();
        const message = err instanceof Error ? err.message : String(err);
        return { text: `⚠️ Error: ${message}` };
      }
    }
    try {
      const result = await handleCommand(cmd, conversationState, acpClient);
      log(`Command /${cmd.name} → ${(result.text ?? "card").slice(0, 100)}…`);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Command error: ${message}`);
      return { text: `⚠️ Command error: ${message}` };
    }
  }

  // Regular prompt passthrough
  try {
    botServer?.startTyping();
    const raw = await acpClient.prompt(msg.text);
    botServer?.stopTyping();
    const text = stripAnsi(raw);
    log(`Response: ${text.slice(0, 200)}…`);
    // Send response — use code card if it contains code blocks, otherwise paginate as text
    if (hasCodeBlocks(text)) {
      await sendExtra({ card: buildCodeCard(text) });
    } else {
      const pages = paginateMessage(text);
      for (const page of pages) {
        await sendExtra({ text: page });
      }
    }
    // Follow up with action buttons
    return { card: buildCompletionActions() };
  } catch (err: unknown) {
    botServer?.stopTyping();
    const message = err instanceof Error ? err.message : String(err);
    log(`Error: ${message}`);
    return { text: `⚠️ Error: ${message}` };
  }
}

async function startBridge(): Promise<void> {
  if (botServer) {
    vscode.window.showInformationMessage("Bridge is already running.");
    return;
  }

  const { appId, appPassword, port } = getConfig();

  if (!appId || !appPassword) {
    log("No App ID/Password configured — running in local debug mode (no auth).");
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder first.");
    return;
  }

  outputChannel.show(true);
  log("Starting bridge…");

  // Start ACP child process
  acpClient = new AcpClient(workspaceFolder);
  acpClient.on("log", (msg: string) => log(`[ACP] ${msg}`));
  acpClient.on("exit", (code: number) => log(`[ACP] exited (code ${code})`));
  acpClient.start();

  // Initialize session and capture mode/model state
  conversationState = new ConversationState();
  const sessionResult = await acpClient.initialize();
  conversationState.initFromSession(
    sessionResult.sessionId,
    sessionResult.modes,
    sessionResult.models
  );
  log(
    `ACP session ${sessionResult.sessionId} initialized.` +
      (sessionResult.modes ? ` Mode: ${sessionResult.modes.currentModeId}` : "") +
      (sessionResult.models?.currentModelId ? ` Model: ${sessionResult.models.currentModelId}` : "")
  );

  // Subscribe to rich ACP events — send to Teams proactively
  acpClient.on("toolCall", (info: ToolCallInfo) => {
    const msg = formatToolCall(info);
    log(`[ACP] Tool: ${msg}`);
    // Skip tool calls that are permission requests — the permission card covers them
    const id = (info.toolCallId ?? "") as string;
    if (info.status === "pending" && id.includes("permission")) {
      return;
    }
    if (botServer) {
      void botServer.sendProactive({ text: msg });
    }
  });
  acpClient.on("plan", (info: PlanInfo) => {
    const msg = formatPlan(info);
    log(`[ACP] ${msg}`);
    if (botServer) {
      void botServer.sendProactive({ text: msg });
    }
  });
  acpClient.on("modeChanged", (modeId: string) => {
    conversationState?.setMode(modeId);
    const alias = shortAlias(modeId);
    log(`[ACP] Mode changed to: ${alias}`);
    if (botServer) {
      void botServer.sendProactive({ text: `🔄 Mode switched to **${alias}**` });
    }
  });
  acpClient.on("modelsChanged", (models: ModelInfo[]) => {
    conversationState?.setAvailableModels(models);
    log(`[ACP] Available models updated: ${models.map((m) => m.modelId).join(", ")}`);
  });
  acpClient.on("permissionRequest", (req: PermissionRequest) => {
    log(`[ACP] Permission requested: toolCall=${req.toolCallId} title="${req.title}" options=[${req.options.map((o) => o.optionId).join(", ")}]`);

    // Auto-approve: automatically select the first "allow" option
    if (conversationState?.autoApprove) {
      const allowOpt = req.options.find((o) => o.kind.startsWith("allow"));
      if (allowOpt) {
        req.resolve(allowOpt.optionId);
        log(`[ACP] Auto-approved: ${allowOpt.name}`);
        if (botServer) {
          void botServer.sendProactive({ text: `🔓 Auto-approved: **${req.title || "permission"}** → ${allowOpt.name}` });
        }
        return;
      }
    }

    if (conversationState) {
      conversationState.pendingPermission = req;
    }
    // Send the permission card proactively
    if (botServer) {
      void botServer.sendProactive({ card: buildPermissionCard(req) });
    }
  });

  // Start Bot Framework HTTP server
  botServer = new BotServer(appId, appPassword, handleTeamsMessage, log);
  await botServer.start(port);
  log(`Bot server listening on port ${port}.`);

  // Open Dev Tunnel
  try {
    const tunnelUri = await openTunnel(port);
    log(`Dev Tunnel URL: ${tunnelUri.toString()}`);
    vscode.window.showInformationMessage(
      `Bridge running. Tunnel: ${tunnelUri.toString()}/api/messages`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Tunnel error: ${message}`);
    vscode.window.showWarningMessage(
      `Bridge running locally on port ${port}, but Dev Tunnel failed: ${message}`
    );
  }

  statusBarItem.text = "$(radio-tower) Teams Bridge: ON";
  statusBarItem.tooltip = "CopilotCLI-Teams Bridge is running";
}

async function stopBridge(): Promise<void> {
  if (!botServer && !acpClient) {
    vscode.window.showInformationMessage("Bridge is not running.");
    return;
  }

  log("Stopping bridge…");
  acpClient?.stop();
  acpClient = undefined;
  conversationState = undefined;

  await botServer?.stop();
  botServer = undefined;

  statusBarItem.text = "$(radio-tower) Teams Bridge: OFF";
  statusBarItem.tooltip = "CopilotCLI-Teams Bridge is stopped";
  log("Bridge stopped.");
  vscode.window.showInformationMessage("Bridge stopped.");
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("CopilotCLI-Teams Bridge");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = "$(radio-tower) Teams Bridge: OFF";
  statusBarItem.command = "copilotcli-teams-bridge.start";
  statusBarItem.show();

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    vscode.commands.registerCommand("copilotcli-teams-bridge.start", startBridge),
    vscode.commands.registerCommand("copilotcli-teams-bridge.stop", stopBridge)
  );
}

export function deactivate(): void {
  if (acpClient) {
    acpClient.stop();
    acpClient = undefined;
  }
  if (botServer) {
    botServer.stop().catch(() => {});
    botServer = undefined;
  }
  conversationState = undefined;
}
