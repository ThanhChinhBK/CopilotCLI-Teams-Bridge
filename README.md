# CopilotCLI-Teams Bridge

A VS Code extension that bridges Microsoft Teams to your local GitHub Copilot CLI. Chat with your workspace from your phone.

<!-- Replace with your demo gif -->
![Demo](demo.gif)

## How It Works

```
Teams App  →  Azure Bot Service  →  Dev Tunnel  →  VS Code Extension  →  Copilot CLI (local)
```

Messages from Teams are forwarded to a local `copilot --acp --stdio` process via JSON-RPC. Responses stream back as Adaptive Cards with code blocks, diffs, and action buttons.

## Features

- Query your local workspace (including unpushed changes) from Teams mobile/desktop
- Interactive permission prompts and auto-approve mode
- Rich diff cards for file edits
- Slash commands: `/mode`, `/model`, `/status`, `/cancel`, `/approve`
- Persistent Dev Tunnel URL (no reconfiguration on restart)

## Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and signed in
- An [Azure Bot](https://portal.azure.com/#create/Microsoft.BotServiceConnectivityGalleryPackage) resource (Single-tenant)
- A Microsoft Entra app registration (Multi-tenant) with a client secret
- A [Teams app package](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package) sideloaded in your org

## Setup

1. **Install** the extension and run `npm install && node esbuild.js`

2. **Configure** in `.vscode/settings.json` (gitignored):
   ```jsonc
   {
     "copilotcli-teams-bridge.microsoftAppId": "<your-entra-app-id>",
     "copilotcli-teams-bridge.microsoftAppPassword": "<your-client-secret>",
     "copilotcli-teams-bridge.microsoftAppTenantId": "<your-tenant-id>",
     "copilotcli-teams-bridge.localPort": 3978
   }
   ```

3. **Start** via Command Palette → `CopilotCLI Teams: Start Bridge`

4. **Copy the tunnel URL** from the Output panel and set it as your Azure Bot's messaging endpoint:
   ```
   https://<tunnel-id>.devtunnels.ms/api/messages
   ```
   This only needs to be done once — the URL persists across restarts.

5. **Send a message** from Teams and you're good to go.


## Commands

| Command | Description |
|---------|-------------|
| `CopilotCLI Teams: Start Bridge` | Start the bot server, ACP process, and Dev Tunnel |
| `CopilotCLI Teams: Stop Bridge` | Stop all bridge components |
| `CopilotCLI Teams: Reset Tunnel URL` | Delete the saved tunnel and generate a new URL |

## License

MIT
