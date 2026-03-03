# CopilotCLI-Teams Bridge — Design Document

## 1. Problem Statement

Developers often need to query their local workspace (including uncommitted changes, local build states, and unpushed branches) while away from their machine — for example, from a phone during commute or meetings. There is currently no way to interact with GitHub Copilot CLI's local context remotely.

## 2. Proposed Solution

A VS Code extension that bridges Microsoft Teams (as a mobile-friendly chat UI) to a local GitHub Copilot CLI process. The developer sends a message in a 1-on-1 Teams chat, which is routed to the local Copilot CLI agent, and the response is sent back to Teams.

## 3. Architecture Overview

```
┌──────────────┐     HTTPS      ┌──────────────────┐    JSON-RPC    ┌─────────────────┐
│  Teams App   │ ──────────────▶│  VS Code Extension│ ──────────────▶│ copilot --acp   │
│  (Mobile/    │     Azure Bot  │                    │    stdin/stdout │   --stdio       │
│   Desktop)   │◀────Service────│  ┌──────────────┐ │◀──────────────│                 │
│              │                │  │ Bot Server   │ │                │ (local workspace│
└──────────────┘                │  │ :3978        │ │                │  context)       │
                                │  └──────┬───────┘ │                └─────────────────┘
                                │         │         │
                                │  ┌──────┴───────┐ │
                                │  │ Dev Tunnel   │ │
                                │  │ (stable URL) │ │
                                │  └──────────────┘ │
                                └──────────────────┘
```

### Data Flow

1. User sends a message in Teams (personal 1:1 chat).
2. Azure Bot Service routes the HTTP POST to the Dev Tunnel URL.
3. VS Code Dev Tunnel forwards to the local Bot Server (port 3978).
4. Bot Server parses the message via `botbuilder` SDK.
5. Message text is sent to `copilot --acp --stdio` child process as a JSON-RPC request.
6. Copilot CLI reads the local workspace, processes the prompt, returns a JSON-RPC response.
7. Response is formatted as Markdown and sent back to the Teams conversation.

## 4. Components

### 4.1 VS Code Extension (`CopilotCLI-Teams-Bridge`)

**Repository:** `/Users/jeovach/dev/CopilotCLI-Teams-Bridge`

| File | Purpose |
|------|---------|
| `src/extension.ts` | Extension lifecycle (activate/deactivate), commands, status bar, orchestration |
| `src/bot.ts` | HTTP server + Bot Framework `CloudAdapter` for receiving Teams webhook POSTs |
| `src/acp.ts` | JSON-RPC client that spawns and communicates with `copilot --acp --stdio` |
| `src/tunnel.ts` | VS Code Dev Tunnel management via `vscode.env.asExternalUri` |
| `src/types.ts` | Shared TypeScript interfaces (JsonRpcRequest, JsonRpcResponse, BridgeMessage) |

**Commands:**

| Command | Description |
|---------|-------------|
| `CopilotCLI Teams: Start Bridge` | Starts ACP process, Bot Server, Dev Tunnel; auto-updates Azure Bot endpoint |
| `CopilotCLI Teams: Stop Bridge` | Stops all components |

**Configuration (VS Code Settings):**

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `microsoftAppId` | string | `""` | Azure Bot App ID |
| `microsoftAppPassword` | string | `""` | Azure Bot client secret |
| `localPort` | number | `3978` | Local webhook server port |

**Tech Stack:**
- TypeScript, esbuild (bundler)
- `botbuilder` SDK v4 (Bot Framework)
- `vscode` API (Dev Tunnels, commands, output channel)
- JSON-RPC over stdio (ACP protocol)

### 4.2 Teams Bot Registration (Azure)

**Azure Bot Resource:**
- **App ID:** `249edc0b-52c7-4446-982e-6d8fc395cb0e`
- **Type:** Single Tenant (Entra app set to multi-tenant for cross-tenant access)
- **Channel:** Microsoft Teams (enabled)
- **Messaging Endpoint:** Auto-updated by extension on each bridge start

**Entra App Registration:**
- **Supported account types:** Accounts in any organizational directory (multi-tenant)
- **Client secret:** Configured (stored locally in `.vscode/settings.json`, gitignored)

### 4.3 Teams App Manifest

**Repository:** `/Users/jeovach/dev/teams-bot-scaffold/CopilotCLI-Teams-Bot`

- **Scope:** `personal` only (no team or groupChat — prevents workspace leakage)
- **Manifest version:** 1.24
- **Bot ID:** `249edc0b-52c7-4446-982e-6d8fc395cb0e`
- Sideloaded into org Teams tenant with custom app upload enabled

## 5. Cross-Tenant Setup

| Component | Account / Tenant |
|-----------|-----------------|
| Azure Bot + Entra App Registration | Personal Azure subscription (personal tenant) |
| Teams app sideloading + usage | Org M365 tenant |
| Copilot CLI execution | Local machine (developer's workstation) |

This works because the Entra app is set to **multi-tenant**, allowing the org Teams tenant to authenticate with the bot registered in the personal Azure tenant.

## 6. Security Considerations

- **Personal scope only:** Bot cannot be added to group chats or channels. Only 1:1 conversations.
- **Dev Tunnel authentication:** Traffic routed through authenticated VS Code Dev Tunnels (no ngrok or public ports).
- **No secrets in repo:** `.vscode/settings.json` is gitignored; credentials stored locally only.
- **Local execution:** All Copilot CLI queries run against the local filesystem — no code is sent to external services beyond the AI model call.

## 7. Planned Features (Not Yet Implemented)

### 7.1 Auto-Update Azure Bot Messaging Endpoint
On each bridge start, the extension will call the Azure Bot Service REST API to automatically update the messaging endpoint URL with the current Dev Tunnel URL. This eliminates the need to manually visit Azure Portal when the tunnel URL changes.

**Approach:**
- Use `@azure/identity` + `@azure/arm-botservice` SDK, or direct REST API call
- Requires: Azure subscription ID, resource group name, bot resource name (new settings)
- Triggered during `startBridge()` after tunnel URL is obtained

### 7.2 Persistent Dev Tunnel
Configure a named VS Code Dev Tunnel so the URL remains stable across sessions, reducing (or eliminating) the need for endpoint auto-update.

### 7.3 Conversation State
Track conversation context so follow-up questions in Teams maintain continuity with previous prompts.

## 8. Prerequisites

- **GitHub Copilot CLI** installed globally (`npm install -g @githubnext/github-copilot-cli`)
- **VS Code** ≥ 1.96.0
- **Azure Bot** registered with Microsoft Teams channel enabled
- **Microsoft 365** org account with custom app sideloading permission
- **Node.js** ≥ 22.x

## 9. Development Workflow

```bash
# Build
cd /Users/jeovach/dev/CopilotCLI-Teams-Bridge
npm run compile

# Watch mode (development)
npm run watch

# Launch Extension Development Host
# Press F5 in VS Code

# Lint
npm run lint

# Package for distribution
npm run package
```

## 10. File Tree

```
CopilotCLI-Teams-Bridge/
├── .vscode/
│   ├── extensions.json
│   ├── launch.json
│   ├── settings.json          ← credentials (gitignored)
│   └── tasks.json
├── src/
│   ├── extension.ts           ← activation, commands, orchestration
│   ├── bot.ts                 ← Bot Framework HTTP server
│   ├── acp.ts                 ← JSON-RPC client for Copilot CLI
│   ├── tunnel.ts              ← Dev Tunnel management
│   └── types.ts               ← shared interfaces
├── dist/                      ← compiled output (gitignored)
├── .gitignore
├── .vscodeignore
├── CHANGELOG.md
├── README.md
├── esbuild.js
├── eslint.config.mjs
├── package.json
└── tsconfig.json

CopilotCLI-Teams-Bot/          (scaffold — used for manifest + provisioning only)
├── appPackage/
│   ├── manifest.json          ← personal scope only, hardcoded bot ID
│   ├── color.png
│   └── outline.png
├── env/
│   ├── .env.dev
│   ├── .env.dev.user
│   ├── .env.local
│   └── .env.local.user
└── m365agents.local.yml
```
