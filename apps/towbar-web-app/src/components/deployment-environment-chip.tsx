import type { Deployment } from "@workspace/towbar-web-client";
import { EnvironmentChip } from "./environment-chip";

export function DeploymentEnvironmentChip({
  deployment,
  showIcon = true,
}: {
  deployment: Pick<Deployment, "environment" | "targetEnvironment">;
  showIcon?: boolean;
}) {
  const preview = deployment.environment === "preview";
  const environmentName = preview
    ? "preview"
    : deployment.targetEnvironment.name;
  return (
    <EnvironmentChip
      name={environmentName}
      showIcon={showIcon}
      tooltip={
        preview
          ? `Pull-request preview targeting ${deployment.targetEnvironment.name}`
          : undefined
      }
    />
  );
}
