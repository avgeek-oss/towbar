import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { InlineLink } from "./page-parts";
export function ManifestStateNotice({ state }: { state?: string }) {
  if (!state || state === "active") return null;
  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>
          {state === "conflict"
            ? "Manifest conflict"
            : state === "retired"
              ? "Retirement pending"
              : state === "removed"
                ? "Workload removed"
                : "Workload removal in progress"}
        </Alert.Title>
        <Alert.Description>
          {state === "removed"
            ? "This workload has been removed. History and backups remain."
            : "New deployments are paused."}{" "}
          <InlineLink
            href={state === "conflict" ? "/conflicts" : "/retirements"}
          >
            Review {state === "conflict" ? "conflicts" : "retirements"}
          </InlineLink>{" "}
          to inspect repository declarations and retained data.
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
