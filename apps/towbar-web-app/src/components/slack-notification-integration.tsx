"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import {
  Add01Icon,
  Delete02Icon,
  TestTube01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@avgeek-oss/design-system/forms/field";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
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

type SlackDestination = {
  id?: string;
  channelId: string;
  deployments: boolean;
  deploymentFailures: boolean;
  backupsAndRestores: boolean;
  scout: boolean;
};
type Column = keyof Pick<SlackDestination, "backupsAndRestores" | "scout">;

const columns: Array<{ key: Column; label: string }> = [
  { key: "backupsAndRestores", label: "Backup & Restore" },
  { key: "scout", label: "Incidents" },
];
const endpoint = "/v1/core/notifications/slack/destinations";
const channelIdPattern = /^[A-Z][A-Z0-9]{1,79}$/;

export function SlackNotificationIntegration() {
  const query = useApiQuery<{ destinations: SlackDestination[] }>(
    endpoint,
    30_000,
  );
  const providers = useApiQuery<{ providers: { slack: boolean } }>(
    "/v1/core/notifications/providers",
    30_000,
  );
  const [destinations, setDestinations] = useState<SlackDestination[] | null>(
    null,
  );
  const [adding, setAdding] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [addError, setAddError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [testChannelId, setTestChannelId] = useState("");
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const sendingTestRef = useRef(false);

  useEffect(() => {
    if (query.data && !savingRef.current)
      setDestinations(query.data.destinations);
  }, [query.data]);

  const slackConfigured = providers.data?.providers.slack;
  const pageTitle = (
    <PageSelectionTitle
      label="Slack"
      icon={<NotificationProviderIcon provider="slack" className="size-6" />}
      actions={
        slackConfigured && destinations ? (
          <Button
            isDisabled={saving || destinations.length >= 100}
            onPress={() => {
              setChannelId("");
              setAddError("");
              setAdding(true);
            }}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={Add01Icon}
              className="size-4"
            />
            Add channel
          </Button>
        ) : undefined
      }
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

  const persist = async (next: SlackDestination[]) => {
    if (savingRef.current || !slackConfigured) return false;
    savingRef.current = true;
    setSaving(true);
    const previous = destinations;
    setDestinations(next);
    try {
      const result = await api.put<{ destinations: SlackDestination[] }>(
        endpoint,
        {
          destinations: next.map(
            ({
              channelId,
              deployments,
              deploymentFailures,
              backupsAndRestores,
              scout,
            }) => ({
              channelId,
              deployments,
              deploymentFailures,
              backupsAndRestores,
              scout,
            }),
          ),
        },
      );
      setDestinations(result.destinations);
      query.refresh();
      return true;
    } catch (error) {
      setDestinations(previous);
      toast.danger(
        error instanceof Error
          ? error.message
          : "Could not save Slack destinations.",
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addChannel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = channelId.trim().toUpperCase();
    if (!channelIdPattern.test(normalized)) {
      setAddError("Enter a valid Slack channel ID, such as C12345678.");
      return;
    }
    if (destinations.some((row) => row.channelId === normalized)) {
      setAddError("This channel is already a destination.");
      return;
    }
    if (
      await persist([
        ...destinations,
        {
          channelId: normalized,
          deployments: true,
          deploymentFailures: false,
          backupsAndRestores: true,
          scout: true,
        },
      ])
    )
      setAdding(false);
  };

  const sendTest = async () => {
    if (sendingTestRef.current || !testChannelId) return;
    sendingTestRef.current = true;
    setSendingTest(true);
    try {
      await api.post(`${endpoint}/test`, { channelId: testChannelId });
      toast.success(`Test notification accepted for ${testChannelId}`);
      setTestDialogOpen(false);
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "Could not send test Slack notification.",
      );
      setSendingTest(false);
    } finally {
      sendingTestRef.current = false;
    }
  };

  const tableColumns: ResourceTableColumn<SlackDestination>[] = [
    {
      key: "channelId",
      header: "Channel ID",
      className: "min-w-36 whitespace-nowrap !py-1.5",
      cell: (row) => row.channelId,
    },
    {
      key: "deployments",
      header: "Deployments",
      className: "min-w-64 !py-1.5",
      cell: (row) => (
        <DeploymentNotificationChoice
          name={`slack-deployments-${row.id ?? row.channelId}`}
          label={row.channelId}
          disabled={saving}
          value={
            row.deployments ? "all" : row.deploymentFailures ? "failures" : null
          }
          onChange={(value) =>
            void persist(
              destinations.map((item) =>
                item.channelId === row.channelId
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
      cell: (row: SlackDestination) => (
        <Checkbox
          variant="secondary"
          isSelected={row[key]}
          isDisabled={saving}
          onChange={(checked) =>
            void persist(
              destinations.map((item) =>
                item.channelId === row.channelId
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
              {label} for {row.channelId}
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
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={saving}
            onPress={() => {
              setTestChannelId(row.channelId);
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
          <Button
            variant="danger"
            isDisabled={saving}
            onPress={() => setRemoving(row.channelId)}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={Delete02Icon}
              className="size-4"
            />
            Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {pageTitle}
      <div className="content-grid">
        {slackConfigured ? (
          <ResourceTable
            ariaLabel="Slack destinations"
            columns={tableColumns}
            items={destinations}
            getRowKey={(row) => row.channelId}
            emptyTitle="No Slack destinations"
            emptyDescription="Add a Slack channel to receive operational notifications."
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
                    Configure a Slack bot token in the Towbar runtime and
                    restart Towbar to manage channel destinations.
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            </Widget.Content>
          </Widget>
        )}
      </div>

      <Modal.Backdrop
        isOpen={adding && slackConfigured}
        onOpenChange={(open) => {
          if (!open && !saving) setAdding(false);
        }}
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Add Slack channel</Modal.Heading>
              <Modal.CloseTrigger isDisabled={saving} />
            </Modal.Header>
            <Modal.Body>
              <form
                className="content-grid"
                onSubmit={(event) => void addChannel(event)}
              >
                <Field>
                  <FieldLabel htmlFor="notification-slack-channel" isRequired>
                    Channel ID
                  </FieldLabel>
                  <Input
                    id="notification-slack-channel"
                    placeholder="C12345678"
                    value={channelId}
                    onChange={(event) => {
                      setChannelId(event.target.value);
                      setAddError("");
                    }}
                    disabled={saving}
                    required
                    variant="secondary"
                  />
                  <FieldDescription>
                    Invite the Towbar bot to the channel, then copy its channel
                    ID from Slack.
                  </FieldDescription>
                  {addError ? (
                    <p role="alert" className="text-sm text-danger">
                      {addError}
                    </p>
                  ) : null}
                </Field>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    isDisabled={saving}
                    onPress={() => setAdding(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" isDisabled={saving}>
                    {saving ? "Adding…" : "Add channel"}
                  </Button>
                </div>
              </form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

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
              Send a sample notification to Slack channel {testChannelId} using
              the bot token configured in the Towbar runtime.
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

      <AlertDialog.Backdrop
        isOpen={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !saving) setRemoving(null);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>
                Remove Slack destination?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              Channel {removing} will no longer receive operational
              notifications.
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                variant="secondary"
                isDisabled={saving}
                onPress={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                isDisabled={saving}
                onPress={async () => {
                  if (
                    await persist(
                      destinations.filter((row) => row.channelId !== removing),
                    )
                  )
                    setRemoving(null);
                }}
              >
                {saving ? "Removing…" : "Remove"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
