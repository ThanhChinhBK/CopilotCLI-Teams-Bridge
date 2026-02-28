import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
  TurnContext,
  ActivityTypes,
  Request as BotRequest,
  Response as BotResponse,
} from "botbuilder";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import type { BridgeMessage } from "./types";

export type MessageHandler = (msg: BridgeMessage) => Promise<string>;

/** Wrap Node.js IncomingMessage to satisfy the botbuilder Request interface. */
function wrapRequest(req: IncomingMessage, body: Record<string, unknown>): BotRequest {
  return {
    body,
    headers: req.headers as Record<string, string | string[] | undefined>,
    method: req.method,
  };
}

/** Wrap Node.js ServerResponse to satisfy the botbuilder Response interface. */
function wrapResponse(res: ServerResponse): BotResponse {
  return {
    socket: res.socket,
    end(...args: unknown[]) {
      (res.end as (...a: unknown[]) => unknown)(...args);
    },
    header(name: string, value: unknown) {
      res.setHeader(name, value as string);
    },
    send(bodyOrStatus?: unknown) {
      if (typeof bodyOrStatus === "string") {
        res.end(bodyOrStatus);
      } else {
        res.end(JSON.stringify(bodyOrStatus));
      }
    },
    status(code: number) {
      res.statusCode = code;
      return this;
    },
  };
}

/**
 * Runs an HTTP server that receives Bot Framework webhook POSTs and
 * forwards incoming messages to the provided handler.
 */
export class BotServer {
  private server: Server | null = null;
  private adapter: CloudAdapter;

  constructor(
    appId: string,
    appPassword: string,
    private readonly onMessage: MessageHandler
  ) {
    const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
      MicrosoftAppId: appId,
      MicrosoftAppPassword: appPassword,
      MicrosoftAppType: "SingleTenant",
    };
    const botAuth = new ConfigurationBotFrameworkAuthentication(authConfig);
    this.adapter = new CloudAdapter(botAuth);

    this.adapter.onTurnError = async (context, error) => {
      console.error("[BotServer] Turn error:", error);
      await context.sendActivity("Sorry, something went wrong.");
    };
  }

  /** Start the HTTP server on the given port. */
  start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/api/messages") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            const wrappedReq = wrapRequest(req, body);
            const wrappedRes = wrapResponse(res);

            void this.adapter.process(wrappedReq, wrappedRes, async (context: TurnContext) => {
              if (
                context.activity.type === ActivityTypes.Message &&
                context.activity.text
              ) {
                const reply = await this.onMessage({
                  text: context.activity.text,
                  conversationId: context.activity.conversation.id,
                });
                await context.sendActivity(reply);
              }
            });
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(port, () => resolve());
    });
  }

  /** Stop the HTTP server. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = null;
    });
  }
}
