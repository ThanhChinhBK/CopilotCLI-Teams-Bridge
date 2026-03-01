import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  SessionMode,
  SessionModeState,
  SessionModelState,
  SessionInfo,
  ToolCallInfo,
  PlanInfo,
  ModelInfo,
} from "./types";

/** A generic JSON-RPC 2.0 message (request, response, or notification). */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

// ─── ACP Response Normalization ───
// The ACP spec uses `modeId`/`modelId` but Copilot CLI returns `id`.

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeMode(raw: any): SessionMode {
  return {
    modeId: raw.modeId ?? raw.id ?? "",
    name: raw.name ?? "",
    description: raw.description,
  };
}

function normalizeModes(raw: any): SessionModeState | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    currentModeId: raw.currentModeId ?? raw.currentMode ?? "",
    availableModes: Array.isArray(raw.availableModes)
      ? raw.availableModes.map(normalizeMode)
      : [],
  };
}

function normalizeModel(raw: any): ModelInfo {
  return {
    modelId: raw.modelId ?? raw.id ?? "",
    name: raw.name ?? "",
    description: raw.description,
  };
}

function normalizeModels(raw: any): SessionModelState | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    currentModelId: raw.currentModelId ?? raw.currentModel ?? null,
    availableModels: Array.isArray(raw.availableModels)
      ? raw.availableModels.map(normalizeModel)
      : [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Result returned from session/new and session/load. */
export interface SessionResult {
  sessionId: string;
  modes?: SessionModeState;
  models?: SessionModelState;
}

/**
 * Manages a `copilot --acp --stdio` child process and communicates
 * with it using the ACP protocol (JSON-RPC 2.0 over NDJSON).
 *
 * Lifecycle: start() → initialize() → prompt() … → stop()
 *
 * Events:
 *   log(msg)                      – diagnostic log line
 *   exit(code)                    – child process exited
 *   toolCall(info: ToolCallInfo)  – tool call update from agent
 *   plan(info: PlanInfo)          – plan update from agent
 *   modeChanged(modeId: string)   – agent changed its mode
 *   modelsChanged(models)         – available models updated
 *   permissionRequest({ id, toolName, toolInput, resolve })
 */
export class AcpClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();
  private sessionId: string | null = null;
  private responseChunks: string[] = [];
  /** Track tool call titles by toolCallId for enriching permission cards */
  private toolCallTitles = new Map<string, string>();

  constructor(private readonly cwd: string) {
    super();
  }

  /** Spawn the ACP child process. */
  start(): void {
    if (this.process) {
      return;
    }

    this.process = spawn("copilot", ["--acp", "--stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout.on("data", (chunk: Buffer) =>
      this.handleData(chunk.toString())
    );

    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emit("log", chunk.toString());
    });

    this.process.on("exit", (code) => {
      this.emit("exit", code);
      this.process = null;
      for (const [, p] of this.pending) {
        p.reject(new Error(`ACP process exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  /** Initialize the ACP connection and create a session. Returns session state. */
  async initialize(): Promise<SessionResult> {
    const initRes = await this.sendRpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        // Declare that we handle permission requests for all tool types,
        // including file edits — ask the server to send session/request_permission
        // for file operations, not just shell commands.
        permissions: true,
      },
    });
    if (initRes.error) {
      throw new Error(`ACP initialize failed: ${initRes.error.message}`);
    }

    const sessionRes = await this.sendRpc("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    });
    if (sessionRes.error) {
      throw new Error(`ACP session/new failed: ${sessionRes.error.message}`);
    }

    this.sessionId = sessionRes.result?.sessionId as string;
    if (!this.sessionId) {
      throw new Error("No sessionId returned from session/new");
    }

    return {
      sessionId: this.sessionId,
      modes: normalizeModes(sessionRes.result?.modes),
      models: normalizeModels(sessionRes.result?.models),
    };
  }

  /** Send a prompt and collect the streamed response text. */
  async prompt(text: string): Promise<string> {
    if (!this.process) {
      throw new Error("ACP process is not running");
    }
    if (!this.sessionId) {
      throw new Error("ACP session not initialized");
    }

    this.responseChunks = [];

    const res = await this.sendRpc("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });

    if (res.error) {
      throw new Error(res.error.message);
    }

    return this.responseChunks.join("") || "_(no response)_";
  }

  // ─── New ACP Protocol Methods ───

  /** Switch the session mode (plan, code, ask, architect, etc.). */
  async setMode(modeId: string): Promise<void> {
    this.requireSession();
    const res = await this.sendRpc("session/set_mode", {
      sessionId: this.sessionId!,
      modeId,
    });
    if (res.error) {
      throw new Error(res.error.message);
    }
  }

  /** Switch the model for the current session (unstable ACP feature). */
  async setModel(modelId: string): Promise<void> {
    this.requireSession();
    const res = await this.sendRpc("session/set_model", {
      sessionId: this.sessionId!,
      modelId,
    });
    if (res.error) {
      throw new Error(res.error.message);
    }
  }

  /** Cancel the currently running prompt. Sends a notification (no response). */
  cancel(): void {
    if (!this.process || !this.sessionId) {
      return;
    }
    this.sendNotification("session/cancel", {
      sessionId: this.sessionId,
    });
  }

  /** Load a previous session by ID. */
  async loadSession(sessionId: string): Promise<SessionResult> {
    if (!this.process) {
      throw new Error("ACP process is not running");
    }
    const res = await this.sendRpc("session/load", {
      sessionId,
      cwd: this.cwd,
      mcpServers: [],
    });
    if (res.error) {
      throw new Error(res.error.message);
    }
    this.sessionId = sessionId;
    return {
      sessionId,
      modes: normalizeModes(res.result?.modes),
      models: normalizeModels(res.result?.models),
    };
  }

  /** List available sessions. Returns empty array if agent doesn't support it. */
  async listSessions(): Promise<SessionInfo[]> {
    if (!this.process) {
      throw new Error("ACP process is not running");
    }
    try {
      const res = await this.sendRpc("session/list", {});
      if (res.error) {
        return [];
      }
      return (res.result?.sessions as SessionInfo[]) ?? [];
    } catch {
      return [];
    }
  }

  /** Gracefully stop the child process. */
  stop(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error("ACP client stopped"));
    }
    this.pending.clear();
    this.sessionId = null;
  }

  // ─── Internals ───

  private requireSession(): void {
    if (!this.process) {
      throw new Error("ACP process is not running");
    }
    if (!this.sessionId) {
      throw new Error("ACP session not initialized");
    }
  }

  private sendRpc(
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcMessage> {
    if (!this.process) {
      return Promise.reject(new Error("ACP process is not running"));
    }

    const id = this.nextId++;
    const request = { jsonrpc: "2.0" as const, id, method, params };

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin.write(JSON.stringify(request) + "\n");
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  private sendNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    if (!this.process) {
      return;
    }
    this.process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    );
  }

  /** Send a JSON-RPC response back to the server for server-initiated requests. */
  private respondToServer(id: number, result: Record<string, unknown>): void {
    if (!this.process) {
      return;
    }
    this.process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
    );
  }

  private handleData(raw: string): void {
    this.buffer += raw;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        this.handleMessage(msg);
      } catch {
        this.emit("log", `Unparseable ACP output: ${trimmed}`);
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests (has id + result/error, no method)
    if (msg.id != null && !msg.method && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!.resolve(msg);
      this.pending.delete(msg.id);
      return;
    }

    // Server → client: session/update notification (streamed chunks + rich updates)
    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg);
      if (msg.id != null) {
        this.respondToServer(msg.id, {});
      }
      return;
    }

    // Server → client: session/request_permission (interactive flow)
    if (msg.method === "session/request_permission") {
      this.handlePermissionRequest(msg);
      return;
    }

    this.emit(
      "log",
      `Unhandled ACP message: ${JSON.stringify(msg).slice(0, 200)}`
    );
  }

  /** Parse and dispatch session/update payloads. */
  private handleSessionUpdate(msg: JsonRpcMessage): void {
    const update = (msg.params as Record<string, unknown>)?.update as
      | Record<string, unknown>
      | undefined;
    if (!update) {
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type === "text") {
          this.responseChunks.push(content.text as string);
        }
        break;
      }
      case "agent_thought_chunk": {
        // Thinking text — silently ignore (not accumulated, not sent to user)
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const raw = (update.toolCall ?? update) as Record<string, unknown>;
        const toolCallId = raw.toolCallId as string | undefined;
        const title = raw.title as string | undefined;
        if (toolCallId && title) {
          this.toolCallTitles.set(toolCallId, title);
        }
        // Emit rich tool call info with all ACP fields
        const info: Record<string, unknown> = {
          toolCallId: raw.toolCallId,
          title: raw.title,
          name: raw.name ?? raw.title,
          kind: raw.kind,
          status: raw.status,
          rawInput: raw.rawInput,
          rawOutput: raw.rawOutput,
          content: raw.content,
          locations: raw.locations,
        };
        if (info.title || info.name) {
          this.emit("toolCall", info as unknown as ToolCallInfo);
        }
        break;
      }
      case "plan":
      case "plan_update": {
        const plan = (update.plan ?? update) as PlanInfo;
        this.emit("plan", plan);
        break;
      }
      case "current_mode": {
        const modeId = update.modeId as string | undefined;
        if (modeId) {
          this.emit("modeChanged", modeId);
        }
        break;
      }
      case "available_models": {
        const models = update.models as ModelInfo[] | undefined;
        if (models) {
          this.emit("modelsChanged", models);
        }
        break;
      }
      default:
        // Forward unknown update types for debugging
        this.emit(
          "log",
          `Unknown session update: ${update.sessionUpdate as string} → ${JSON.stringify(update).slice(0, 200)}`
        );
        break;
    }
  }

  /** Handle permission requests: emit event with resolve callback. */
  private handlePermissionRequest(msg: JsonRpcMessage): void {
    const params = msg.params as Record<string, unknown> | undefined;
    this.emit(
      "log",
      `Permission raw params: ${JSON.stringify(params).slice(0, 500)}`
    );

    if (msg.id == null) {
      this.emit("log", "Permission request without id — cannot respond");
      return;
    }

    // ACP spec: params = { sessionId, toolCall: { toolCallId, title?, ... }, options: [{ optionId, name, kind }] }
    const toolCallObj = (params?.toolCall ?? {}) as Record<string, unknown>;
    const toolCallId = (toolCallObj.toolCallId ?? "") as string;
    // Get title from the toolCall in the permission request, or look up from prior tool_call updates
    const title = (
      toolCallObj.title ?? toolCallObj.name ?? this.toolCallTitles.get(toolCallId) ?? ""
    ) as string;
    const kind = (toolCallObj.kind ?? "") as string;
    const rawInput = (toolCallObj.rawInput ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(params?.options) ? params.options : []) as Array<{
      optionId: string;
      name: string;
      kind: string;
    }>;

    const requestId = msg.id;
    const resolve = (optionId: string | null) => {
      if (optionId) {
        this.respondToServer(requestId, {
          outcome: { outcome: "selected", optionId },
        });
      } else {
        this.respondToServer(requestId, {
          outcome: { outcome: "cancelled" },
        });
      }
    };

    this.emit("permissionRequest", {
      id: requestId,
      toolCallId,
      title,
      kind,
      rawInput,
      options,
      resolve,
    });
  }
}
