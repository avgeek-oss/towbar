"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import {
  TypographyCode,
  TypographyText,
} from "@avgeek-oss/design-system/typography/typography";
import {
  DashboardCircleIcon,
  DatabaseIcon,
  GitBranchIcon,
  GitCommitIcon,
  ServerStack01Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ManifestLifecycleItem } from "@workspace/towbar-contracts";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { EnvironmentIcon } from "./environment-icon";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { RelativeTime } from "./last-synced-time";
import { InlineLink } from "./page-parts";

type Declaration = ManifestLifecycleItem["declarations"][number];
type Workload = ManifestLifecycleItem["workloads"][number];

export function LifecycleDetails({
  item,
  onClose,
}: {
  item: ManifestLifecycleItem;
  onClose: () => void;
}) {
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="w-full max-w-4xl sm:w-[calc(100vw-5rem)]">
          <Modal.Header className="gap-2">
            <TypographyText textRole="caption">
              {item.state === "conflict"
                ? "Manifest conflict"
                : "Retirement details"}
            </TypographyText>
            <Modal.Heading className="pr-8 text-lg break-words">
              {item.manifestId}
            </Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body className="grid gap-6 text-sm text-foreground">
            {item.reason ? (
              <Alert
                status="warning"
                className="rounded-xl bg-warning-soft p-3 shadow-none"
              >
                <Alert.Indicator className="shrink-0 [&_svg]:size-4" />
                <Alert.Content>
                  <Alert.Description className="text-sm leading-relaxed text-foreground">
                    {item.reason}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            {item.workloads.map((workload) => (
              <WorkloadSummary
                key={workload.id}
                workload={workload}
                environment={item.environment}
              />
            ))}
            {item.declarations.length ? (
              <section
                className="grid min-w-0 gap-3"
                aria-label="Repository declarations"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <TypographyText textRole="label" className="text-sm">
                    Repository declarations
                  </TypographyText>
                  <span className="text-xs text-muted">
                    Compared with the current workload
                  </span>
                </div>
                <div className="grid min-w-0 gap-3 md:grid-cols-2">
                  {item.declarations.map((declaration) => (
                    <RepositoryDeclaration
                      key={declaration.sourceEnvironmentId}
                      declaration={declaration}
                      isCurrentOwner={item.workloads.some(
                        (workload) =>
                          workload.sourceId === declaration.sourceId,
                      )}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {item.operations.length ? (
              <section className="grid gap-3" aria-label="Removal progress">
                <TypographyText textRole="label" className="text-sm">
                  Removal progress
                </TypographyText>
                {item.operations.map((operation) => (
                  <div
                    className="grid gap-2 border-b border-separator pb-3 last:border-0 last:pb-0"
                    key={operation.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <StatusBadge status={operation.state} />
                      <code className="break-all text-xs text-muted">
                        {operation.id}
                      </code>
                    </div>
                    {operation.errorMessage ? (
                      <p className="text-danger">{operation.errorMessage}</p>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}
            <p className="border-t border-separator pt-3 text-xs leading-relaxed text-muted">
              {item.state === "removing"
                ? "Permanent removal was requested. Inspect cleanup results before reusing this ID."
                : "The running workload and its data stay in place. Correct Git and sync to resume management."}
            </p>
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

function WorkloadSummary({
  workload,
  environment,
}: {
  workload: Workload;
  environment: string;
}) {
  return (
    <section className="grid min-w-0 gap-3" aria-label="Existing workload">
      <TypographyText textRole="label" className="text-sm">
        Existing workload
      </TypographyText>
      <div className="grid min-w-0 gap-x-8 gap-y-3 md:grid-cols-2 md:gap-y-0">
        <Attributes variant="embedded">
          <Attributes.Item label="Workload">
            <InlineLink
              href={workload.href}
              className="inline-flex items-center gap-2 text-foreground"
            >
              <HugeiconsIcon
                icon={
                  ["app", "compose"].includes(workload.kind)
                    ? DashboardCircleIcon
                    : DatabaseIcon
                }
                className="size-4 shrink-0 text-muted"
                aria-hidden="true"
              />
              {workload.name}
            </InlineLink>
          </Attributes.Item>
          <Attributes.Item
            label="Workload ID"
            className="items-start [&_dt]:shrink-0"
          >
            <code className="block break-all text-xs leading-5 text-foreground">
              {workload.id}
            </code>
          </Attributes.Item>
        </Attributes>
        <Attributes variant="embedded">
          <Attributes.Item label="Environment">
            <span className="inline-flex items-center gap-2 text-foreground">
              <EnvironmentIcon name={environment} />
              {environment}
            </span>
          </Attributes.Item>
          <Attributes.Item label="Server">
            <InlineLink
              href={`/servers/${workload.serverId}`}
              className="inline-flex items-center gap-2 text-foreground"
            >
              <HugeiconsIcon
                icon={ServerStack01Icon}
                className="size-4 shrink-0 text-muted"
                aria-hidden="true"
              />
              <TypographyCode>{workload.serverIp}</TypographyCode>
            </InlineLink>
          </Attributes.Item>
        </Attributes>
      </div>
      {workload.retiredAt ? (
        <span className="text-xs text-muted">
          <RelativeTime
            display="relative"
            label="Retired"
            value={workload.retiredAt}
          />
        </span>
      ) : null}
    </section>
  );
}

function RepositoryDeclaration({
  declaration,
  isCurrentOwner,
}: {
  declaration: Declaration;
  isCurrentOwner: boolean;
}) {
  return (
    <section
      className="grid min-w-0 content-start gap-4 rounded-xl bg-surface-secondary p-4"
      aria-label={declaration.repository}
    >
      <div className="grid min-w-0 gap-2">
        <span className="text-xs text-muted">
          {isCurrentOwner ? "Current repository" : "Competing repository"}
        </span>
        <InlineLink
          href={`/repositories/${declaration.sourceId}`}
          className="inline-flex min-w-0 items-start gap-2 font-medium text-foreground [overflow-wrap:anywhere]"
        >
          <IntegrationProviderLogo
            provider={declaration.provider ?? "github"}
            className="mt-0.5"
          />
          {declaration.repository}
        </InlineLink>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <HugeiconsIcon
              icon={GitBranchIcon}
              className="size-3.5"
              aria-hidden="true"
            />
            {declaration.branch}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <HugeiconsIcon
              icon={GitCommitIcon}
              className="size-3.5"
              aria-hidden="true"
            />
            <code>{declaration.commitSha.slice(0, 12)}</code>
          </span>
        </div>
      </div>
      {declaration.manifestFiles?.length ? (
        <div className="grid min-w-0 gap-2">
          <span className="text-xs text-muted">Manifest file</span>
          {declaration.manifestFiles.map((file) => (
            <div className="flex min-w-0 items-start gap-2" key={file.path}>
              <HugeiconsIcon
                icon={SourceCodeIcon}
                className="mt-0.5 size-4 shrink-0 text-muted"
                aria-hidden="true"
              />
              <span className="min-w-0 font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere]">
                {file.url ? (
                  <InlineExternalLink
                    href={file.url}
                    className="text-foreground"
                  >
                    {file.path}
                  </InlineExternalLink>
                ) : (
                  file.path
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid gap-2 border-t border-separator pt-3">
        <span className="text-xs text-muted">Configuration changes</span>
        {declaration.changedPaths.length ? (
          <div className="flex flex-wrap gap-1.5">
            {declaration.changedPaths.map((path) => (
              <Chip key={path} variant="soft" color="warning">
                <Chip.Label>
                  <code className="break-all text-xs">{path}</code>
                </Chip.Label>
              </Chip>
            ))}
          </div>
        ) : (
          <span className="text-sm text-foreground">
            Matches the current configuration
          </span>
        )}
      </div>
    </section>
  );
}
