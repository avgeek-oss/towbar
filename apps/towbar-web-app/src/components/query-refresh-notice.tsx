"use client";
import { useRefreshFailures } from "@/hooks/query-refresh-failures";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ReloadIcon } from "@hugeicons/core-free-icons";

export function QueryRefreshNotice() {
  const failures = useRefreshFailures();
  if (!failures.length) return null;
  return (
    <Alert status="warning" className="mb-4">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>Some information couldn’t refresh</Alert.Title>
        <Alert.Description>
          Showing the last loaded data. Refresh before running actions.
        </Alert.Description>
      </Alert.Content>
      <Button
        variant="secondary"
        onPress={() => {
          const retried = new Set<string>();
          for (const failure of failures)
            if (!retried.has(failure.path)) {
              retried.add(failure.path);
              failure.retry();
            }
        }}
      >
        <HugeiconsIcon icon={ReloadIcon} className="size-4" />
        Retry
      </Button>
    </Alert>
  );
}
