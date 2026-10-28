import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { once } from "node:events";

export type ModelReply =
  string | { name: string; input: Record<string, unknown>; id?: string };

export async function assistantProviderFixture() {
  const replies: ModelReply[] = [];
  const requests: Record<string, unknown>[] = [];
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(
      JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    );
    const reply = replies.shift() ?? "The requested check is complete.";
    const tool = typeof reply !== "string";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type: string, data: Record<string, unknown>) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    event("message_start", {
      message: {
        id: "fixture-message",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    event("content_block_start", {
      index: 0,
      content_block: tool
        ? {
            type: "tool_use",
            id: reply.id ?? "fixture-call",
            name: reply.name,
            input: {},
          }
        : { type: "text", text: "" },
    });
    event("content_block_delta", {
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify(reply.input),
          }
        : { type: "text_delta", text: reply },
    });
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: {
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    });
    event("message_stop", {});
    response.end();
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    reply(...values: ModelReply[]) {
      replies.push(...values);
    },
    reset() {
      replies.length = 0;
      requests.length = 0;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
