import type {
  SessionMode,
  ModelInfo,
  SessionModeState,
  SessionModelState,
  PermissionRequest,
} from "./types";

/**
 * Tracks per-conversation ACP session state: current mode, model,
 * available options, and any pending permission request.
 */
export class ConversationState {
  sessionId: string | null = null;
  currentModeId: string | null = null;
  availableModes: SessionMode[] = [];
  currentModelId: string | null = null;
  availableModels: ModelInfo[] = [];
  pendingPermission: PermissionRequest | null = null;
  /** When true, auto-approve all permission requests */
  autoApprove = false;

  /** Populate from the session/new (or session/load) response. */
  initFromSession(
    sessionId: string,
    modes?: SessionModeState,
    models?: SessionModelState
  ): void {
    this.sessionId = sessionId;
    if (modes) {
      this.currentModeId = modes.currentModeId;
      this.availableModes = modes.availableModes;
    }
    if (models) {
      this.currentModelId = models.currentModelId;
      this.availableModels = models.availableModels;
    }
  }

  /** Update mode after a successful set_mode or a CurrentModeUpdate notification. */
  setMode(modeId: string): void {
    this.currentModeId = modeId;
  }

  /** Update model after a successful set_model or model update notification. */
  setModel(modelId: string): void {
    this.currentModelId = modelId;
  }

  /** Replace the available models list (e.g. from AvailableModelsUpdate). */
  setAvailableModels(models: ModelInfo[]): void {
    this.availableModels = models;
  }

  /** Format a concise status string. */
  formatStatus(): string {
    const short = (id: string) => {
      const hash = id.lastIndexOf("#");
      return hash >= 0 ? id.substring(hash + 1) : id;
    };
    const parts: string[] = [];
    parts.push(`**Session:** ${this.sessionId ?? "_(none)_"}`);
    parts.push(
      `**Mode:** ${this.currentModeId ? short(this.currentModeId) : "default"} (${this.availableModes.map((m) => short(m.modeId)).join(", ") || "none advertised"})`
    );
    parts.push(
      `**Model:** ${this.currentModelId ? short(this.currentModelId) : "default"} (${this.availableModels.map((m) => short(m.modelId)).join(", ") || "none advertised"})`
    );
    parts.push(`**Auto-approve:** ${this.autoApprove ? "✅ ON" : "❌ OFF"}`);
    return parts.join("\n");
  }
}
