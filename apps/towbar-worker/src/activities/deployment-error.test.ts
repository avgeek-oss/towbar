import assert from "node:assert/strict";
import test from "node:test";
import { CommandError } from "@workspace/towbar-deployer";
import { deploymentErrorMessage } from "./deployment-error.js";

void test("explains SSH connection failures without including command output", () => {
  for (const [stderr, expected] of [
    ["Permission denied (publickey)", "could not sign in"],
    [
      "ssh: connect to host 203.0.113.10 port 22: Connection timed out",
      "connection timed out",
    ],
    [
      "ssh: connect to host 203.0.113.10 port 22: Connection refused",
      "refused the SSH connection",
    ],
    [
      "ssh: connect to host 203.0.113.10 port 22: No route to host",
      "could not reach",
    ],
    ["Host key verification failed", "identity could not be verified"],
  ]) {
    const error = new CommandError(
      "ssh exited unsuccessfully",
      "secret-stdout",
      `${stderr}\nTOKEN=secret-stderr`,
    );
    const message = deploymentErrorMessage(error, "checking_server");
    assert(message.includes(expected!));
    assert.doesNotMatch(message, /secret|TOKEN|exited unsuccessfully/u);
  }
});

void test("remote command failures describe the failed step without guessing a cause", () => {
  const message = deploymentErrorMessage(
    new CommandError(
      "ssh exited unsuccessfully",
      "private build output",
      "docker failed: Operation timed out, secret=value",
    ),
    "building",
  );
  assert.match(message, /command failed during building/u);
  assert.match(message, /deployment logs/u);
  assert.doesNotMatch(message, /private|secret|SSH connection/u);
});

void test("explains host-log path permissions without exposing command output", () => {
  const message = deploymentErrorMessage(
    new CommandError(
      "ssh exited unsuccessfully",
      "private output",
      "Host log collection could not inspect Docker's data-root; check passwordless sudo access\nTOKEN=private",
    ),
    "starting_candidate",
  );
  assert.match(message, /passwordless sudo access/u);
  assert.doesNotMatch(message, /TOKEN|private|ssh exited/u);
});

void test("safe non-command errors retain their reason and redact bearer credentials", () => {
  assert.equal(
    deploymentErrorMessage(new Error("Registry rejected Bearer private-token")),
    "Registry rejected Bearer [REDACTED]",
  );
});

void test("public HTTPS failures retain DNS and certificate details in deployment events", () => {
  for (const detail of [
    "getaddrinfo ENOTFOUND ds.oss.example.com (ENOTFOUND)",
    "certificate does not match the hostname (ERR_TLS_CERT_ALTNAME_INVALID)",
  ]) {
    const message = `Public HTTPS health check failed for 'ds.oss.example.com': fetch failed: ${detail}`;
    assert.equal(
      deploymentErrorMessage(new Error(message), "verifying_endpoint"),
      message,
    );
  }
});
