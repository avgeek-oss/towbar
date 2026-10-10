import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createFixtureApiServer, fixtureIds } from "./fixture-api.ts";
import {
  dualFactorFixtureCredential,
  dualFactorFixturePrivateKey,
} from "./dual-factor-fixture.ts";

const fixtureEmail = (role) =>
  role === "admin" ? "praveen@avgeek.ltd" : `${role}@example.com`;

async function fixture(options, run) {
  const server = createFixtureApiServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", body) =>
    fetch(`${origin}/v1/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    await run(request);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
for (const role of ["admin", "member", "viewer"]) {
  test(`${role} date preferences persist independently and localize JSON and deployment events`, async () =>
    fixture({ role }, async (request) => {
      const preferences = {
        dateFormat: "year-month-day",
        timeFormat: "12-hour-seconds",
        timeZone: "Asia/Kolkata",
      };
      const endpoint = "core/profile/preferences";
      assert.equal((await request(endpoint, "PUT", preferences)).status, 200);
      assert.deepEqual(
        (await (await request(endpoint)).json()).preferences,
        preferences,
      );
      assert.equal(
        (
          await request(endpoint, "PUT", {
            ...preferences,
            timeZone: "Invalid/Zone",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(endpoint, "PUT", {
            ...preferences,
            userId: "someone-else",
          })
        ).status,
        400,
      );
      const timestamp = "2026-09-16T23:30:45.000Z";
      const localized = await (
        await request("core/date-time/localize", "POST", {
          timestamps: [timestamp],
        })
      ).json();
      assert.equal(
        localized.localization.timestamps[timestamp].dateTime,
        "5:00:45 AM, 2026-09-17",
      );
      const incidents = await (
        await request("core/monitoring/incidents")
      ).json();
      assert.equal(incidents.localization.timeZone, preferences.timeZone);
      assert.ok(Object.keys(incidents.localization.timestamps).length > 0);
      const events = await request(
        `core/deployments/${fixtureIds.deployment}/events`,
      );
      assert.match(events.headers.get("content-type"), /text\/event-stream/);
      const reader = events.body.getReader();
      try {
        const chunk = new TextDecoder().decode((await reader.read()).value);
        const event = JSON.parse(
          chunk
            .split("\n")
            .find((line) => line.startsWith("data: "))
            .slice(6),
        );
        assert.equal(event.localization.timeZone, preferences.timeZone);
        assert.ok(
          event.localization.timestamps[event.deployment.createdAt].dateTime,
        );
        assert.ok(event.localization.timestamps[event.logs[0].createdAt].time);
      } finally {
        await reader.cancel();
      }
      assert.equal((await request("core/session", "DELETE")).status, 204);
      assert.equal((await request(endpoint)).status, 401);
      const differentRole = role === "admin" ? "member" : "admin";
      assert.equal(
        (
          await request("public/auth/login-email", "POST", {
            email: fixtureEmail(differentRole),
            password: "Towbar fixture passphrase 2026",
          })
        ).status,
        200,
      );
      assert.equal(
        (await (await request(endpoint)).json()).preferences.timeZone,
        "UTC",
      );
      await request("core/session", "DELETE");
      await request("public/auth/login-email", "POST", {
        email: fixtureEmail(role),
        password: "Towbar fixture passphrase 2026",
      });
      assert.deepEqual(
        (await (await request(endpoint)).json()).preferences,
        preferences,
      );
    }));
}
test("passkey fixture supports direct sign-in and mandatory verification after passwords", async () =>
  fixture({ authState: "signed-out" }, async (request) => {
    const endpoint = "public/auth/identity/passkey";
    const login = (password = "Towbar fixture passphrase 2026") =>
      request("public/auth/login-email", "POST", {
        email: "2fa-both@example.com",
        password,
      });
    const assertion = (challenge, verified = true) => {
      const hash = (value) => createHash("sha256").update(value).digest();
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin: "http://localhost:4021",
        }),
      );
      const authenticatorData = Buffer.concat([
        hash("localhost"),
        Buffer.from([verified ? 0x05 : 0x01, 0, 0, 0, 1]),
      ]);
      return {
        id: dualFactorFixtureCredential.id,
        rawId: dualFactorFixtureCredential.id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([authenticatorData, hash(clientDataJSON)]),
            createPrivateKey({
              key: Buffer.from(dualFactorFixturePrivateKey, "base64"),
              format: "der",
              type: "pkcs8",
            }),
          ).toString("base64url"),
        },
      };
    };
    assert.equal((await login("incorrect password")).ok, false);
    assert.equal(
      (await request(`${endpoint}/generate-authenticate-options`)).ok,
      true,
    );
    const result = await (await login()).json();
    assert.equal(result.user, null);
    assert.equal(result.twoFactorRequired, true);
    assert.deepEqual(result.twoFactorMethods, ["passkey"]);
    assert.equal((await request("core/session")).status, 401);
    let options = await (
      await request(`${endpoint}/generate-authenticate-options`)
    ).json();
    assert.equal(options.userVerification, "required");
    assert.deepEqual(
      options.allowCredentials.map(({ id }) => id),
      [dualFactorFixtureCredential.id],
    );
    assert.equal(
      (
        await request(`${endpoint}/verify-authentication`, "POST", {
          response: assertion(options.challenge, false),
        })
      ).ok,
      false,
    );
    options = await (
      await request(`${endpoint}/generate-authenticate-options`)
    ).json();
    const response = assertion(options.challenge);
    assert.equal(
      (await request(`${endpoint}/verify-authentication`, "POST", { response }))
        .status,
      200,
    );
    assert.equal(
      (await (await request("core/session")).json()).user.email,
      "2fa-both@example.com",
    );
    assert.equal(
      (await request(`${endpoint}/verify-authentication`, "POST", { response }))
        .ok,
      false,
    );
    await request("core/session", "DELETE");
    await login();
    options = await (
      await request(`${endpoint}/generate-authenticate-options`)
    ).json();
    assert.equal(
      (
        await request(`${endpoint}/verify-recovery-code`, "POST", {
          code: "fixture-recovery-one",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`${endpoint}/verify-authentication`, "POST", {
          response: assertion(options.challenge),
        })
      ).ok,
      false,
    );
  }));
test("passkey registration labels use the signed-in account email without exposing it as the user handle", async () => {
  for (const role of ["admin", "member", "viewer"]) {
    await fixture({ role }, async (request) => {
      const { user } = await (await request("core/session")).json();
      const response = await request(
        `public/auth/identity/passkey/generate-register-options?name=${encodeURIComponent(user.email)}`,
      );
      assert.equal(response.status, 200);
      const options = await response.json();
      assert.equal(options.user.name, user.email);
      assert.equal(options.user.displayName, user.name);
      const handle = Buffer.from(options.user.id, "base64url");
      assert.ok(handle.length > 0 && handle.length <= 64);
      assert.notEqual(handle.toString(), user.email);
      assert.equal(options.authenticatorSelection.userVerification, "required");
      assert.equal(options.authenticatorSelection.residentKey, "required");
    });
  }
});
for (const role of ["admin", "member", "viewer"]) {
  test(`${role} can request email verification with a one-minute cooldown`, async () =>
    fixture({ role, emailVerified: false }, async (request) => {
      const endpoint = "public/auth/identity/send-verification-email";
      const email = fixtureEmail(role);
      assert.equal((await request(endpoint, "POST", { email })).status, 200);
      assert.equal((await request(endpoint, "POST", { email })).status, 429);
      const { user } = await (await request("core/session")).json();
      assert.equal(user.emailVerified, false);
      assert.equal(
        (await request(endpoint, "POST", { email: "someone-else@example.com" }))
          .status,
        400,
      );
    }));
  test(`${role} fixtures support permitted navigation and deny administrative queries`, async () =>
    fixture({ role }, async (request) => {
      const session = await (await request("core/session")).json();
      assert.equal(session.user.workspaceRole, role);
      for (const path of [
        "apps",
        "resources",
        "servers",
        "sources",
        `servers/${fixtureIds.server}`,
        `apps/${fixtureIds.app}`,
        "settings/api-keys/personal",
      ])
        assert.equal((await request(`core/${path}`)).status, 200, path);
      for (const path of [
        "team/members",
        "settings/private-keys",
        "settings/api-keys/team",
        "github",
        "notifications/providers",
        `servers/${fixtureIds.server}/credentials`,
      ])
        assert.equal(
          (await request(`core/${path}`)).status,
          role === "admin" ? 200 : 403,
          path,
        );
      const key = await request("core/settings/api-keys/personal", "POST", {
        name: "Viewer tool",
        access: "read",
        includeAdmin: false,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
      assert.equal(key.status, 201);
      assert.equal((await key.json()).key.access, "read");
      assert.equal(
        (
          await request("core/settings/api-keys/personal", "POST", {
            name: "Write tool",
            access: "edit",
            includeAdmin: false,
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          })
        ).status,
        role === "viewer" ? 403 : 201,
      );
    }));
}
test("requesting an email change keeps the current address and verification status", async () =>
  fixture({}, async (request) => {
    const before = (await (await request("core/session")).json()).user;
    assert.equal(
      (
        await request("core/profile/email-change", "POST", {
          email: "pending@example.com",
        })
      ).status,
      200,
    );
    const after = (await (await request("core/session")).json()).user;
    assert.equal(after.email, before.email);
    assert.equal(after.emailVerified, before.emailVerified);
    const { pending } = await (
      await request("core/profile/email-change")
    ).json();
    assert.equal(pending.email, "pending@example.com");
  }));
test("new-instance and temporary-password fixtures reach the dashboard after setup", async () => {
  await fixture({ authState: "new-instance" }, async (request) => {
    assert.equal(
      (await (await request("public/auth/setup-status")).json()).setupRequired,
      true,
    );
    assert.equal((await request("core/apps")).status, 401);
    assert.equal(
      (
        await request("public/auth/setup", "POST", {
          setupSecret: "fixture-installation-secret",
          teamName: "Fresh team",
          displayName: "Admin",
          email: "new@example.test",
          password: "A long fixture password",
          confirmPassword: "A long fixture password",
        })
      ).status,
      201,
    );
    assert.equal((await request("core/apps")).status, 200);
  });
  await fixture(
    { role: "member", authState: "temporary-password" },
    async (request) => {
      assert.equal((await request("core/apps")).status, 403);
      assert.equal(
        (
          await request("core/profile/password", "PUT", {
            currentPassword: "Towbar fixture passphrase 2026",
            newPassword: "A different fixture passphrase",
            confirmPassword: "A different fixture passphrase",
          })
        ).status,
        204,
      );
      assert.equal((await request("core/apps")).status, 200);
    },
  );
});
test("invitations include every role and show unavailable SMTP", async () =>
  fixture({ smtpAvailable: false }, async (request) => {
    const { invitations } = await (
      await request("core/team/invitations")
    ).json();
    assert.deepEqual(
      invitations.map((invite) => invite.role),
      ["admin", "member", "viewer"],
    );
    assert(
      invitations.every((invite) => invite.errorCode === "SMTP_NOT_CONFIGURED"),
    );
    assert.equal(
      (
        await request(
          `public/auth/invitations/${invitations[0].id}/verify`,
          "POST",
          {},
        )
      ).status,
      409,
    );
  }));

test("public verification preview acknowledges known and unknown addresses without creating a session", async () => {
  await fixture({ authState: "signed-out" }, async (request) => {
    const endpoint = "public/auth/request-verification-email";
    let acknowledgment;
    for (const email of [fixtureEmail("admin"), "unknown@example.test"]) {
      const accepted = await request(endpoint, "POST", { email });
      assert.equal(accepted.status, 200);
      const result = await accepted.json();
      assert.equal(result.status, true);
      if (acknowledgment) assert.deepEqual(result, acknowledgment);
      acknowledgment = result;
      assert.equal((await request(endpoint, "POST", { email })).status, 429);
    }
    assert.equal(
      (await request(endpoint, "POST", { email: "invalid" })).status,
      400,
    );
    assert.equal(
      (
        await request(endpoint, "POST", {
          email: "other@example.test",
          callbackURL: "https://attacker.example",
        })
      ).status,
      400,
    );
    assert.equal((await request("core/session")).status, 401);
  });
});
