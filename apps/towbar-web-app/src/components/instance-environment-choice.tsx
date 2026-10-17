"use client";

import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-guarded-router";
import { requestNavigation, approveNavigation } from "@/lib/unsaved-navigation";
import { breadcrumbEntityHref } from "@/lib/breadcrumb-entity-route";
import { useEffect, useRef, useState } from "react";
import type { App, Resource } from "@workspace/towbar-web-client";
import { ListBox } from "@avgeek-oss/design-system/collections/list-box";
import { Select } from "@avgeek-oss/design-system/forms/select";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { prefetchApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { SecondarySection } from "./secondary-sidebar";
import { EnvironmentIcon } from "./environment-icon";

export function InstanceEnvironmentChoice({
  item,
  kind,
}: {
  item: App | Resource;
  kind: "apps" | "resources";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const pendingSwitch = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      pendingSwitch.current = null;
    };
  }, []);
  useEffect(() => {
    if (pendingSwitch.current === item.id) {
      pendingSwitch.current = null;
      setSwitchingTo(null);
    }
  }, [item.id]);
  const isSwitching = switchingTo !== null && switchingTo !== item.id;
  const query = useApiQuery<{ apps?: App[]; resources?: Resource[] }>(
    item.entityId ? `/v1/core/sources/${item.sourceId}/${kind}` : null,
  );
  if (!item.entityId || !item.environment) return null;
  if (query.error)
    return (
      <SecondarySection className="order-[-1]" title="Environment">
        <p className="px-2 text-sm text-danger">{query.error}</p>
      </SecondarySection>
    );
  if (!query.data) return null;
  const instances = (query.data[kind] ?? [])
    .flatMap((instance) => {
      const environment = instance.environment;
      return instance.sourceId === item.sourceId &&
        instance.entityId === item.entityId &&
        environment
        ? [{ id: instance.id, environment }]
        : [];
    })
    .sort((left, right) =>
      left.environment.name.localeCompare(right.environment.name),
    );
  return (
    <SecondarySection className="order-[-1]" title="Environment">
      <div>
        <Select
          aria-label="Environment"
          fullWidth
          isDisabled={isSwitching}
          selectedKey={item.id}
          variant="secondary"
          onSelectionChange={(key) => {
            const id = String(key ?? "");
            if (
              id !== item.id &&
              instances.some((instance) => instance.id === id)
            ) {
              requestNavigation(() => {
                pendingSwitch.current = id;
                setSwitchingTo(id);
                const href = breadcrumbEntityHref({
                  kind,
                  currentId: item.id,
                  targetId: id,
                  pathname,
                  search: window.location.search,
                });
                const navigate = () => {
                  if (pendingSwitch.current === id)
                    approveNavigation(() => router.push(href));
                };
                void prefetchApiQueries([
                  `/v1/core/${kind}/${id}`,
                  `/v1/core/sources/${item.sourceId}`,
                  `/v1/core/${kind}/${id}/deployments`,
                  `/v1/core/${kind}/${id}/releases`,
                ]).then(navigate, navigate);
              });
            }
          }}
        >
          <Select.Trigger>
            <Select.Value className="flex min-w-0 flex-1 items-center overflow-hidden">
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentIcon name={item.environment.name} />
                <span className="truncate">
                  {item.environment.name}
                  {item.environment.disconnectedAt ? " (disconnected)" : ""}
                </span>
              </span>
            </Select.Value>
            {isSwitching ? (
              <Spinner
                aria-label="Switching environment"
                color="current"
                size="sm"
              />
            ) : (
              <Select.Indicator />
            )}
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {instances.map((instance) => {
                const label = `${instance.environment.name}${instance.environment.disconnectedAt ? " (disconnected)" : ""}`;
                return (
                  <ListBox.Item
                    id={instance.id}
                    key={instance.id}
                    textValue={label}
                  >
                    <EnvironmentIcon name={instance.environment.name} />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                );
              })}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
    </SecondarySection>
  );
}
