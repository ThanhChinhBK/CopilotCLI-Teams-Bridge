import * as vscode from "vscode";
import { AcpClient } from "./acp";
import { BotServer } from "./bot";
import { openTunnel } from "./tunnel";
import type { BridgeMessage } from "./types";

let botServer: BotServer | undefined;
let acpClient: AcpClient | undefined;
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

async function handleTeamsMessage(msg: BridgeMessage): Promise<string> {
  if (!acpClient) {
    return "⚠️ ACP client is not running.";
  }

  log(`Incoming: "${msg.text}" (conversation: ${msg.conversationId})`);

  try {
    const response = await acpClient.send("runPrompt", { prompt: msg.text });

    if (response.error) {
      log(`ACP error: ${response.error.message}`);
      return `⚠️ Copilot error: ${response.error.message}`;
    }

    const text =
      response.result?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "_(no response)_";

    log(`Response: ${text.slice(0, 200)}…`);
    return text;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Error: ${message}`);
    return `⚠️ Error: ${message}`;
  }
}

async function startBridge(): Promise<void> {
  if (botServer) {
    vscode.window.showInformationMessage("Bridge is already running.");
    return;
  }

  const { appId, appPassword, port } = getConfig();

  if (!appId || !appPassword) {
    vscode.window.showErrorMessage(
      "Set copilotcli-teams-bridge.microsoftAppId and microsoftAppPassword in settings."
    );
    return;
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
  log("ACP client started.");

  // Start Bot Framework HTTP server
  botServer = new BotServer(appId, appPassword, handleTeamsMessage);
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
  acpClient?.stop();
  botServer?.stop().catch(() => {});
}
