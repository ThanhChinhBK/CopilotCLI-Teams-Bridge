import type { SessionMode, ModelInfo, PermissionRequest } from "./types";

/** Extract short alias from a mode/model ID (URL fragment or full string). */
export function shortAlias(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash >= 0 ? id.substring(hash + 1) : id;
}

/** Resolve a short alias to the full mode ID. Returns undefined if no match. */
export function resolveModeAlias(
  alias: string,
  modes: SessionMode[]
): string | undefined {
  if (modes.some((m) => m.modeId === alias)) {
    return alias;
  }
  const lower = alias.toLowerCase();
  return modes.find((m) => shortAlias(m.modeId).toLowerCase() === lower)
    ?.modeId;
}

/** Resolve a short alias to the full model ID. Returns undefined if no match. */
export function resolveModelAlias(
  alias: string,
  models: ModelInfo[]
): string | undefined {
  if (models.some((m) => m.modelId === alias)) {
    return alias;
  }
  const lower = alias.toLowerCase();
  return models.find((m) => shortAlias(m.modelId).toLowerCase() === lower)
    ?.modelId;
}

// ─── Adaptive Card Builders ───

function baseCard(): Record<string, unknown> {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
  };
}

/** Build a mode-selection Adaptive Card. */
export function buildModeCard(
  currentModeId: string | null,
  modes: SessionMode[]
): Record<string, unknown> {
  const current = currentModeId ? shortAlias(currentModeId) : "default";
  return {
    ...baseCard(),
    body: [
      {
        type: "TextBlock",
        text: "🔄 Switch Mode",
        size: "Medium",
        weight: "Bolder",
      },
      {
        type: "TextBlock",
        text: `Current: **${current}**`,
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: modes.map((m) => {
      const alias = shortAlias(m.modeId);
      const isCurrent = m.modeId === currentModeId;
      return {
        type: "Action.Submit",
        title: isCurrent ? `▸ ${alias}` : alias,
        data: { action: "set_mode", modeId: m.modeId },
      };
    }),
  };
}

/** Build a model-selection Adaptive Card. */
export function buildModelCard(
  currentModelId: string | null,
  models: ModelInfo[]
): Record<string, unknown> {
  const current = currentModelId ? shortAlias(currentModelId) : "default";
  return {
    ...baseCard(),
    body: [
      {
        type: "TextBlock",
        text: "🤖 Switch Model",
        size: "Medium",
        weight: "Bolder",
      },
      {
        type: "TextBlock",
        text: `Current: **${current}**`,
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: models.map((m) => {
      const alias = shortAlias(m.modelId);
      const isCurrent = m.modelId === currentModelId;
      return {
        type: "Action.Submit",
        title: isCurrent ? `▸ ${alias}` : alias,
        data: { action: "set_model", modelId: m.modelId },
      };
    }),
  };
}

/** Build a permission-request Adaptive Card with ACP options as buttons. */
export function buildPermissionCard(req: PermissionRequest): Record<string, unknown> {
  const bodyItems: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: "🔐 Permission Required",
      size: "Medium",
      weight: "Bolder",
      wrap: true,
    },
  ];

  if (req.title) {
    bodyItems.push({
      type: "TextBlock",
      text: `**${req.title}**`,
      wrap: true,
    });
  }

  // Extract and display details from rawInput
  const details: string[] = [];
  if (req.rawInput.fileName) {
    details.push(`📄 \`${req.rawInput.fileName}\``);
  }
  if (req.rawInput.command) {
    details.push(`▶ \`${req.rawInput.command}\``);
  }
  if (req.rawInput.path && req.rawInput.path !== req.rawInput.fileName) {
    details.push(`📁 \`${req.rawInput.path}\``);
  }
  if (details.length > 0) {
    bodyItems.push({
      type: "TextBlock",
      text: details.join("\n\n"),
      wrap: true,
    });
  }

  // Build buttons from ACP options
  const actions = req.options.map((opt) => {
    const isAllow = opt.kind.startsWith("allow");
    return {
      type: "Action.Submit",
      title: opt.name,
      style: isAllow ? "positive" : "destructive",
      data: { action: "permission", optionId: opt.optionId },
    };
  });

  // Fallback buttons if no options provided
  if (actions.length === 0) {
    actions.push(
      {
        type: "Action.Submit",
        title: "✅ Allow",
        style: "positive",
        data: { action: "permission", optionId: "allow_once" },
      },
      {
        type: "Action.Submit",
        title: "❌ Deny",
        style: "destructive",
        data: { action: "permission", optionId: "reject_once" },
      }
    );
  }

  return {
    ...baseCard(),
    body: bodyItems,
    actions,
  };
}

/** Build a help Adaptive Card with tappable command buttons. */
export function buildHelpCard(): Record<string, unknown> {
  const commands = [
    { cmd: "/mode", desc: "Switch agent mode" },
    { cmd: "/model", desc: "Switch AI model" },
    { cmd: "/approve", desc: "Toggle auto-approve" },
    { cmd: "/cancel", desc: "Cancel running prompt" },
    { cmd: "/sessions", desc: "List/load sessions" },
    { cmd: "/status", desc: "Show session state" },
    { cmd: "/help", desc: "Show this help" },
  ];
  return {
    ...baseCard(),
    body: [
      {
        type: "TextBlock",
        text: "🤖 Available Commands",
        size: "Medium",
        weight: "Bolder",
      },
      {
        type: "TextBlock",
        text: "Tap a command to execute, or type it with arguments.",
        isSubtle: true,
        wrap: true,
      },
    ],
    actions: commands.map((c) => ({
      type: "Action.Submit",
      title: `${c.cmd} — ${c.desc}`,
      data: { action: "command", command: c.cmd },
    })),
  };
}
