import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import nodemailer, { type SMTPTransportOptions } from "nodemailer";
import {
  renderOperationalEmail,
  renderTransactionalEmail,
  transactionalTemplates,
} from "@workspace/towbar-email";
import { createSmtpCapture } from "./smtp-test-server.js";
import { resolvePublicSmtpAddress, sendSmtpEmail } from "./smtp.js";

void test("SMTP sends HTML and plain text over verified TLS for every team template", async () => {
  const capture = await createSmtpCapture();
  try {
    const provider = {
      host: "smtp.towbar.test",
      port: capture.port,
      secure: true,
      username: "fixture",
      password: "fixture-password",
      from: "towbar@example.test",
    };
    const dependencies = {
      resolveAddress: (host: string) => {
        assert.equal(host, provider.host);
        return Promise.resolve("127.0.0.1");
      },
      createTransport: (options: SMTPTransportOptions) =>
        nodemailer.createTransport({
          ...options,
          tls: { servername: provider.host, ca: capture.ca },
        }),
    };
    for (const template of transactionalTemplates) {
      const content = await renderTransactionalEmail(template, {
        teamName: "Capture team",
        name: "Fixture",
        role: "viewer",
        previousRole: "admin",
        actionUrl: "https://towbar.test/invite/fixture",
        verificationCode: "123456",
        keyName: "CI",
      });
      const result = await sendSmtpEmail(
        {
          ...content,
          messageId: randomUUID(),
          recipients: ["recipient@example.test"],
        },
        provider,
        dependencies,
      );
      assert(result.providerStatus);
      assert.match(result.providerStatus, /^250/);
    }
    const content = await renderOperationalEmail({
      title: "Deployment succeeded",
      summary: "The fixture app is ready.",
      details: {},
      actionUrl: "https://towbar.test",
    });
    await sendSmtpEmail(
      {
        ...content,
        messageId: randomUUID(),
        recipients: ["recipient@example.test"],
      },
      provider,
      dependencies,
    );
    assert.equal(capture.messages.length, transactionalTemplates.length + 1);
    assert(capture.authenticated());
    for (const message of capture.messages) {
      assert.match(message, /Content-Type: multipart\/alternative/);
      assert.match(message, /Content-Type: text\/plain/);
      assert.match(message, /Content-Type: text\/html/);
      assert(
        /Subject: \[Towbar\]/.test(message),
        "Fixed Towbar subject prefix",
      );
      assert(!message.includes(provider.password));
      assert.match(message, /To: recipient@example.test/);
      assert.match(message, /From: Towbar <towbar@example\.test>/);
    }
    await assert.rejects(
      sendSmtpEmail(
        {
          ...content,
          messageId: randomUUID(),
          recipients: ["recipient@example.test"],
        },
        { ...provider, password: "wrong" },
        dependencies,
      ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert(!error.message.includes("wrong"));
        return /rejected/i.test(error.message);
      },
    );
    await assert.rejects(
      sendSmtpEmail(
        {
          ...content,
          messageId: randomUUID(),
          recipients: ["recipient@example.test"],
        },
        provider,
        {
          resolveAddress: dependencies.resolveAddress,
          createTransport: (options) => nodemailer.createTransport(options),
        },
      ),
    );
    await assert.rejects(resolvePublicSmtpAddress("127.0.0.1"), /public/);
  } finally {
    await capture.close();
  }
});
