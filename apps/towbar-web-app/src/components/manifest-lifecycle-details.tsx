"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { TableCellStack } from "@avgeek-oss/design-system/data-display/table-cell-text";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import {
  TypographyCode,
  TypographyText,
} from "@avgeek-oss/design-system/typography/typography";
import {
  DashboardCircleIcon,
  DatabaseIcon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ManifestLifecycleItem } from "@workspace/towbar-contracts";
import type { App, Resource } from "@workspace/towbar-web-client";
import { ServiceLogo, ResourceLogo } from "./deployable-identity";
import { resourceImageBrand } from "./resource-image-brand";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { EnvironmentChip } from "./environment-chip";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { RelativeTime } from "./last-synced-time";
import { InlineLink } from "./page-parts";

type Declaration = ManifestLifecycleItem["declarations"][number];

export function LifecycleDetails({
  item,
  apps,
  resources,
  onClose,
}: {
  item: ManifestLifecycleItem;
  apps: App[];
  resources: Resource[];
  onClose: () => void;
}) {
  const declarations: ResourceTableColumn<Declaration>[] = [
    {
      key: "repository",
      header: "Repository",
      headerClassName: "w-1/3",
      className: "whitespace-normal",
      cell: (source) => (
        <TableCellStack className="gap-2">
          <InlineLink
            target="_blank"
            href={`/repositories/${source.sourceId}`}
            className="[overflow-wrap:anywhere]"
          >
            <span className="inline-flex min-w-0 items-center gap-2 whitespace-normal">
              <IntegrationProviderLogo provider={source.provider ?? "github"} />
              {source.repository}
            </span>
          </InlineLink>
          <span className="flex flex-wrap items-center gap-2">
            <Chip className="max-w-full w-fit">
              <Chip.Label
                className="inline-flex min-w-0 items-center gap-1.5"
                title={source.branch}
              >
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span className="truncate">{source.branch}</span>
              </Chip.Label>
            </Chip>
            {item.workloads.some(
              (workload) => workload.sourceId === source.sourceId,
            ) ? (
              <Chip className="w-fit">
                <Chip.Label>Current owner</Chip.Label>
              </Chip>
            ) : null}
          </span>
        </TableCellStack>
      ),
    },
    {
      key: "manifest",
      header: "Manifest file",
      headerClassName: "w-1/3",
      className: "whitespace-normal",
      cell: (source) => (
        <TableCellStack>
          {source.manifestFiles?.length ? (
            source.manifestFiles.map((file) => (
              <TypographyCode
                key={file.path}
                className="break-words [overflow-wrap:anywhere]"
              >
                {file.url ? (
                  <InlineExternalLink href={file.url}>
                    {file.path}
                  </InlineExternalLink>
                ) : (
                  file.path
                )}
              </TypographyCode>
            ))
          ) : (
            <TypographyText textRole="supporting">Not recorded</TypographyText>
          )}
        </TableCellStack>
      ),
    },
    {
      key: "changes",
      header: "Changes from current workload",
      headerClassName: "w-1/3",
      className: "whitespace-normal",
      cell: (source) => (
        <span className="flex flex-wrap gap-1.5">
          {source.changedPaths.length ? (
            source.changedPaths.map((path) => (
              <Chip key={path} color="warning" className="max-w-full">
                <Chip.Label className="whitespace-normal break-all">
                  {path}
                </Chip.Label>
              </Chip>
            ))
          ) : (
            <Chip>
              <Chip.Label>No changes</Chip.Label>
            </Chip>
          )}
        </span>
      ),
    },
  ];
  const operations: ResourceTableColumn<
    ManifestLifecycleItem["operations"][number]
  >[] = [
    {
      key: "operation",
      header: "Operation",
      cell: (operation) => (
        <TypographyCode className="break-all whitespace-normal">
          {operation.id}
        </TypographyCode>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (operation) => <StatusBadge status={operation.state} />,
    },
    {
      key: "result",
      header: "Result",
      cell: (operation) =>
        operation.errorMessage ? (
          <TypographyText textRole="supporting" color="danger">
            {operation.errorMessage}
          </TypographyText>
        ) : (
          <TypographyText textRole="supporting">—</TypographyText>
        ),
    },
  ];
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="w-full max-w-4xl sm:w-[calc(100vw-5rem)]">
          <Modal.Header>
            <Modal.Heading className="pr-8 break-words pointer-coarse:pr-12">
              {item.manifestId}
            </Modal.Heading>
            <Modal.CloseTrigger className="pointer-coarse:size-11" />
          </Modal.Header>
          <Modal.Body className="text-foreground">
            <div className="content-grid">
              {item.reason ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description className="text-sm">
                      {item.reason}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
              {item.workloads.map((workload) => (
                <Attributes
                  key={workload.id}
                  variant="card"
                  title={null}
                  aria-label="Workload details"
                  className="[&>[data-slot=widget-header]]:hidden [&>[data-slot=widget-content]]:mt-1.5"
                  columns={2}
                >
                  <Attributes.Item label="Workload" className="content-start">
                    <InlineLink
                      target="_blank"
                      href={workload.href}
                      className="[overflow-wrap:anywhere]"
                    >
                      <span className="inline-flex min-w-0 items-center gap-2 whitespace-normal">
                        <WorkloadLogo
                          kind={workload.kind}
                          app={apps.find((app) => app.id === workload.id)}
                          resource={resources.find(
                            (resource) => resource.id === workload.id,
                          )}
                        />
                        {workload.name}
                      </span>
                    </InlineLink>
                  </Attributes.Item>
                  <Attributes.Item
                    label="Environment"
                    className="content-start"
                  >
                    <EnvironmentChip name={item.environment} />
                  </Attributes.Item>
                  <Attributes.Item
                    label="Current repository"
                    className="content-start"
                  >
                    <InlineLink
                      target="_blank"
                      href={`/repositories/${workload.sourceId}`}
                      className="[overflow-wrap:anywhere]"
                    >
                      <span className="inline-flex min-w-0 items-center gap-2 whitespace-normal">
                        <IntegrationProviderLogo
                          provider={workload.provider ?? "github"}
                        />
                        {workload.repository}
                      </span>
                    </InlineLink>
                  </Attributes.Item>
                  <Attributes.Item label="Server" className="content-start">
                    <InlineLink
                      target="_blank"
                      href={`/servers/${workload.serverId}`}
                    >
                      <TypographyCode>{workload.serverIp}</TypographyCode>
                    </InlineLink>
                  </Attributes.Item>
                  <Attributes.Item
                    label="Workload ID"
                    className="col-span-2 content-start"
                  >
                    <TypographyCode className="min-w-0 break-all">
                      {workload.id}
                    </TypographyCode>
                  </Attributes.Item>
                  {workload.retiredAt ? (
                    <Attributes.Item label="Retired" className="content-start">
                      <RelativeTime
                        value={workload.retiredAt}
                        label="Retired"
                      />
                    </Attributes.Item>
                  ) : null}
                </Attributes>
              ))}
              {item.declarations.length ? (
                <ResourceTable
                  ariaLabel="Repository declarations"
                  columns={declarations}
                  items={item.declarations}
                  getRowKey={(source) => source.sourceEnvironmentId}
                  tableClassName="min-w-[760px] table-fixed"
                  emptyTitle="No declarations"
                  emptyDescription="No repository currently declares this workload."
                />
              ) : null}
              {item.operations.length ? (
                <section
                  className="grid min-w-0 gap-2"
                  aria-label="Removal progress"
                >
                  <TypographyText textRole="supporting">
                    Removal progress
                  </TypographyText>
                  <ResourceTable
                    ariaLabel="Removal progress"
                    columns={operations}
                    items={item.operations}
                    getRowKey={(operation) => operation.id}
                    tableClassName="min-w-[720px]"
                    emptyTitle="No removal operations"
                    emptyDescription="Removal has not been requested."
                  />
                </section>
              ) : null}
              <TypographyText textRole="caption">
                {item.state === "removing"
                  ? "Permanent removal was requested. Inspect cleanup results before reusing this ID."
                  : "The running workload and its data stay in place. Correct Git and sync to resume management."}
              </TypographyText>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              className="pointer-coarse:min-h-11"
              onPress={onClose}
            >
              Close
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function WorkloadLogo({
  kind,
  app,
  resource,
}: {
  kind: string;
  app?: App;
  resource?: Resource;
}) {
  if (app) return <ServiceLogo app={app} size="small" />;
  if (resource)
    return (
      <ResourceLogo
        brand={resourceImageBrand(resource.kind, resource.config.image)}
        size="small"
      />
    );
  return (
    <HugeiconsIcon
      icon={
        ["app", "compose"].includes(kind) ? DashboardCircleIcon : DatabaseIcon
      }
      className="size-6 shrink-0"
      aria-hidden="true"
    />
  );
}
