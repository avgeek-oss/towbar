import type { Source } from "@workspace/towbar-web-client";

export type RepositorySyncResponse = {
  outcomes: {
    environmentId: string;
    syncId: string | null;
    error: string | null;
  }[];
};

export async function queueRepositorySyncs(
  sources: Source[],
  requestSync: (sourceId: string) => Promise<RepositorySyncResponse>,
) {
  let queued = 0;
  const failures: string[] = [];
  for (const source of sources.filter((source) => source.status === "active")) {
    const name = `${source.repositoryOwner}/${source.repositoryName}`;
    try {
      const { outcomes } = await requestSync(source.id);
      if (!outcomes.length) {
        failures.push(`${name}: No connected environments to sync`);
      }
      for (const outcome of outcomes) {
        if (outcome.error) failures.push(`${name}: ${outcome.error}`);
        else if (outcome.syncId) queued += 1;
      }
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : "Sync request failed"}`,
      );
    }
  }
  return { queued, failures };
}
