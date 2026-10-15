import type {
  Server,
  ServerPreparation,
  ServerPreparationStep,
} from "@workspace/towbar-web-client";

export const preparationGroups = [
  { id: "inspection", title: "Server Inspection" },
  { id: "prerequisites", title: "Prerequisites" },
] as const;

const checklistSteps = [
  {
    id: "connecting",
    group: "inspection",
    title: "Connection check",
    description:
      "Connect over SSH with the stored private key and trusted host key.",
  },
  {
    id: "inspecting",
    group: "inspection",
    title: "Inspect server",
    description: "Check the operating system and permissions needed for setup.",
  },
  {
    id: "installing_prerequisites",
    group: "prerequisites",
    title: "System packages",
    description:
      "Install Python and the system packages required for deployments.",
  },
  {
    id: "installing_docker",
    group: "prerequisites",
    title: "Docker Engine",
    description: "Install or validate Docker Engine and its build tools.",
  },
  {
    id: "installing_caddy",
    group: "prerequisites",
    title: "Caddy",
    description:
      "Install or validate the reverse proxy and required TLS modules.",
  },
  {
    id: "installing_log_collector",
    group: "prerequisites",
    title: "OTEL Logs Collector",
    description:
      "Install and enable log collection when ClickHouse is configured.",
  },
  {
    id: "configuring_access",
    group: "prerequisites",
    title: "Deployment access",
    description:
      "Create deployment directories and configure access for the SSH user.",
  },
  {
    id: "verifying",
    group: "prerequisites",
    title: "Verify server",
    description:
      "Confirm that the required services are ready for deployments.",
  },
] satisfies Array<{
  id: ServerPreparationStep["id"];
  group: (typeof preparationGroups)[number]["id"];
  title: string;
  description: string;
}>;

export function preparationChecklist(
  latest: ServerPreparation | undefined,
  setupStatus: Server["setupStatus"],
) {
  // A previous successful run does not prepare a changed server configuration.
  const preparation =
    latest?.status === "succeeded" && setupStatus !== "ready"
      ? undefined
      : latest;
  const historyUnavailable =
    setupStatus === "ready" && !preparation?.steps.length;
  const steps = checklistSteps
    .filter(
      (definition) =>
        definition.id !== "installing_log_collector" ||
        !preparation ||
        preparation.steps.some((step) => step.id === definition.id),
    )
    .map((definition) => {
      const recorded = preparation?.steps.find(
        (step) => step.id === definition.id,
      );
      return {
        ...definition,
        status: recorded?.status ?? "waiting",
        message: recorded?.message ?? null,
        log: recorded?.log ?? "",
        logTruncated: recorded?.logTruncated ?? false,
        startedAt: recorded?.startedAt ?? null,
        finishedAt: recorded?.finishedAt ?? null,
      } satisfies ServerPreparationStep & typeof definition;
    });
  const completed = steps.filter((step) => step.status === "succeeded").length;
  return {
    preparation,
    historyUnavailable,
    steps,
    completed,
    total: steps.length,
  };
}

export type PreparationChecklist = ReturnType<typeof preparationChecklist>;
