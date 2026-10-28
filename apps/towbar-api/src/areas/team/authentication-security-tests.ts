import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { and, eq } from "drizzle-orm";
import * as schema from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import type { AuthDatabase } from "../../infrastructure/database.js";
import type { AuthenticatedUser } from "../../http/types.js";
import * as auth from "../auth/service.js";
import * as teams from "./service.js";
export async function assertAuthenticationSecurity({
  t,
  database,
  admin,
  password,
  updatedPassword,
  request,
  headersFor,
  origin,
}: {
  t: TestContext;
  database: AuthDatabase;
  admin: AuthenticatedUser;
  adminHeaders: Headers;
  password: string;
  updatedPassword: string;
  origin: string;
  request: (
    path: string,
    headers: Headers,
    body?: unknown,
    method?: string,
  ) => Response | Promise<Response>;
  headersFor: (response: Response) => Headers;
}) {
  await t.test(
    "password recovery is single-use and revokes existing sessions",
    async () => {
      const user = await teams.createTeamMember(admin, {
        name: "Recovery",
        email: "recover@example.test",
        password,
        role: "viewer",
      });
      const before = headersFor(
        await auth.authenticatePassword({
          email: "recover@example.test",
          password,
        }),
      );
      const response = await request(
        "/v1/public/auth/identity/request-password-reset",
        new Headers({ origin }),
        {
          email: "recover@example.test",
          redirectTo: `${origin}/reset-password`,
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const unknown = await request(
        "/v1/public/auth/identity/request-password-reset",
        new Headers({ origin }),
        {
          email: "unknown@example.test",
          redirectTo: `${origin}/reset-password`,
        },
      );
      assert.deepEqual(await unknown.json(), await response.json());
      const [mail] = await database
        .select()
        .from(schema.transactionalEmails)
        .where(
          and(
            eq(schema.transactionalEmails.recipient, "recover@example.test"),
            eq(schema.transactionalEmails.template, "password-reset"),
          ),
        );
      assert(mail?.encryptedData);
      const { decryptCredential, parseCredentialsMasterKey } =
        await import("@workspace/towbar-core");
      const data = decryptCredential<{ actionUrl: string }>({
        associatedData: `towbar:transactional-email:${mail.workspaceId}:${mail.id}`,
        masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
        envelope: mail.encryptedData,
      });
      const token = new URL(data.actionUrl).pathname.split("/").at(-1);
      const changed = await request(
        "/v1/public/auth/identity/reset-password",
        new Headers({ origin }),
        { token, newPassword: updatedPassword },
      );
      assert.equal(changed.status, 200, await changed.clone().text());
      assert.equal(await auth.findSession(before), null);
      assert.equal(
        (await auth.getUserIdentity(user.userId))!.mustChangePassword,
        false,
      );
      const replay = await request(
        "/v1/public/auth/identity/reset-password",
        new Headers({ origin }),
        { token, newPassword: password },
      );
      assert.equal(replay.ok, false);
      const after = headersFor(
        await auth.authenticatePassword({
          email: "recover@example.test",
          password: updatedPassword,
        }),
      );
      assert.equal((await auth.findSession(after))!.user.id, user.userId);
    },
  );
}
