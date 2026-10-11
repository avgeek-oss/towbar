import { z } from "zod";

export const tlsSchema = z
  .object({
    mode: z.enum(["direct", "cloudflare-dns"]),
    proxied: z.boolean().optional(),
  })
  .strict()
  .refine((tls) => tls.proxied === undefined || tls.mode === "cloudflare-dns", {
    message: "tls.proxied is only supported with cloudflare-dns",
    path: ["proxied"],
  });

export type TlsPolicy = z.infer<typeof tlsSchema>;
