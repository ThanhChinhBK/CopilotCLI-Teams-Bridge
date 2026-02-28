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
}
