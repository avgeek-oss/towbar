export type SystemHealthStatus =
  "healthy" | "attention" | "critical" | "unknown";

export type TowbarUpdateInfo = {
  checkedAt: string;
  installedVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  status: "available" | "current" | "ahead" | "unavailable";
};

export type SystemHealthCheck = {
  checkedAt: string | null;
  description: string;
  id: "api-database" | "temporal" | "worker";
  remediationHref: string | null;
  remediationLabel: string | null;
  status: SystemHealthStatus;
  title: string;
};

export type SystemHealth = {
  checkedAt: string;
  checks: SystemHealthCheck[];
  databaseStorage: Array<{
    sampledAt: string;
    towbarBytes: number;
    monitoringBytes: number;
    analyticsBytes: number | null;
    logsBytes: number | null;
    logsError: string | null;
  }>;
  status: SystemHealthStatus;
  version: string;
};
