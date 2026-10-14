import { readFileSync } from "node:fs";
import { Hono } from "hono";

const icon = new Uint8Array(
  readFileSync(
    new URL("../../public/brand/towbar-favicon.png", import.meta.url),
  ),
);

export const faviconRoutes = new Hono()
  .get("/favicon.ico", (context) =>
    context.redirect("/brand/towbar-favicon.png", 302),
  )
  .get("/brand/towbar-favicon.png", (context) => {
    context.header("Content-Type", "image/png");
    context.header("Cache-Control", "public, max-age=86400");
    return context.body(icon);
  });
