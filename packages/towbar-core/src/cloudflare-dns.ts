import type {
  NormalizedComposeWorkload,
  NormalizedDeployable,
} from "./manifest.js";

export function deploymentCloudflareDnsProxy(
  app: Pick<NormalizedDeployable, "domains" | "ingress" | "tls"> & {
    services?: NormalizedComposeWorkload["services"];
  },
): Record<string, boolean> {
  if (app.services)
    return Object.fromEntries(
      Object.values(app.services).flatMap((service) =>
        service.tls?.mode === "cloudflare-dns" &&
        service.ingress?.type !== "cloudflare-tunnel"
          ? (service.domains ?? []).map((hostname) => [
              hostname,
              service.tls?.proxied ?? true,
            ])
          : [],
      ),
    );
  return app.tls?.mode === "cloudflare-dns" &&
    app.ingress?.type !== "cloudflare-tunnel" &&
    app.domains
    ? Object.fromEntries(
        [
          app.domains.primary,
          ...app.domains.redirects.map(({ host }) => host),
        ].map((hostname) => [hostname, app.tls?.proxied ?? true]),
      )
    : {};
}

export function deploymentCloudflareDnsDomains(
  app: Parameters<typeof deploymentCloudflareDnsProxy>[0],
): string[] {
  return Object.keys(deploymentCloudflareDnsProxy(app));
}
