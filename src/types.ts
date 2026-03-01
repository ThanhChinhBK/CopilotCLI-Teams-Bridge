/** Shared type definitions for the CopilotCLI-Teams Bridge. */

/** JSON-RPC 2.0 request sent to the ACP stdio process. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** JSON-RPC 2.0 response from the ACP stdio process. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal representation of an incoming Teams message for internal routing. */
export interface BridgeMessage {
  text: string;
  conversationId: string;
  /** Data from Adaptive Card Action.Submit buttons (when present, text may be empty). */
  value?: CardActionData;
}

// ─── Command System ───

/** A parsed slash command from a Teams message. */
export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

// ─── ACP Session State ───

/** ACP session mode descriptor. */
export interface SessionMode {
  /** Mode ID — may be a full URL (e.g. https://...#plan) or a short string. */
  modeId: string;
  name: string;
  description?: string;
}

/** ACP model descriptor. */
export interface ModelInfo {
  /** Model ID — may be a full URL or a short string. */
  modelId: string;
  name: string;
  description?: string;
}

/** State for mode selection within a session. */
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

/** State for model selection within a session (unstable in ACP spec). */
export interface SessionModelState {
  currentModelId: string | null;
  availableModels: ModelInfo[];
}

/** Session info returned by session/list. */
export interface SessionInfo {
  sessionId: string;
  title?: string;
  createdAt?: string;
}

// ─── ACP Update Types ───

/** Discriminated union of session/update payloads. */
export type SessionUpdateType =
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "tool_call"; toolCall: ToolCallInfo }
  | { sessionUpdate: "tool_call_update"; toolCall: ToolCallInfo }
  | { sessionUpdate: "plan"; plan: PlanInfo }
  | { sessionUpdate: "plan_update"; plan: PlanInfo }
  | { sessionUpdate: "current_mode"; modeId: string }
  | { sessionUpdate: "available_models"; models: ModelInfo[] };

/** Tool call information from session/update. */
export interface ToolCallInfo {
  toolCallId?: string;
  /** Human-readable title (e.g. "Reading configuration file") */
  title?: string;
  /** Legacy field — some versions use name instead of title */
  name?: string;
  /** Tool kind: read, edit, delete, execute, search, think, fetch, other */
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  /** Raw input parameters sent to the tool */
  rawInput?: Record<string, unknown>;
  /** Raw output returned by the tool */
  rawOutput?: Record<string, unknown>;
  /** Content produced by the tool call */
  content?: Array<Record<string, unknown>>;
  /** File locations affected by this tool call */
  locations?: Array<{ path: string; line?: number }>;
  /** Legacy fields */
  id?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

/** Plan information from session/update. */
export interface PlanInfo {
  content?: string;
  steps?: Array<{ description: string; status?: string }>;
}

// ─── Permission Request ───

/** Pending permission request from the ACP agent. */
export interface PermissionRequest {
  id: number;
  /** Reference to the tool call needing permission */
  toolCallId: string;
  /** Title of the tool call (e.g. "Create file", "Run command") */
  title: string;
  /** Tool kind (e.g. "edit", "execute", "read") */
  kind: string;
  /** Raw input from the tool call (e.g. { fileName, diff }) */
  rawInput: Record<string, unknown>;
  /** Available permission options from ACP */
  options: PermissionOption[];
  resolve: (optionId: string | null) => void;
}

/** ACP permission option */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

// ─── Adaptive Card Types ───

/** Result from a command or message handler — can be text, a card, or both. */
export interface MessageReply {
  text?: string;
  /** Adaptive Card JSON payload (will be wrapped with CardFactory.adaptiveCard). */
  card?: Record<string, unknown>;
}

/** Data sent by Adaptive Card Action.Submit buttons. */
export interface CardActionData {
  action: "set_mode" | "set_model" | "permission" | "command";
  modeId?: string;
  modelId?: string;
  /** Selected permission optionId from ACP options */
  optionId?: string;
  command?: string;
}
