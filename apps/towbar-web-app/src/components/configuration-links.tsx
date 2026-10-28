"use client";
import { useAccess } from "./access-context";
import { InlineLink } from "./page-parts";

export function ConfigurationLinks({
  serverId,
  deployable,
}: {
  serverId: string;
  deployable?: { id: string; kind: "app" | "resource" };
}) {
  const { can } = useAccess();
  return (
    <span className="mt-2 flex flex-wrap gap-3">
      {can("admin") ? (
        <InlineLink href={`/servers/${serverId}/settings/configuration`}>
          Server credentials
        </InlineLink>
      ) : null}
      {deployable && can("member") ? (
        <InlineLink
          href={`/${deployable.kind === "app" ? "services" : "datastores"}/${deployable.id}/settings/secrets`}
        >
          {deployable.kind === "app" ? "Service secrets" : "Datastore secrets"}
        </InlineLink>
      ) : null}
    </span>
  );
}
