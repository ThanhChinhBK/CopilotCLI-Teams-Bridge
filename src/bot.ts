import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
  TurnContext,
  ActivityTypes,
  CardFactory,
  ConversationReference,
  Request as BotRequest,
  Response as BotResponse,
} from "botbuilder";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import type { BridgeMessage, MessageReply, CardActionData } from "./types";

/**
 * Handler receives the message and a callback for sending extra replies
 * (e.g. permission prompts) beyond the initial response.
 */
export type MessageHandler = (
  msg: BridgeMessage,
  sendExtra: (reply: MessageReply) => Promise<void>
) => Promise<MessageReply>;

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
  private appId: string;
  private lastConversationRef: Partial<ConversationReference> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    appId: string,
    appPassword: string,
    appTenantId: string,
    private readonly onMessage: MessageHandler,
    private readonly onLog?: (msg: string) => void
  ) {
    this.appId = appId;
    const authConfig: ConfigurationBotFrameworkAuthenticationOptions =
      appId && appPassword
        ? {
            MicrosoftAppId: appId,
            MicrosoftAppPassword: appPassword,
            MicrosoftAppType: appTenantId ? "SingleTenant" : "MultiTenant",
            ...(appTenantId ? { MicrosoftAppTenantId: appTenantId } : {}),
          }
        : {};
    const botAuth = new ConfigurationBotFrameworkAuthentication(authConfig);
    this.adapter = new CloudAdapter(botAuth);

    this.adapter.onTurnError = async (context, error) => {
      this.log(`Turn error: ${error}`);
      try {
        await context.sendActivity("Sorry, something went wrong.");
      } catch (sendErr) {
        this.log(`Failed to send error reply: ${sendErr}`);
      }
    };
  }

  private log(msg: string): void {
    this.onLog?.(`[Bot] ${msg}`);
  }

  /** Send a MessageReply (card or text) via the turn context. */
  private async sendReply(
    context: TurnContext,
    reply: MessageReply
  ): Promise<void> {
    if (reply.card) {
      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(reply.card)],
      });
    } else if (reply.text) {
      await context.sendActivity(reply.text);
    }
  }

  /** Send a proactive message to the last known conversation. */
  async sendProactive(reply: MessageReply): Promise<void> {
    if (!this.lastConversationRef) {
      this.log("No conversation reference for proactive message");
      return;
    }
    try {
      await this.adapter.continueConversationAsync(
        this.appId,
        this.lastConversationRef,
        async (context) => {
          await this.sendReply(context, reply);
        }
      );
      this.log("Proactive message sent.");
    } catch (err) {
      this.log(`Proactive message error: ${err}`);
    }
  }

  /** Start sending typing indicators every 3 seconds until stopTyping() is called. */
  startTyping(): void {
    this.stopTyping();
    const sendOne = () => {
      if (!this.lastConversationRef) {
        return;
      }
      this.adapter
        .continueConversationAsync(
          this.appId,
          this.lastConversationRef,
          async (context) => {
            await context.sendActivities([{ type: ActivityTypes.Typing }]);
          }
        )
        .catch(() => {
          /* ignore typing errors */
        });
    };
    sendOne();
    this.typingTimer = setInterval(sendOne, 3000);
  }

  /** Stop the repeating typing indicator. */
  stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  /** Start the HTTP server on the given port. */
  start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.log(`HTTP ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
        if (req.method === "POST" && req.url === "/api/messages") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            this.log(`Activity type: ${body.type}, text: ${((body.text as string) ?? "").slice(0, 80)}`);
            const wrappedReq = wrapRequest(req, body);
            const wrappedRes = wrapResponse(res);

            this.adapter
              .process(wrappedReq, wrappedRes, async (context: TurnContext) => {
                if (context.activity.type !== ActivityTypes.Message) {
                  return;
                }

                // Save conversation reference for proactive messaging
                this.lastConversationRef =
                  TurnContext.getConversationReference(context.activity);

                const text = context.activity.text ?? "";
                const value = context.activity.value as
                  | CardActionData
                  | undefined;

                if (!text && !value) {
                  return;
                }

                // Send typing indicator so user knows we're working
                await context.sendActivities([
                  { type: ActivityTypes.Typing },
                ]);

                const sendExtra = async (reply: MessageReply) => {
                  try {
                    await this.sendReply(context, reply);
                  } catch (err) {
                    this.log(`sendExtra error: ${err}`);
                  }
                };

                const reply = await this.onMessage(
                  {
                    text,
                    conversationId: context.activity.conversation.id,
                    value,
                  },
                  sendExtra
                );

                this.log(
                  `Sending reply: ${reply.card ? "card" : (reply.text ?? "").slice(0, 80)}…`
                );
                await this.sendReply(context, reply);
                this.log("Reply sent.");
              })
              .catch((err: unknown) => {
                this.log(`adapter.process error: ${err}`);
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
    this.stopTyping();
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
