import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { toPublicServer } from "../servers/public-server.js";

type ServerResponse = {
  server: { config: ReturnType<typeof toPublicServer>["config"] };
};
type Identity = { capabilities: string[] };

export function resultData<T>(
  result: Awaited<ReturnType<Client["callTool"]>>,
): T {
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const content = result.content as Array<{ type: string; text?: string }>;
  const envelope = JSON.parse(
    content.find((item) => item.type === "text")!.text!,
  ) as { result: T };
  return envelope.result;
}

export async function assertServerConfigReadback({
  request,
  connect,
  read,
  write,
  mcpRead,
  ownedServerId,
  foreignServerId,
}: {
  request: (
    path: string,
    token?: string,
    method?: string,
    body?: unknown,
  ) => Promise<Response>;
  connect: (token: string) => Promise<Client>;
  read: { token: string };
  write: { token: string };
  mcpRead: { token: string };
  ownedServerId: string;
  foreignServerId: string;
}) {
  const client = await connect(mcpRead.token);
  const path = `/servers/${ownedServerId}`;
  try {
    const initial = (await (
      await request(path, write.token)
    ).json()) as ServerResponse;
    assert.equal(initial.server.config.hostLogCollection, false);
    const identity = (await (
      await request("/identity", write.token)
    ).json()) as Identity;
    assert(identity.capabilities.includes("admin"));
    const mcpIdentity = resultData<{ identity: Identity }>(
      await client.callTool({
        name: "towbar_workspace_inspect",
        arguments: {},
      }),
    );
    assert(!mcpIdentity.identity.capabilities.includes("admin"));
    const tools = await client.listTools();
    assert(!tools.tools.some(({ name }) => name === "towbar_server_configure"));
    for (const hostLogCollection of [true, false, true]) {
      const response = await request(path, write.token, "PATCH", {
        ...initial.server.config,
        hostLogCollection,
      });
      assert.equal(response.status, 200, await response.clone().text());
      const saved = (await response.json()) as ServerResponse;
      assert.equal(saved.server.config.hostLogCollection, hostLogCollection);
      const loaded = (await (
        await request(path, read.token)
      ).json()) as ServerResponse;
      assert.deepEqual(loaded.server.config, saved.server.config);
      const list = (await (await request("/servers", read.token)).json()) as {
        servers: Array<ServerResponse["server"] & { id: string }>;
      };
      assert.equal(
        list.servers.find(({ id }) => id === ownedServerId)!.config
          .hostLogCollection,
        hostLogCollection,
      );
      const inspected = resultData<{ server: ServerResponse }>(
        await client.callTool({
          name: "towbar_server_inspect",
          arguments: { serverId: ownedServerId },
        }),
      );
      assert.equal(
        inspected.server.server.config.hostLogCollection,
        hostLogCollection,
      );
    }
    assert.equal(
      (
        await request(path, read.token, "PATCH", {
          ...initial.server.config,
          hostLogCollection: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/servers/${foreignServerId}`,
          write.token,
          "PATCH",
          initial.server.config,
        )
      ).status,
      404,
    );
  } finally {
    await client.close();
  }
}
