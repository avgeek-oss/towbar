import type { ServerPreparationStepId } from "@workspace/towbar-core";

const commandFailureMessages: Partial<Record<ServerPreparationStepId, string>> =
  {
    connecting:
      "The SSH connection failed before the server returned a diagnostic. Verify the selected private key, SSH username, SSH port, and firewall rules, then try again.",
    inspecting:
      "Server inspection stopped without reporting a reason. Confirm the server runs supported Ubuntu and the SSH user has passwordless sudo access, then retry.",
    installing_prerequisites:
      "System package installation stopped without reporting a reason. Check APT and network access on the server, then retry.",
    installing_docker:
      "Docker setup stopped without reporting a reason. Check APT and the Docker service logs on the server, then retry.",
    installing_caddy:
      "Caddy setup stopped without reporting a reason. Check APT, Docker, and the Caddy service logs on the server, then retry.",
    installing_log_collector:
      "Log collector setup failed. Check ClickHouse configuration, outbound HTTPS to the Towbar API, Docker, and SSH access, then retry setup.",
    configuring_access:
      "Deployment access setup stopped without reporting a reason. Check sudo access and Docker group membership, then retry.",
    verifying:
      "Server verification stopped without reporting a reason. Check the Docker and Caddy service status, then retry.",
  };

export function preparationCommandFailureMessage(
  stepId?: ServerPreparationStepId,
) {
  return stepId ? commandFailureMessages[stepId] : undefined;
}
