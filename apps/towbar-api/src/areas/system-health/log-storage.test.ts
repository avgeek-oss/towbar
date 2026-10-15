import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { readLogStorageUsage } from "./database-storage.js";

void test("log storage distinguishes missing configuration, empty data, and denied metadata access", async (t) => {
  const previous = process.env.TOWBAR_LOGS_CONFIG_JSON;
  let responseStatus = 200;
  let responseBody = JSON.stringify({ bytes: "0" });
  const statements: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      statements.push(Buffer.concat(chunks).toString());
      const url = new URL(request.url!, "http://localhost");
      assert.equal(url.searchParams.get("param_database"), "towbar_logs_test");
      assert.equal(url.searchParams.get("readonly"), "1");
      response.writeHead(responseStatus);
      response.end(responseBody);
    })().catch((error: Error) => response.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (previous === undefined) delete process.env.TOWBAR_LOGS_CONFIG_JSON;
    else process.env.TOWBAR_LOGS_CONFIG_JSON = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  delete process.env.TOWBAR_LOGS_CONFIG_JSON;
  assert.deepEqual(await readLogStorageUsage(), {
    logsBytes: null,
    logsError: null,
  });
  process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify({
    clickhouse: {
      endpoint: `http://127.0.0.1:${address.port}`,
      database: "towbar_logs_test",
      username: "logs_test",
      password: "logs_test",
    },
  });
  assert.deepEqual(await readLogStorageUsage(), {
    logsBytes: 0,
    logsError: null,
  });
  assert.match(
    statements[0]!,
    /WHERE active AND database = \{database:String\} AND table = 'log_records'/,
  );
  responseBody = JSON.stringify({ bytes: "1048576" });
  assert.deepEqual(await readLogStorageUsage(), {
    logsBytes: 1048576,
    logsError: null,
  });
  responseStatus = 403;
  responseBody = "Code: 497. ACCESS_DENIED with private server detail";
  const denied = await readLogStorageUsage();
  assert.equal(denied.logsBytes, null);
  assert.match(denied.logsError!, /SELECT access to system.parts/);
  assert.doesNotMatch(denied.logsError!, /private server detail/);
  responseStatus = 200;
  responseBody = JSON.stringify({ bytes: "-1" });
  assert.deepEqual(await readLogStorageUsage(), {
    logsBytes: null,
    logsError: "ClickHouse returned an invalid log storage size.",
  });
});
