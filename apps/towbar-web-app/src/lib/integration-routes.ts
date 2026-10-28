const notificationRoutes = ["slack", "email", "webhook", "deliveries"] as const;

const platformIntegrationRoutes = [
  "github",
  "registry",
  "aws",
  "gcp",
  "s3",
  "r2",
  "infisical",
  "doppler",
  "cloudflare",
] as const;

export const integrationRoutes = [
  ...platformIntegrationRoutes,
  ...notificationRoutes,
];

const integrationRouteSet = new Set<string>(integrationRoutes);

export function isIntegrationRoute(value: string | undefined): value is string {
  return value !== undefined && integrationRouteSet.has(value);
}
