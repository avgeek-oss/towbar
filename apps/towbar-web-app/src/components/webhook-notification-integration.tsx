"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { TestTube01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";

import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { NotificationProviderIcon } from "./notification-provider-icon";
import { PageSelectionTitle } from "./page-selection-title";
import { DeploymentNotificationChoice } from "./deployment-notification-choice";

type WebhookDestination = {
  routeId: string;
  label: string;
  hostname: string;
  deployments: boolean;
  deploymentFailures: boolean;
  backupsAndRestores: boolean;
  alertsAndIncidents: boolean;
};
type Column = keyof Pick<
  WebhookDestination,
  "backupsAndRestores" | "alertsAndIncidents"
>;

const columns: Array<{ key: Column; label: string }> = [
  { key: "backupsAndRestores", label: "Backup & Restore" },
  { key: "alertsAndIncidents", label: "Incidents" },
];
const endpoint = "/v1/core/notifications/webhook/destinations";

export function WebhookNotificationIntegration() {
  const query = useApiQuery<{ destinations: WebhookDestination[] }>(
    endpoint,
    30_000,
  );
  const providers = useApiQuery<{ providers: { webhook: boolean } }>(
    "/v1/core/notifications/providers",
    30_000,
  );
  const [destinations, setDestinations] = useState<WebhookDestination[] | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [testRouteId, setTestRouteId] = useState("");
  const [testLabel, setTestLabel] = useState("");
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const sendingTestRef = useRef(false);

  useEffect(() => {
    if (query.data && !savingRef.current)
      setDestinations(query.data.destinations);
  }, [query.data]);

  const webhookConfigured = providers.data?.providers.webhook;
  const pageTitle = (
    <PageSelectionTitle
      label="Webhook push"
      icon={<NotificationProviderIcon provider="webhook" className="size-6" />}
    />
  );

  if (query.error || providers.error)
    return (
      <>
        {pageTitle}
        <QueryError message={query.error ?? providers.error!} />
      </>
    );
  if (!query.data || !providers.data || !destinations)
    return (
      <>
        {pageTitle}
        <QueryLoading />
      </>
    );

  const persist = async (next: WebhookDestination[]) => {
    if (savingRef.current || !webhookConfigured) return;
    savingRef.current = true;
    setSaving(true);
    const previous = destinations;
    setDestinations(next);
    try {
      const result = await api.put<{ destinations: WebhookDestination[] }>(
        endpoint,
        { destinations: next },
      );
      setDestinations(result.destinations);
      query.refresh();
    } catch (error) {
      setDestinations(previous);
      toast.danger(
        error instanceof Error
          ? error.message
          : "Could not save Webhook destinations.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (sendingTestRef.current || !testRouteId) return;
    sendingTestRef.current = true;
    setSendingTest(true);
    try {
      await api.post(`${endpoint}/test`, { routeId: testRouteId });
      toast.success(`Test notification accepted for ${testRouteId}`);
      setTestDialogOpen(false);
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "Could not send test Webhook notification.",
      );
      setSendingTest(false);
    } finally {
      sendingTestRef.current = false;
    }
  };

  const tableColumns: ResourceTableColumn<WebhookDestination>[] = [
    {
      key: "label",
      header: "Endpoint",
      className: "min-w-48 !py-1.5",
      cell: (row) => (
        <div className="grid min-w-0">
          <span className="truncate">{row.label}</span>
          <span className="truncate text-xs text-muted">
            {row.hostname}/...
          </span>
        </div>
      ),
    },
    {
      key: "deployments",
      header: "Deployments",
      className: "min-w-64 !py-1.5",
      cell: (row) => (
        <DeploymentNotificationChoice
          name={`webhook-deployments-${row.routeId}`}
          label={row.label}
          disabled={saving}
          value={
            row.deployments ? "all" : row.deploymentFailures ? "failures" : null
          }
          onChange={(value) =>
            void persist(
              destinations.map((item) =>
                item.routeId === row.routeId
                  ? {
                      ...item,
                      deployments: value === "all",
                      deploymentFailures: value === "failures",
                    }
                  : item,
              ),
            )
          }
        />
      ),
    },
    ...columns.map(({ key, label }) => ({
      key,
      header: label,
      headerClassName: "whitespace-nowrap text-left",
      className: "min-w-36 text-left !py-1.5",
      cell: (row: WebhookDestination) => (
        <Checkbox
          variant="secondary"
          isSelected={row[key]}
          isDisabled={saving}
          onChange={(checked) =>
            void persist(
              destinations.map((item) =>
                item.routeId === row.routeId
                  ? { ...item, [key]: checked }
                  : item,
              ),
            )
          }
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Label className="sr-only">
              {label} for endpoint {row.label}
            </Label>
          </Checkbox.Content>
        </Checkbox>
      ),
    })),
    {
      key: "actions",
      header: "",
      className: "whitespace-nowrap text-right !py-1.5",
      cell: (row) => (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            isDisabled={saving}
            onPress={() => {
              setTestRouteId(row.routeId);
              setTestLabel(row.label);
              setSendingTest(false);
              setTestDialogOpen(true);
            }}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={TestTube01Icon}
              className="size-4"
            />
            Test
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {pageTitle}
      <div className="content-grid">
        {webhookConfigured ? (
          <ResourceTable
            ariaLabel="Webhook destinations"
            columns={tableColumns}
            items={destinations}
            getRowKey={(row) => row.routeId}
            emptyTitle="No webhook endpoints"
            emptyDescription="Add an endpoint to the Towbar runtime to manage its subscriptions here."
            tableClassName="[&_.table__column]:py-2"
          />
        ) : (
          <Widget>
            <Widget.Content className="p-0">
              <EmptyState>
                <EmptyState.Media>
                  <Image
                    src="/mascots/missing-configuration.webp"
                    alt=""
                    width={160}
                    height={160}
                    className="size-32 object-contain"
                  />
                </EmptyState.Media>
                <EmptyState.Header>
                  <EmptyState.Title>
                    Credentials are not configured yet.
                  </EmptyState.Title>
                  <EmptyState.Description>
                    Add a webhook endpoint to the Towbar runtime and restart
                    Towbar to manage its subscriptions.
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            </Widget.Content>
          </Widget>
        )}
      </div>

      <AlertDialog.Backdrop
        isOpen={testDialogOpen}
        onOpenChange={(open) => {
          if (!open && !sendingTest) setTestDialogOpen(false);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>
                Send a test notification?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              A sample notification will be sent to webhook endpoint {testLabel}
              .
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                variant="secondary"
                isDisabled={sendingTest}
                onPress={() => setTestDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button isDisabled={sendingTest} onPress={() => void sendTest()}>
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={TestTube01Icon}
                  className="size-4"
                />
                {sendingTest ? "Sending…" : "Send test notification"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
