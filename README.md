# CopilotCLI-Teams Bridge

A VS Code extension that connects a Microsoft Teams personal bot to your local GitHub Copilot CLI. Query your local, uncommitted workspace from the Teams mobile app.

## Overview

This extension acts as a local webhook and translation layer. It bridges the Microsoft Bot Framework (via Teams) and the GitHub Copilot CLI (via the Agent Client Protocol), allowing you to trigger local AI agent tasks remotely without exposing public ports.

## How It Works

1. **Transport** — Uses built-in VS Code Dev Tunnels to securely receive HTTP POST requests from Azure Bot Service. No third-party tunneling tools required.
2. **Translation (ACP)** — Incoming Teams messages are parsed and sent to a local `copilot --acp --stdio` child process using JSON-RPC.
3. **Execution** — The local Copilot CLI reads your current workspace context, processes the prompt, and generates a response.
4. **Response** — The extension captures the stdout stream, formats it as standard Markdown, and pushes it back to the Teams chat using the `botbuilder` SDK.

## Features

- **Local Context** — Queries run against your local file system, including unpushed changes and local build states.
- **Secure Routing** — Traffic is routed through authenticated VS Code Dev Tunnels.
- **1-on-1 Chat Interface** — Works strictly with a Personal Scope MS Teams bot to prevent workspace leakage in group channels.

## Prerequisites

- **GitHub Copilot CLI** installed globally (`npm install -g @githubnext/github-copilot-cli` or equivalent).
- A configured **Microsoft Teams Bot** (Personal Scope) via the Azure Bot Framework.

## Getting Started

1. Install the extension.
2. Configure the required settings:
   - `copilotcli-teams-bridge.microsoftAppId` — Your Azure Bot App ID.
   - `copilotcli-teams-bridge.microsoftAppPassword` — Your Azure Bot App Secret.
3. Open the Command Palette and run **CopilotCLI Teams: Start Bridge**.
4. The extension starts a local server, opens a Dev Tunnel, and logs the public URL. Point your Azure Bot's messaging endpoint to `<tunnel-url>/api/messages`.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotcli-teams-bridge.microsoftAppId` | `""` | Microsoft App ID for Azure Bot registration |
| `copilotcli-teams-bridge.microsoftAppPassword` | `""` | Microsoft App Password (client secret) |
| `copilotcli-teams-bridge.localPort` | `3978` | Local port for the Bot Framework webhook server |

## Commands

| Command | Description |
|---------|-------------|
| `CopilotCLI Teams: Start Bridge` | Start the bot server, ACP process, and Dev Tunnel |
| `CopilotCLI Teams: Stop Bridge` | Stop all bridge components |

## License

MIT
