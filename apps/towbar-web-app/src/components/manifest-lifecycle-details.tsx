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
import { GitBranchIcon, GitCommitIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ManifestLifecycleItem } from "@workspace/towbar-contracts";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { EnvironmentChip } from "./environment-chip";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { RelativeTime } from "./last-synced-time";
import { InlineLink } from "./page-parts";

type Declaration = ManifestLifecycleItem["declarations"][number];

export function LifecycleDetails({
  item,
  onClose,
}: {
  item: ManifestLifecycleItem;
  onClose: () => void;
}) {
  const declarations: ResourceTableColumn<Declaration>[] = [
    {
      key: "repository",
      header: "Repository",
      headerClassName: "md:w-1/3",
      className: "whitespace-normal",
      cell: (source) => (
        <TableCellStack className="gap-2">
          <InlineLink
            href={`/repositories/${source.sourceId}`}
            className="inline-flex items-start gap-2 [overflow-wrap:anywhere]"
          >
            <IntegrationProviderLogo provider={source.provider ?? "github"} />
            {source.repository}
          </InlineLink>
          {item.workloads.some(
            (workload) => workload.sourceId === source.sourceId,
          ) ? (
            <Chip className="w-fit">
              <Chip.Label>Current owner</Chip.Label>
            </Chip>
          ) : null}
          <span className="flex flex-wrap items-center gap-2">
            <Chip>
              <Chip.Label className="inline-flex items-center gap-1.5">
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  className="size-3.5"
                  aria-hidden="true"
                />
                {source.branch}
              </Chip.Label>
            </Chip>
            <span className="inline-flex items-center gap-1.5 text-muted">
              <HugeiconsIcon
                icon={GitCommitIcon}
                className="size-3.5"
                aria-hidden="true"
              />
              <TypographyCode title={source.commitSha}>
                {source.commitSha.slice(0, 12)}
              </TypographyCode>
            </span>
          </span>
        </TableCellStack>
      ),
    },
    {
      key: "manifest",
      header: "Manifest file",
      headerClassName: "md:w-1/3",
      className: "whitespace-normal",
      mobileFullWidth: true,
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
      header: "Configuration changes",
      headerClassName: "md:w-1/3",
      className: "whitespace-normal",
      mobileFullWidth: true,
      cell: (source) => (
        <span className="flex flex-wrap gap-1.5">
          {source.changedPaths.length ? (
            source.changedPaths.map((path) => (
              <Chip key={path} color="warning">
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
      mobileFullWidth: true,
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
            <Modal.Heading className="pr-8 break-words">
              {item.manifestId}
            </Modal.Heading>
            <Modal.CloseTrigger />
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
                  title="Existing workload"
                  columns={2}
                >
                  <Attributes.Item label="Workload">
                    <InlineLink href={workload.href}>
                      {workload.name}
                    </InlineLink>
                  </Attributes.Item>
                  <Attributes.Item label="Environment">
                    <EnvironmentChip name={item.environment} />
                  </Attributes.Item>
                  <Attributes.Item label="Current repository">
                    <InlineLink
                      href={`/repositories/${workload.sourceId}`}
                      className="inline-flex items-start gap-2 [overflow-wrap:anywhere]"
                    >
                      <IntegrationProviderLogo
                        provider={workload.provider ?? "github"}
                      />
                      {workload.repository}
                    </InlineLink>
                  </Attributes.Item>
                  <Attributes.Item label="Server">
                    <InlineLink href={`/servers/${workload.serverId}`}>
                      <TypographyCode>{workload.serverIp}</TypographyCode>
                    </InlineLink>
                  </Attributes.Item>
                  <Attributes.Item label="Workload ID" className="col-span-2">
                    <TypographyCode className="break-all">
                      {workload.id}
                    </TypographyCode>
                  </Attributes.Item>
                  {workload.retiredAt ? (
                    <Attributes.Item label="Retired">
                      <RelativeTime
                        value={workload.retiredAt}
                        label="Retired"
                      />
                    </Attributes.Item>
                  ) : null}
                </Attributes>
              ))}
              {item.declarations.length ? (
                <section
                  className="grid min-w-0 gap-2"
                  aria-label="Repository declarations"
                >
                  <TypographyText textRole="supporting">
                    Repository declarations
                  </TypographyText>
                  <ResourceTable
                    ariaLabel="Repository declarations"
                    columns={declarations}
                    items={item.declarations}
                    getRowKey={(source) => source.sourceEnvironmentId}
                    mobileLayout="stacked"
                    tableClassName="w-full md:table-fixed"
                    emptyTitle="No declarations"
                    emptyDescription="No repository currently declares this workload."
                  />
                </section>
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
                    mobileLayout="stacked"
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
            <Button variant="secondary" onPress={onClose}>
              Close
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
