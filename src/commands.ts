import type { AcpClient } from "./acp";
import type { ConversationState } from "./state";
import type {
  ParsedCommand,
  ToolCallInfo,
  PlanInfo,
  PermissionRequest,
  MessageReply,
  CardActionData,
} from "./types";
import {
  shortAlias,
  resolveModeAlias,
  resolveModelAlias,
  buildModeCard,
  buildModelCard,
  buildHelpCard,
} from "./cards";

// ─── Command Parsing ───

/** Parse a `/command arg1 arg2` message. Returns null for non-commands. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const name = parts[0].substring(1).toLowerCase();
  return { name, args: parts.slice(1), raw: trimmed };
}

// ─── Command Router ───

/** Execute a parsed command and return the formatted response. */
export async function handleCommand(
  cmd: ParsedCommand,
  state: ConversationState,
  acp: AcpClient
): Promise<MessageReply> {
  switch (cmd.name) {
    case "mode":
      return handleMode(cmd.args, state, acp);
    case "model":
      return handleModel(cmd.args, state, acp);
    case "cancel":
      return { text: handleCancel(acp) };
    case "approve":
      return { text: handleApprove(state) };
    case "sessions":
      return { text: await handleSessions(cmd.args, state, acp) };
    case "status":
      return { text: handleStatus(state) };
    case "help":
      return { card: buildHelpCard() };
    default:
      return {
        text: `⚠️ Unknown command: \`/${cmd.name}\`\n\nType \`/help\` for available commands.`,
      };
  }
}

// ─── Card Action Handler ───

/** Handle an Adaptive Card Action.Submit click. */
export async function handleCardAction(
  action: CardActionData,
  state: ConversationState,
  acp: AcpClient
): Promise<MessageReply> {
  switch (action.action) {
    case "set_mode": {
      if (!action.modeId) {
        return { text: "⚠️ No mode specified." };
      }
      try {
        await acp.setMode(action.modeId);
        state.setMode(action.modeId);
        return { text: `✅ Mode switched to **${shortAlias(action.modeId)}**` };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `⚠️ Failed to switch mode: ${message}` };
      }
    }
    case "set_model": {
      if (!action.modelId) {
        return { text: "⚠️ No model specified." };
      }
      try {
        await acp.setModel(action.modelId);
        state.setModel(action.modelId);
        return {
          text: `✅ Model switched to **${shortAlias(action.modelId)}**`,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `⚠️ Failed to switch model: ${message}` };
      }
    }
    case "permission": {
      if (!state.pendingPermission) {
        return { text: "⚠️ No pending permission request." };
      }
      const perm = state.pendingPermission;
      state.pendingPermission = null;
      const optionId = action.optionId ?? null;
      perm.resolve(optionId);
      const chosen = perm.options.find((o) => o.optionId === optionId);
      const label = chosen?.name ?? optionId ?? "cancelled";
      return {
        text: `✅ Permission response: **${label}**`,
      };
    }
    case "command": {
      if (action.command) {
        const cmd = parseCommand(action.command);
        if (cmd) {
          return handleCommand(cmd, state, acp);
        }
      }
      return { text: "⚠️ Invalid command." };
    }
    default:
      return { text: "⚠️ Unknown card action." };
  }
}

// ─── Handlers ───

async function handleMode(
  args: string[],
  state: ConversationState,
  acp: AcpClient
): Promise<MessageReply> {
  if (args.length === 0) {
    if (state.availableModes.length > 0) {
      return {
        card: buildModeCard(state.currentModeId, state.availableModes),
      };
    }
    const current = state.currentModeId
      ? shortAlias(state.currentModeId)
      : "default";
    return {
      text: `**Current mode:** ${current}\n\n_No alternative modes advertised by the agent._`,
    };
  }

  const resolved = resolveModeAlias(args[0], state.availableModes);
  const modeId = resolved ?? args[0];
  try {
    await acp.setMode(modeId);
    state.setMode(modeId);
    return { text: `✅ Mode switched to **${shortAlias(modeId)}**` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `⚠️ Failed to switch mode: ${message}` };
  }
}

async function handleModel(
  args: string[],
  state: ConversationState,
  acp: AcpClient
): Promise<MessageReply> {
  if (args.length === 0) {
    if (state.availableModels.length > 0) {
      return {
        card: buildModelCard(state.currentModelId, state.availableModels),
      };
    }
    const current = state.currentModelId
      ? shortAlias(state.currentModelId)
      : "default";
    return {
      text: `**Current model:** ${current}\n\n_No alternative models advertised by the agent._`,
    };
  }

  const resolved = resolveModelAlias(args[0], state.availableModels);
  const modelId = resolved ?? args[0];
  try {
    await acp.setModel(modelId);
    state.setModel(modelId);
    return { text: `✅ Model switched to **${shortAlias(modelId)}**` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `⚠️ Failed to switch model: ${message}` };
  }
}

function handleCancel(acp: AcpClient): string {
  acp.cancel();
  return "🛑 Cancel signal sent.";
}

async function handleSessions(
  args: string[],
  state: ConversationState,
  acp: AcpClient
): Promise<string> {
  const action = args[0] ?? "list";

  if (action === "list") {
    try {
      const sessions = await acp.listSessions();
      if (sessions.length === 0) {
        return "📋 No previous sessions found (or agent does not support listing).";
      }
      const list = sessions
        .map(
          (s) =>
            `• \`${s.sessionId}\`${s.title ? ` — ${s.title}` : ""}${s.createdAt ? ` (${s.createdAt})` : ""}`
        )
        .join("\n");
      return `📋 **Sessions:**\n${list}\n\nUsage: \`/sessions load sessionId\``;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `⚠️ Failed to list sessions: ${message}`;
    }
  }

  if (action === "load") {
    const sessionId = args[1];
    if (!sessionId) {
      return "⚠️ Usage: `/sessions load sessionId`";
    }
    try {
      const result = await acp.loadSession(sessionId);
      state.initFromSession(result.sessionId, result.modes, result.models);
      return `✅ Session \`${sessionId}\` loaded.`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `⚠️ Failed to load session: ${message}`;
    }
  }

  return `⚠️ Unknown sessions action: \`${action}\`\n\nUsage: \`/sessions list\` or \`/sessions load id\``;
}

function handleApprove(state: ConversationState): string {
  state.autoApprove = !state.autoApprove;
  return state.autoApprove
    ? "✅ **Auto-approve ON** — All permission requests will be automatically allowed."
    : "❌ **Auto-approve OFF** — Permission requests will show Allow/Deny cards.";
}

function handleStatus(state: ConversationState): string {
  return `📊 **Bridge Status**\n\n${state.formatStatus()}`;
}

// ─── Rich Update Formatting ───

/** Format a tool call update for display in Teams. */
export function formatToolCall(info: ToolCallInfo): string {
  const displayName = info.title ?? info.name ?? "Tool";

  // Status emoji
  const statusIcon: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔧",
    completed: "✅",
    failed: "❌",
    // Legacy
    running: "🔧",
    error: "❌",
  };
  const icon = statusIcon[info.status ?? ""] ?? "🔧";

  // Kind emoji
  const kindIcon: Record<string, string> = {
    read: "📖",
    edit: "✏️",
    delete: "🗑️",
    execute: "▶️",
    search: "🔍",
    think: "💭",
    fetch: "🌐",
    move: "📦",
  };
  const kIcon = info.kind ? (kindIcon[info.kind] ?? "") : "";

  let msg = `${icon}${kIcon ? " " + kIcon : ""} **${displayName}**`;

  // Show file path from rawInput or locations
  const fileName = info.rawInput?.fileName as string | undefined;
  const command = info.rawInput?.command as string | undefined;
  const path = info.locations?.[0]?.path;
  if (fileName) {
    msg += `\n📄 \`${fileName}\``;
  } else if (command) {
    msg += `\n▶ \`${command}\``;
  } else if (path) {
    msg += `\n📄 \`${path}\``;
  } else if (info.input) {
    msg += `: \`${summarizeInput(info.input)}\``;
  }

  // Show error on failure
  if (info.status === "failed" && info.error) {
    msg += `\n> ❌ ${info.error}`;
  }

  return msg;
}

/** Build a completion card with action buttons after a prompt finishes. */
export function buildCompletionActions(modeId?: string | null): Record<string, unknown> {
  const inPlanMode = modeId ? /plan|architect/i.test(modeId) : false;

  const actions = inPlanMode
    ? [
        {
          type: "Action.Submit",
          title: "🚀 Start Implementing",
          data: { action: "command", command: "/implement" },
        },
        {
          type: "Action.Submit",
          title: "⚡ Autopilot",
          data: { action: "command", command: "/autopilot" },
        },
        {
          type: "Action.Submit",
          title: "📄 View Plan",
          data: { action: "command", command: "/viewplan" },
        },
        {
          type: "Action.Submit",
          title: "📊 Status",
          data: { action: "command", command: "/status" },
        },
      ]
    : [
        {
          type: "Action.Submit",
          title: "🔄 Switch Mode",
          data: { action: "command", command: "/mode" },
        },
        {
          type: "Action.Submit",
          title: "📊 Status",
          data: { action: "command", command: "/status" },
        },
      ];

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    actions,
  };
}

/** Format a plan update for display in Teams. */
export function formatPlan(info: PlanInfo): string {
  if (info.steps && info.steps.length > 0) {
    const steps = info.steps
      .map((s) => {
        const icon =
          s.status === "done" ? "✅" : s.status === "running" ? "⏳" : "○";
        return `${icon} ${s.description}`;
      })
      .join("\n");
    return `📋 **Plan:**\n${steps}`;
  }
  if (info.content) {
    return `📋 **Plan:**\n${info.content}`;
  }
  return "📋 _(plan update)_";
}

/** Format a permission request for display in Teams (text fallback). */
export function formatPermissionRequest(req: PermissionRequest): string {
  const optionsList = req.options
    .map((o) => `\`${o.optionId}\` — ${o.name}`)
    .join("\n");
  return (
    `🔐 **Permission Required**\n\n` +
    (req.title ? `${req.title}\n\n` : "") +
    (optionsList ? `**Options:**\n${optionsList}\n\n` : "") +
    `Reply with an option ID to respond.`
  );
}

/** Create a short preview of a tool input object. */
function summarizeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length > 200 ? json.slice(0, 200) + "…" : json;
}

// ─── Message Utilities ───

/** Strip ANSI escape codes from text. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

const MAX_MESSAGE_LENGTH = 3800;

/** Map markdown language tags to Teams CodeBlock language values. */
const LANG_MAP: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  py: "Python", python: "Python", rb: "Python", ruby: "Python",
  sh: "Bash", bash: "Bash", zsh: "Bash", shell: "Bash",
  json: "Json", yaml: "PlainText", yml: "PlainText", toml: "PlainText",
  html: "Html", css: "Css", xml: "Xml", svg: "Xml",
  sql: "Sql", go: "Go", java: "Java", cs: "CSharp", csharp: "CSharp",
  cpp: "Cpp", "c++": "Cpp", c: "C", objc: "ObjectiveC",
  php: "Php", perl: "Perl", ps1: "PowerShell", powershell: "PowerShell",
  graphql: "Graphql", vb: "VbNet", dos: "Dos", cmd: "Dos",
  diff: "PlainText", md: "PlainText", markdown: "PlainText",
};

/** Check if text contains fenced code blocks. */
export function hasCodeBlocks(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

/**
 * Build an Adaptive Card with CodeBlock elements for syntax highlighting.
 * Splits text into TextBlock (prose) and CodeBlock (fenced code) sections.
 */
export function buildCodeCard(text: string): Record<string, unknown> {
  const body: Record<string, unknown>[] = [];
  // Split on fenced code blocks: ```lang\ncode\n```
  const parts = text.split(/(```[^\n]*\n[\s\S]*?```)/g);

  for (const part of parts) {
    const codeMatch = part.match(/^```([^\n]*)\n([\s\S]*?)```$/);
    if (codeMatch) {
      const langTag = codeMatch[1].trim().toLowerCase();
      const code = codeMatch[2].trimEnd();
      const language = LANG_MAP[langTag] ?? "PlainText";
      body.push({
        type: "CodeBlock",
        codeSnippet: code,
        language,
      });
    } else if (part.trim()) {
      body.push({
        type: "TextBlock",
        text: part.trim(),
        wrap: true,
      });
    }
  }

  if (body.length === 0) {
    body.push({ type: "TextBlock", text: text, wrap: true });
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.6",
    body,
  };
}

/**
 * Build an Adaptive Card that clearly labels the response as an implementation summary.
 * Adds a header banner so users don't mistake it for a new plan or instructions.
 */
export function buildSummaryCard(text: string): Record<string, unknown> {
  const body: Record<string, unknown>[] = [];

  // Header — clearly marks this as a completed summary
  body.push({
    type: "ColumnSet",
    columns: [
      {
        type: "Column",
        width: "auto",
        items: [{ type: "TextBlock", text: "✅", size: "Large" }],
      },
      {
        type: "Column",
        width: "stretch",
        items: [
          { type: "TextBlock", text: "Implementation Complete", weight: "Bolder", size: "Medium" },
          { type: "TextBlock", text: "Summary of changes made", isSubtle: true, spacing: "None" },
        ],
      },
    ],
  });

  // Separator
  body.push({
    type: "TextBlock",
    text: " ",
    spacing: "Small",
    separator: true,
  });

  // Content — split into TextBlock and CodeBlock sections (same as buildCodeCard)
  const parts = text.split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    const codeMatch = part.match(/^```([^\n]*)\n([\s\S]*?)```$/);
    if (codeMatch) {
      const langTag = codeMatch[1].trim().toLowerCase();
      const code = codeMatch[2].trimEnd();
      const language = LANG_MAP[langTag] ?? "PlainText";
      body.push({ type: "CodeBlock", codeSnippet: code, language });
    } else if (part.trim()) {
      body.push({ type: "TextBlock", text: part.trim(), wrap: true });
    }
  }

  if (body.length <= 2) {
    // Only header + separator, no content parsed — show raw text
    body.push({ type: "TextBlock", text: text, wrap: true });
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.6",
    body,
  };
}

/** Split a long message into Teams-safe chunks (<4000 chars each). */
export function paginateMessage(text: string): string[] {
  const clean = stripAnsi(text);
  if (clean.length <= MAX_MESSAGE_LENGTH) {
    return [clean];
  }

  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      // No good newline break — split at space
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH * 0.3) {
      // No good break point — hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  // Add part indicators
  if (chunks.length > 1) {
    return chunks.map(
      (c, i) => `**(${i + 1}/${chunks.length})**\n\n${c}`
    );
  }
  return chunks;
}
