import assert from "node:assert/strict";
import test from "node:test";
import {
  type IconFetcher,
  declaredIcons,
  discoverIcon,
  loadIcon,
} from "./discovery.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWNkAAAAASUVORK5CYII=",
  "base64",
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>';
function fixture(routes: Record<string, () => Response>) {
  const requests: string[] = [];
  const fetcher: IconFetcher = (url) => {
    requests.push(url.href);
    return Promise.resolve(
      routes[url.href]?.() ?? new Response(null, { status: 404 }),
    );
  };
  return { fetcher, requests };
}
function image(body = png, type = "image/png") {
  return new Response(body, { headers: { "content-type": type } });
}

void test("HTML discovery uses declared PNG, ICO and SVG links with base URLs and decoded attributes", () => {
  assert.deepEqual(
    declaredIcons(
      `<!doctype html><head>
    <!-- <link rel="icon" href="/comment.png"> -->
    <script>"<link rel='icon' href='/script.png'>"</script>
    <base href="https://cdn.example.com/assets/">
    <link rel="shortcut ICON" href="favicon.png?v=2&amp;theme=dark">
    <link rel=icon href="../_cosmos.ico">
    <link rel="apple-touch-icon" href="icon.svg">
    <template><link rel=icon href="/template.png"></template>
    </head><body><link rel=icon href="/body.png"></body>`,
      "",
      new URL("https://web.example.com/app/"),
    ),
    [
      "https://cdn.example.com/assets/favicon.png?v=2&theme=dark",
      "https://cdn.example.com/_cosmos.ico",
      "https://cdn.example.com/assets/icon.svg",
    ],
  );
});

void test("JSON API Link headers are resolved on the API origin without guessing sibling hosts", async () => {
  const { fetcher, requests } = fixture({
    "https://api.example.com/": () =>
      new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json",
          link: '</schema>; rel="describedby", </icon.svg>; rel="icon"; type="image/svg+xml"',
        },
      }),
    "https://api.example.com/icon.svg": () =>
      image(Buffer.from(svg), "image/svg+xml"),
  });
  assert.equal(
    await discoverIcon("api.example.com", fetcher),
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  assert.deepEqual(requests, [
    "https://api.example.com/",
    "https://api.example.com/icon.svg",
  ]);
});

void test("homepage and icon redirects resolve relative paths on their final origins", async () => {
  const { fetcher, requests } = fixture({
    "https://web.example.com/": () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://www.example.com/site/" },
      }),
    "https://www.example.com/site/": () =>
      new Response('<link rel="icon" href="icon.png?icon.hash.png">', {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    "https://www.example.com/site/icon.png?icon.hash.png": () =>
      new Response(null, {
        status: 302,
        headers: { location: "../brand/icon.png" },
      }),
    "https://www.example.com/brand/icon.png": () => image(),
  });
  assert.equal(
    await discoverIcon("web.example.com", fetcher),
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.equal(requests.at(-1), "https://www.example.com/brand/icon.png");
});

void test("missing or invalid declared icons fall back to /favicon.ico and its PNG redirect", async () => {
  const { fetcher, requests } = fixture({
    "https://web.example.com/": () =>
      new Response('<link rel=icon href="/broken.svg">', {
        headers: { "content-type": "text/html" },
      }),
    "https://web.example.com/broken.svg": () =>
      image(Buffer.from("<html>sign in</html>"), "image/svg+xml"),
    "https://web.example.com/favicon.ico": () =>
      new Response(null, {
        status: 302,
        headers: { location: "/brand/icon.png" },
      }),
    "https://web.example.com/brand/icon.png": () => image(),
  });
  assert.match(
    (await discoverIcon("web.example.com", fetcher))!,
    /^data:image\/png;/u,
  );
  assert.equal(requests.length, 4);
});

void test("canonical ICO works without a homepage", async () => {
  const ico = Buffer.from([0, 0, 1, 0, 1, 0]);
  const { fetcher } = fixture({
    "https://api.example.com/favicon.ico": () => image(ico, "image/x-icon"),
  });
  assert.equal(
    await discoverIcon("api.example.com", fetcher),
    `data:image/x-icon;base64,${ico.toString("base64")}`,
  );
});

void test("favicon size limit accepts 512 KiB and rejects larger bodies with or without Content-Length", async () => {
  for (const size of [512 * 1024, 512 * 1024 + 1]) {
    const body = svg.padEnd(size, " ");
    for (const contentLength of [false, true]) {
      const { fetcher } = fixture({
        "https://web.example.com/favicon.ico": () =>
          new Response(body, {
            headers: {
              "content-type": "image/svg+xml",
              ...(contentLength ? { "content-length": String(size) } : {}),
            },
          }),
      });
      assert.equal(
        await discoverIcon("web.example.com", fetcher),
        size === 512 * 1024
          ? `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`
          : null,
      );
    }
  }
});

void test("discovery rejects private URLs, credentials, non-HTTPS and oversized responses", async () => {
  assert.deepEqual(
    declaredIcons(
      '<link rel=icon href="http://public.example.com/icon.png"><link rel=icon href="https://127.0.0.1/icon"><link rel=icon href="https://user:password@public.example.com/icon"><link rel=icon href="https://host.internal/icon">',
      "",
      new URL("https://web.example.com/"),
    ),
    [],
  );
  let cancelled = false;
  const fetcher: IconFetcher = (url) =>
    Promise.resolve(
      url.pathname === "/"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://169.254.169.254/latest/meta-data/" },
          })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(512 * 1024 + 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "image/png" } },
          ),
    );
  assert.equal(await discoverIcon("web.example.com", fetcher), null);
  assert.equal(cancelled, true);
});

void test("oversized HTML still preserves API Link declarations", async () => {
  const { fetcher } = fixture({
    "https://web.example.com/": () =>
      new Response("x".repeat(256 * 1024 + 1), {
        headers: {
          "content-type": "text/html",
          link: '</icon.png>; rel="icon"',
        },
      }),
    "https://web.example.com/icon.png": () => image(),
  });
  assert.match(
    (await discoverIcon("web.example.com", fetcher))!,
    /^data:image\/png;/u,
  );
});

void test("redirect loops and aborted discovery have bounded work", async () => {
  let calls = 0;
  const fetcher: IconFetcher = () => {
    calls++;
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
  };
  assert.equal(await discoverIcon("web.example.com", fetcher), null);
  assert.equal(calls, 8);
  calls = 0;
  assert.equal(
    await discoverIcon("web.example.com", fetcher, AbortSignal.abort()),
    null,
  );
  assert.equal(calls, 0);
});

void test("missing and mislabeled images yield a recoverable placeholder", async () => {
  for (const type of ["text/html", "image/png", "image/x-icon"]) {
    const { fetcher } = fixture({
      "https://web.example.com/favicon.ico": () =>
        image(Buffer.from("<html>404</html>"), type),
    });
    assert.equal(await discoverIcon("web.example.com", fetcher), null);
  }
});

void test(
  "SVG declarations and many comments are scanned without backtracking",
  { timeout: 1000 },
  async () => {
    const valid = `<?xml version="1.0"?>${"<!-- icon -->".repeat(2000)}${svg}`;
    const { fetcher } = fixture({
      "https://web.example.com/favicon.ico": () =>
        image(Buffer.from(valid), "image/svg+xml"),
    });
    assert.equal(
      await discoverIcon("web.example.com", fetcher),
      `data:image/svg+xml;base64,${Buffer.from(valid).toString("base64")}`,
    );
    const invalid = fixture({
      "https://web.example.com/favicon.ico": () =>
        image(
          Buffer.from(`<!--${"--><!--".repeat(2000)}unfinished`),
          "image/svg+xml",
        ),
    });
    assert.equal(await discoverIcon("web.example.com", invalid.fetcher), null);
  },
);

void test("direct workload icons fetch the exact image URL without homepage or favicon discovery", async () => {
  const url = "https://cdn.example.com/Posted/worker.png?v=2&theme=dark";
  const { fetcher, requests } = fixture({ [url]: () => image() });
  assert.equal(
    await loadIcon(url, fetcher),
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.deepEqual(requests, [url]);
  const automatic = fixture({
    "https://web.example.com/favicon.ico": () => image(),
  });
  assert.ok(await loadIcon("web.example.com", automatic.fetcher));
});

void test("direct workload icons follow bounded HTTPS redirects and reject private redirects", async () => {
  const direct = fixture({
    "https://cdn.example.com/icon": () =>
      new Response(null, {
        status: 302,
        headers: { location: "/assets/brand.svg" },
      }),
    "https://cdn.example.com/assets/brand.svg": () =>
      image(Buffer.from(svg), "image/svg+xml"),
  });
  assert.ok(await loadIcon("https://cdn.example.com/icon", direct.fetcher));
  assert.deepEqual(direct.requests, [
    "https://cdn.example.com/icon",
    "https://cdn.example.com/assets/brand.svg",
  ]);
  for (const location of [
    "https://169.254.169.254/latest/meta-data",
    "https://private.internal/icon",
    "https://[::1]/icon",
    "http://example.com/icon",
    "https://user:pass@example.com/icon",
    "https://example.com:8443/icon",
  ]) {
    const unsafe = fixture({
      "https://cdn.example.com/icon": () =>
        new Response(null, { status: 302, headers: { location } }),
    });
    assert.equal(
      await loadIcon("https://cdn.example.com/icon", unsafe.fetcher),
      null,
    );
    assert.equal(unsafe.requests.length, 1);
  }
  const loop = fixture({
    "https://cdn.example.com/icon": () =>
      new Response(null, { status: 302, headers: { location: "/icon" } }),
  });
  assert.equal(
    await loadIcon("https://cdn.example.com/icon", loop.fetcher),
    null,
  );
  assert.equal(loop.requests.length, 4);
});

void test("direct workload icons reject invalid images and enforce the size and cancellation limits", async () => {
  const url = "https://cdn.example.com/icon.svg";
  for (const size of [512 * 1024, 512 * 1024 + 1]) {
    for (const declared of [true, false]) {
      const direct = fixture({
        [url]: () =>
          new Response(svg.padEnd(size, " "), {
            headers: {
              "content-type": "image/svg+xml",
              ...(declared ? { "content-length": String(size) } : {}),
            },
          }),
      });
      const result = await loadIcon(url, direct.fetcher);
      assert.equal(Boolean(result), size === 512 * 1024);
    }
  }
  for (const type of ["text/html", "image/png", "image/svg+xml"]) {
    const direct = fixture({
      [url]: () => image(Buffer.from("<html>Not an image</html>"), type),
    });
    assert.equal(await loadIcon(url, direct.fetcher), null);
    assert.deepEqual(direct.requests, [url]);
  }
  const cancelled = fixture({});
  assert.equal(
    await loadIcon(url, cancelled.fetcher, AbortSignal.abort()),
    null,
  );
  assert.equal(cancelled.requests.length, 0);
  let bodyCancelled = false;
  const streamed = fixture({
    [url]: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(512 * 1024 + 1));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  });
  assert.equal(await loadIcon(url, streamed.fetcher), null);
  assert.equal(bodyCancelled, true);
});
