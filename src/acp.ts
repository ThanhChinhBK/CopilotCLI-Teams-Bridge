import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";

/**
 * Manages a `copilot --acp --stdio` child process and communicates
 * with it over JSON-RPC 2.0 on stdin/stdout.
 */
export class AcpClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();

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

  /** Send a prompt and wait for the JSON-RPC response. */
  async send(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (!this.process) {
      throw new Error("ACP process is not running");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin.write(JSON.stringify(request) + "\n");
    });
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
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!.resolve(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        this.emit("log", `Unparseable ACP output: ${trimmed}`);
      }
    }
  }
}
