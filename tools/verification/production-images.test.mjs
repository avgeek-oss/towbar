import assert from "node:assert/strict";
import test from "node:test";
import { verifyProductionImages } from "./production-images.mjs";

const images = {
  api: "towbar/api:disposable",
  worker: "towbar/worker:disposable",
  "web-app": "towbar/web-app:disposable",
};

test("image gate checks every artifact and rejects findings or scanner errors", async () => {
  const checked = [];
  const errors = [new Error("findings"), new Error("database unavailable")];
  const run = {
    id: "isolated-run",
    directory: "/tmp/isolated-run",
    async capture() {
      return "";
    },
    async step(name, command, args) {
      assert.equal(command, "docker");
      if (name === "image-security-db") {
        assert.ok(args.includes("--download-db-only"));
        return;
      }
      checked.push(args.at(-1));
      assert.ok(args.includes("--skip-db-update"));
      assert.ok(
        args.includes(
          "towbar-image-scan-cache-isolated-run:/root/.cache/trivy",
        ),
      );
      assert.equal(args[args.indexOf("--cache-dir") + 1], "/root/.cache/trivy");
      assert.equal(args[args.indexOf("--exit-code") + 1], "1");
      assert.equal(args[args.indexOf("--severity") + 1], "HIGH,CRITICAL");
      assert.ok(!args.includes("--ignore-unfixed"));
      const failure = errors[checked.length - 1];
      if (failure) throw failure;
    },
  };
  await assert.rejects(verifyProductionImages(run, images), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, errors);
    return true;
  });
  assert.deepEqual(checked, Object.values(images));
});

test("interrupted scanner cleanup is limited to the named run-owned container", async () => {
  const captured = [];
  const failure = new Error("scanner timed out");
  const run = {
    id: "isolated-run",
    directory: "/tmp/isolated-run",
    async step() {
      throw failure;
    },
    async capture(command, args) {
      captured.push({ command, args });
      if (args[0] === "ps") return "owned-container-id";
      if (args[0] === "volume" && args[1] === "ls")
        return "towbar-image-scan-cache-isolated-run";
      return "";
    },
  };
  await assert.rejects(verifyProductionImages(run, { api: images.api }));
  // Both database attempts time out, so no scan starts.
  for (const index of [0, 2]) {
    assert.ok(
      captured[index].args.includes(
        "name=^/towbar-image-scan-isolated-run-db$",
      ),
    );
    assert.ok(
      captured[index].args.includes(
        "label=com.towbar.verification.run=isolated-run",
      ),
    );
    assert.deepEqual(captured[index + 1], {
      command: "docker",
      args: ["rm", "--force", "towbar-image-scan-isolated-run-db"],
    });
  }
  assert.ok(
    !captured.some(({ args }) =>
      args.includes("name=^/towbar-image-scan-isolated-run-api$"),
    ),
  );
  assert.deepEqual(captured[4], {
    command: "docker",
    args: [
      "volume",
      "ls",
      "--quiet",
      "--filter",
      "name=^towbar-image-scan-cache-isolated-run$",
    ],
  });
  assert.deepEqual(captured[5], {
    command: "docker",
    args: ["volume", "rm", "towbar-image-scan-cache-isolated-run"],
  });
});

test("a host cache directory keeps the scanner database between runs", async () => {
  const captured = [];
  const run = {
    id: "isolated-run",
    directory: "/tmp/isolated-run",
    async step(name, command, args) {
      assert.ok(args.includes("/var/cache/trivy:/root/.cache/trivy"));
      assert.ok(
        !args.some((arg) => arg.startsWith("towbar-image-scan-cache-")),
      );
    },
    async capture(command, args) {
      captured.push(args);
      return "";
    },
  };
  await verifyProductionImages(run, images, {
    cacheDirectory: "/var/cache/trivy",
  });
  assert.ok(!captured.some((args) => args[0] === "volume"));
});

test("a failed mirror download retries GHCR before the scans run", async () => {
  const steps = [];
  const run = {
    id: "isolated-run",
    directory: "/tmp/isolated-run",
    async step(name, command, args) {
      steps.push({ name, args });
      if (name === "image-security-db") throw new Error("mirror 404");
    },
    async capture() {
      return "";
    },
  };
  await verifyProductionImages(run, images);
  assert.deepEqual(
    steps.map(({ name }) => name),
    [
      "image-security-db",
      "image-security-db-ghcr",
      "image-security-api",
      "image-security-worker",
      "image-security-web-app",
    ],
  );
  assert.ok(!steps[0].args.includes("--db-repository"));
  assert.equal(
    steps[1].args[steps[1].args.indexOf("--db-repository") + 1],
    "ghcr.io/aquasecurity/trivy-db:2",
  );
});

test("without a database from either source the gate fails without scanning", async () => {
  const steps = [];
  const errors = [new Error("mirror 404"), new Error("ghcr unavailable")];
  const run = {
    id: "isolated-run",
    directory: "/tmp/isolated-run",
    async step(name) {
      steps.push(name);
      throw errors[steps.length - 1];
    },
    async capture() {
      return "";
    },
  };
  await assert.rejects(verifyProductionImages(run, images), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, errors);
    return true;
  });
  assert.deepEqual(steps, ["image-security-db", "image-security-db-ghcr"]);
});
