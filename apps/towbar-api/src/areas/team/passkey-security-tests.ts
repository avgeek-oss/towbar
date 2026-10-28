import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import * as schema from "@workspace/towbar-database/schema";
import { testAuthenticator } from "./webauthn-test-authenticator.js";
import type { settingsTestClient } from "./settings-test-client.js";
import type { getTowbarDatabase } from "../../infrastructure/database.js";

export async function verifyPasskeySecurity({
  database,
  auth,
  adminHeaders,
  memberHeaders,
  publicHeaders,
  adminId,
  origin,
  password,
  client,
}: {
  database: ReturnType<typeof getTowbarDatabase>;
  auth: typeof import("../auth/service.js");
  adminHeaders: Headers;
  memberHeaders: Headers;
  publicHeaders: Headers;
  adminId: string;
  origin: string;
  password: string;
  client: ReturnType<typeof settingsTestClient>;
}) {
  const { cookies, request, ok, passkeyOptions } = client;
  const endpoint = "/v1/public/auth/identity/passkey";
  const authenticator = testAuthenticator();
  const options = passkeyOptions(endpoint, adminHeaders);
  const current = (await auth.findSession(adminHeaders))!;
  await database
    .update(schema.sessions)
    .set({ authenticatedAt: new Date(Date.now() - 700000) })
    .where(eq(schema.sessions.id, current.sessionId));
  assert.equal(
    (await request(endpoint + "/generate-register-options", adminHeaders))
      .status,
    403,
  );
  await ok(
    await request("/v1/core/session/reauthenticate", adminHeaders, {
      password,
    }),
  );
  for (const [verified, testOrigin] of [
    [false, origin],
    [true, "https://wrong-origin.test"],
  ] as const) {
    const registration = await options("/generate-register-options");
    assert.equal(
      (
        await request(endpoint + "/verify-registration", registration.headers, {
          name: "Test key",
          response: authenticator.registration(
            registration.data.challenge,
            testOrigin,
            verified,
          ),
        })
      ).ok,
      false,
    );
  }
  const registration = await options("/generate-register-options");
  const payload = {
    name: "Test key",
    response: authenticator.registration(registration.data.challenge, origin),
  };
  const registered = await ok(
    await request(
      endpoint + "/verify-registration",
      registration.headers,
      payload,
    ),
  );
  const firstCodes = ((await registered.json()) as { recoveryCodes: string[] })
    .recoveryCodes;
  assert.equal(firstCodes.length, 10);
  const [stored] = await database
    .select()
    .from(schema.authRecoveryCodes)
    .where(eq(schema.authRecoveryCodes.userId, adminId));
  assert(stored);
  assert(!JSON.stringify(stored).includes(firstCodes[0]!));
  assert.equal(
    (await auth.findSession(adminHeaders))!.user.twoFactorEnabled,
    true,
  );
  assert.equal(
    (
      await request(
        endpoint + "/verify-registration",
        registration.headers,
        payload,
      )
    ).ok,
    false,
  );
  const keys = (await (
    await ok(await request(endpoint + "/list-user-passkeys", adminHeaders))
  ).json()) as Array<{ id: string }>;
  assert.equal(keys.length, 1);
  assert.equal(
    (
      await request(endpoint + "/delete-passkey", memberHeaders, {
        id: keys[0]!.id,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await request("/v1/core/session/reauthenticate", adminHeaders, {
        password,
      })
    ).status,
    401,
  );
  const passwordChallenge = async () => {
    const response = await ok(
      await request("/v1/public/auth/login-email", publicHeaders, {
        email: "admin@settings.test",
        password,
      }),
    );
    assert.deepEqual(await response.clone().json(), {
      twoFactorRequired: true,
      twoFactorMethods: ["passkey"],
      user: null,
    });
    const headers = cookies(response);
    assert.equal(await auth.findSession(headers), null);
    return headers;
  };
  // Passwordless authentication verifies origin, user presence/verification and replay protection.
  let challenge = await options(
    "/generate-authenticate-options",
    publicHeaders,
  );
  assert.equal(
    (
      await request(endpoint + "/verify-authentication", challenge.headers, {
        response: authenticator.authentication(
          challenge.data.challenge,
          origin,
          1,
          false,
        ),
      })
    ).ok,
    false,
  );
  challenge = await options("/generate-authenticate-options", publicHeaders);
  assert.equal(
    (
      await request(endpoint + "/verify-authentication", challenge.headers, {
        response: authenticator.authentication(
          challenge.data.challenge,
          "https://wrong-origin.test",
        ),
      })
    ).ok,
    false,
  );
  challenge = await options("/generate-authenticate-options", publicHeaders);
  const signed = {
    response: authenticator.authentication(challenge.data.challenge, origin),
  };
  const attempts = await Promise.all([
    request(endpoint + "/verify-authentication", challenge.headers, signed),
    request(endpoint + "/verify-authentication", challenge.headers, signed),
  ]);
  assert.equal(attempts.filter((response) => response.ok).length, 1);
  const direct = cookies(attempts.find((response) => response.ok)!);
  assert.equal((await auth.findSession(direct))?.user.id, adminId);
  // The passkey after a password cannot be carried into a different password attempt.
  const firstAttempt = await passwordChallenge();
  const firstOptions = await options(
    "/generate-authenticate-options",
    firstAttempt,
  );
  const secondAttempt = await passwordChallenge();
  const mixed = new Headers(firstOptions.headers);
  const factor = secondAttempt
    .get("cookie")!
    .split("; ")
    .find((value) => value.startsWith("towbar.two_factor="))!;
  assert(factor);
  mixed.set(
    "cookie",
    firstOptions.headers
      .get("cookie")!
      .split("; ")
      .filter((value) => !value.startsWith("towbar.two_factor="))
      .concat(factor)
      .join("; "),
  );
  assert.equal(
    (
      await request(endpoint + "/verify-authentication", mixed, {
        response: authenticator.authentication(
          firstOptions.data.challenge,
          origin,
          2,
        ),
      })
    ).ok,
    false,
  );
  const pending = await passwordChallenge();
  challenge = await options("/generate-authenticate-options", pending);
  const completed = await ok(
    await request(endpoint + "/verify-authentication", challenge.headers, {
      response: authenticator.authentication(
        challenge.data.challenge,
        origin,
        2,
      ),
    }),
  );
  assert.equal((await auth.findSession(cookies(completed)))!.user.id, adminId);
  // A password-and-passkey sign-in counts as recent authentication.
  await ok(
    await request(endpoint + "/generate-register-options", cookies(completed)),
  );
  // An account's credential cannot authenticate another user's existing session.
  const otherId = (await auth.findSession(memberHeaders))!.user.id;
  const otherChallenge = await options(
    "/generate-authenticate-options",
    adminHeaders,
  );
  await database
    .update(schema.authPasskeys)
    .set({ userId: otherId })
    .where(eq(schema.authPasskeys.id, keys[0]!.id));
  assert.equal(
    (
      await request(
        endpoint + "/verify-authentication",
        otherChallenge.headers,
        {
          response: authenticator.authentication(
            otherChallenge.data.challenge,
            origin,
            3,
          ),
        },
      )
    ).ok,
    false,
  );
  await database
    .update(schema.authPasskeys)
    .set({ userId: adminId })
    .where(eq(schema.authPasskeys.id, keys[0]!.id));
  // Reauthentication retains the session and never permits password fallback.
  await database
    .update(schema.sessions)
    .set({ authenticatedAt: new Date(0) })
    .where(eq(schema.sessions.id, current.sessionId));
  assert.equal(
    (
      await request(
        "/v1/core/profile/password",
        adminHeaders,
        {
          newPassword: password + " changed",
          confirmPassword: password + " changed",
        },
        "PUT",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/v1/core/profile/passkeys/recovery-codes",
        adminHeaders,
        {},
      )
    ).status,
    403,
  );
  challenge = await options("/generate-authenticate-options", adminHeaders);
  const reauthenticated = await ok(
    await request(endpoint + "/verify-authentication", challenge.headers, {
      response: authenticator.authentication(
        challenge.data.challenge,
        origin,
        3,
      ),
    }),
  );
  assert.deepEqual(await reauthenticated.json(), { authenticated: true });
  assert.equal(reauthenticated.headers.getSetCookie().length, 0);
  assert.equal(
    (await auth.findSession(adminHeaders))?.sessionId,
    current.sessionId,
  );
  await ok(
    await request(
      "/v1/core/profile/password",
      adminHeaders,
      {
        newPassword: password + " changed",
        confirmPassword: password + " changed",
      },
      "PUT",
    ),
  );
  assert.equal(
    (
      await auth.authenticatePassword({
        email: "admin@settings.test",
        password,
      })
    ).ok,
    false,
  );
  const changedLogin = await auth.authenticatePassword({
    email: "admin@settings.test",
    password: password + " changed",
  });
  assert.equal(
    ((await changedLogin.json()) as { twoFactorRedirect: boolean })
      .twoFactorRedirect,
    true,
  );
  await ok(
    await request(
      "/v1/core/profile/password",
      adminHeaders,
      {
        newPassword: password,
        confirmPassword: password,
      },
      "PUT",
    ),
  );
  const replaced = await ok(
    await request("/v1/core/profile/passkeys/recovery-codes", adminHeaders, {}),
  );
  const codes = ((await replaced.json()) as { recoveryCodes: string[] })
    .recoveryCodes;
  assert.equal(codes.length, 10);
  assert.notDeepEqual(codes, firstCodes);
  assert.equal(
    (
      await request(
        endpoint + "/verify-recovery-code",
        await passwordChallenge(),
        { code: firstCodes[0] },
      )
    ).ok,
    false,
  );
  const recovery = await passwordChallenge();
  const recovered = await Promise.all([
    request(endpoint + "/verify-recovery-code", recovery, { code: codes[0] }),
    request(endpoint + "/verify-recovery-code", recovery, { code: codes[0] }),
  ]);
  assert.equal(recovered.filter((result) => result.ok).length, 1);
  const recoveredHeaders = cookies(recovered.find((result) => result.ok)!);
  assert.equal((await auth.findSession(recoveredHeaders))?.user.id, adminId);
  // A recovery code restores access, not proof for credential changes: each
  // sensitive change needs a passkey confirmation first.
  const requiresReauthentication = async (response: Response) => {
    assert.equal(response.status, 403);
    assert.match(await response.text(), /REAUTHENTICATION_REQUIRED/);
  };
  await requiresReauthentication(
    await request(endpoint + "/generate-register-options", recoveredHeaders),
  );
  await requiresReauthentication(
    await request("/v1/core/profile/email-change", recoveredHeaders, {
      email: "recovered@settings.test",
    }),
  );
  await requiresReauthentication(
    await request(
      "/v1/core/profile/passkeys/recovery-codes",
      recoveredHeaders,
      {},
    ),
  );
  // Admin API keys and MCP admin grants use the same check. Their routes need
  // HTTPS external access, which this suite's http origin does not enable.
  const { requireRecentAuthentication } =
    await import("../auth/recent-authentication.js");
  const recoveredSession = (await auth.findSession(recoveredHeaders))!;
  const [recoveredRow] = await database
    .select({ authenticatedAt: schema.sessions.authenticatedAt })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, recoveredSession.sessionId));
  assert.equal(recoveredRow?.authenticatedAt.getTime(), 0);
  await assert.rejects(
    requireRecentAuthentication(adminId, recoveredSession.sessionId),
    (error: { code?: string }) => error.code === "REAUTHENTICATION_REQUIRED",
  );
  // A browser that is already signed in cannot add a recovery sign-in.
  const signedInRecovery = new Headers(recoveredHeaders);
  signedInRecovery.set(
    "cookie",
    [
      recoveredHeaders.get("cookie"),
      (await passwordChallenge())
        .get("cookie")!
        .split("; ")
        .find((value) => value.startsWith("towbar.two_factor=")),
    ].join("; "),
  );
  assert.equal(
    (
      await request(endpoint + "/verify-recovery-code", signedInRecovery, {
        code: codes[1],
      })
    ).status,
    401,
  );
  challenge = await options("/generate-authenticate-options", recoveredHeaders);
  await ok(
    await request(endpoint + "/verify-authentication", challenge.headers, {
      response: authenticator.authentication(
        challenge.data.challenge,
        origin,
        4,
      ),
    }),
  );
  await ok(
    await request(endpoint + "/generate-register-options", recoveredHeaders),
  );
  assert.equal(
    (
      await request(
        endpoint + "/verify-recovery-code",
        await passwordChallenge(),
        { code: codes[0] },
      )
    ).ok,
    false,
  );
  const expired = await passwordChallenge();
  const expiringOptions = await options(
    "/generate-authenticate-options",
    expired,
  );
  await database
    .update(schema.authVerifications)
    .set({ expiresAt: new Date(0) })
    .where(eq(schema.authVerifications.value, adminId));
  assert.equal(
    (
      await request(endpoint + "/verify-recovery-code", expired, {
        code: codes[1],
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        endpoint + "/verify-authentication",
        expiringOptions.headers,
        {
          response: authenticator.authentication(
            expiringOptions.data.challenge,
            origin,
            5,
          ),
        },
      )
    ).ok,
    false,
  );
  const freshOptions = await ok(
    await request(endpoint + "/generate-authenticate-options", expired),
  );
  assert.equal(
    ((await freshOptions.json()) as { allowCredentials?: unknown[] })
      .allowCredentials?.length ?? 0,
    0,
  );
  const secondKey = testAuthenticator();
  const additional = await options("/generate-register-options");
  const added = await ok(
    await request(endpoint + "/verify-registration", additional.headers, {
      name: "Second key",
      response: secondKey.registration(additional.data.challenge, origin),
    }),
  );
  assert.equal(
    ((await added.json()) as { recoveryCodes?: string[] }).recoveryCodes,
    undefined,
  );
  assert.equal(await auth.findSession(direct), null);
  // Delete the last key only with recent authentication; recovery codes go with it.
  const all = (await (
    await ok(await request(endpoint + "/list-user-passkeys", adminHeaders))
  ).json()) as Array<{ id: string }>;
  for (const key of all)
    await ok(
      await request(endpoint + "/delete-passkey", adminHeaders, { id: key.id }),
    );
  assert.equal(
    (await auth.findSession(adminHeaders))!.user.twoFactorEnabled,
    false,
  );
  assert.equal(
    (
      await database
        .select()
        .from(schema.authRecoveryCodes)
        .where(eq(schema.authRecoveryCodes.userId, adminId))
    ).length,
    0,
  );
  assert.equal(
    (
      await request(
        "/v1/core/profile/passkeys/recovery-codes",
        adminHeaders,
        {},
      )
    ).status,
    403,
  );
  assert.equal(
    (await auth.findSession(
      cookies(
        await auth.authenticatePassword({
          email: "admin@settings.test",
          password,
        }),
      ),
    ))!.user.id,
    adminId,
  );
  return adminHeaders;
}
