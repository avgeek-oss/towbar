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

type TelegramDestination = {
  id?: string;
  chatId: string;
  messageThreadId: number | null;
  deployments: boolean;
  deploymentFailures: boolean;
  backupsAndRestores: boolean;
  alertsAndIncidents: boolean;
};
type Column = keyof Pick<
  TelegramDestination,
  "backupsAndRestores" | "alertsAndIncidents"
>;

const columns: Array<{ key: Column; label: string }> = [
  { key: "backupsAndRestores", label: "Backup & Restore" },
  { key: "alertsAndIncidents", label: "Incidents" },
];
const endpoint = "/v1/core/notifications/telegram/destinations";
const chatIdPattern = /^-?\d{1,20}$/;
const destinationKey = (
  row: Pick<TelegramDestination, "chatId" | "messageThreadId">,
) => `${row.chatId}:${row.messageThreadId ?? 0}`;
const destinationLabel = (
  row: Pick<TelegramDestination, "chatId" | "messageThreadId">,
) =>
  row.messageThreadId
    ? `chat ${row.chatId}, topic ${row.messageThreadId}`
    : `chat ${row.chatId}`;

export function TelegramNotificationIntegration() {
  const query = useApiQuery<{ destinations: TelegramDestination[] }>(
    endpoint,
    30_000,
  );
  const providers = useApiQuery<{ providers: { telegram: boolean } }>(
    "/v1/core/notifications/providers",
    30_000,
  );
  const [destinations, setDestinations] = useState<
    TelegramDestination[] | null
  >(null);
  const [adding, setAdding] = useState(false);
  const [chatId, setChatId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [addError, setAddError] = useState("");
  const [removing, setRemoving] = useState<TelegramDestination | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [testDestination, setTestDestination] =
    useState<TelegramDestination | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const sendingTestRef = useRef(false);

  useEffect(() => {
    if (query.data && !savingRef.current)
      setDestinations(query.data.destinations);
  }, [query.data]);

  const telegramConfigured = providers.data?.providers.telegram;
  const pageTitle = (
    <PageSelectionTitle
      label="Telegram"
      icon={<NotificationProviderIcon provider="telegram" className="size-6" />}
      actions={
        telegramConfigured && destinations ? (
          <Button
            isDisabled={saving || destinations.length >= 100}
            onPress={() => {
              setChatId("");
              setTopicId("");
              setAddError("");
              setAdding(true);
            }}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={Add01Icon}
              className="size-4"
            />
            Add destination
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

  const persist = async (next: TelegramDestination[]) => {
    if (savingRef.current || !telegramConfigured) return false;
    savingRef.current = true;
    setSaving(true);
    const previous = destinations;
    setDestinations(next);
    try {
      const result = await api.put<{ destinations: TelegramDestination[] }>(
        endpoint,
        {
          destinations: next.map(
            ({
              chatId,
              messageThreadId,
              deployments,
              deploymentFailures,
              backupsAndRestores,
              alertsAndIncidents,
            }) => ({
              chatId,
              messageThreadId,
              deployments,
              deploymentFailures,
              backupsAndRestores,
              alertsAndIncidents,
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
          : "Could not save Telegram destinations.",
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = chatId.trim();
    const normalizedTopic = topicId.trim();
    const messageThreadId = normalizedTopic ? Number(normalizedTopic) : null;
    if (!chatIdPattern.test(normalized)) {
      setAddError("Enter a numeric Telegram chat ID, such as -1001234567890.");
      return;
    }
    if (
      normalizedTopic &&
      (!/^\d+$/u.test(normalizedTopic) ||
        !Number.isInteger(messageThreadId) ||
        messageThreadId! < 1 ||
        messageThreadId! > 2_147_483_647)
    ) {
      setAddError(
        "Enter a positive numeric topic ID, or leave it blank for the main chat.",
      );
      return;
    }
    if (
      destinations.some(
        (row) =>
          destinationKey(row) ===
          destinationKey({ chatId: normalized, messageThreadId }),
      )
    ) {
      setAddError("This chat and topic are already a destination.");
      return;
    }
    if (
      await persist([
        ...destinations,
        {
          chatId: normalized,
          messageThreadId,
          deployments: false,
          deploymentFailures: false,
          backupsAndRestores: false,
          alertsAndIncidents: false,
        },
      ])
    )
      setAdding(false);
  };

  const sendTest = async () => {
    if (sendingTestRef.current || !testDestination) return;
    sendingTestRef.current = true;
    setSendingTest(true);
    try {
      await api.post(`${endpoint}/test`, {
        chatId: testDestination.chatId,
        messageThreadId: testDestination.messageThreadId,
      });
      toast.success(
        `Test notification accepted for ${destinationLabel(testDestination)}`,
      );
      setTestDialogOpen(false);
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "Could not send test Telegram notification.",
      );
      setSendingTest(false);
    } finally {
      sendingTestRef.current = false;
    }
  };

  const tableColumns: ResourceTableColumn<TelegramDestination>[] = [
    {
      key: "chatId",
      header: "Chat ID",
      className: "min-w-36 whitespace-nowrap !py-1.5",
      cell: (row) => row.chatId,
    },
    {
      key: "messageThreadId",
      header: "Topic",
      className: "min-w-28 whitespace-nowrap !py-1.5",
      cell: (row) => row.messageThreadId ?? "Main chat",
    },
    {
      key: "deployments",
      header: "Deployments",
      className: "min-w-64 !py-1.5",
      cell: (row) => (
        <DeploymentNotificationChoice
          name={`telegram-deployments-${row.id ?? destinationKey(row)}`}
          label={destinationLabel(row)}
          disabled={saving}
          value={
            row.deployments ? "all" : row.deploymentFailures ? "failures" : null
          }
          onChange={(value) =>
            void persist(
              destinations.map((item) =>
                destinationKey(item) === destinationKey(row)
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
      cell: (row: TelegramDestination) => (
        <Checkbox
          variant="secondary"
          isSelected={row[key]}
          isDisabled={saving}
          onChange={(checked) =>
            void persist(
              destinations.map((item) =>
                destinationKey(item) === destinationKey(row)
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
              {label} for {destinationLabel(row)}
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
              setTestDestination(row);
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
            onPress={() => setRemoving(row)}
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
        {telegramConfigured ? (
          <ResourceTable
            ariaLabel="Telegram destinations"
            columns={tableColumns}
            items={destinations}
            getRowKey={destinationKey}
            emptyTitle="No Telegram destinations"
            emptyDescription="Add a Telegram chat or topic to receive operational notifications."
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
                    Configure a Telegram bot token in the Towbar runtime and
                    restart Towbar to manage chat destinations.
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            </Widget.Content>
          </Widget>
        )}
      </div>

      <Modal.Backdrop
        isOpen={adding && telegramConfigured}
        onOpenChange={(open) => {
          if (!open && !saving) setAdding(false);
        }}
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Add Telegram destination</Modal.Heading>
              <Modal.CloseTrigger isDisabled={saving} />
            </Modal.Header>
            <Modal.Body>
              <form
                className="content-grid"
                onSubmit={(event) => void addChat(event)}
              >
                <Field>
                  <FieldLabel htmlFor="notification-telegram-chat" isRequired>
                    Chat ID
                  </FieldLabel>
                  <Input
                    id="notification-telegram-chat"
                    placeholder="-1001234567890"
                    value={chatId}
                    onChange={(event) => {
                      setChatId(event.target.value);
                      setAddError("");
                    }}
                    disabled={saving}
                    required
                    variant="secondary"
                  />
                  <FieldDescription>
                    Add the Towbar bot to the chat, then copy its numeric chat
                    ID.
                  </FieldDescription>
                  {addError ? (
                    <p role="alert" className="text-sm text-danger">
                      {addError}
                    </p>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="notification-telegram-topic">
                    Topic ID (optional)
                  </FieldLabel>
                  <Input
                    id="notification-telegram-topic"
                    inputMode="numeric"
                    placeholder="Main chat"
                    value={topicId}
                    onChange={(event) => {
                      setTopicId(event.target.value);
                      setAddError("");
                    }}
                    disabled={saving}
                    variant="secondary"
                  />
                  <FieldDescription>
                    Use a topic ID for a forum topic. Leave this blank to post
                    in the main chat.
                  </FieldDescription>
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
                    {saving ? "Adding…" : "Add destination"}
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
              Send a sample notification to Telegram{" "}
              {testDestination
                ? destinationLabel(testDestination)
                : "destination"}{" "}
              using the bot token configured in the Towbar runtime.
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
                Remove Telegram destination?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              Telegram {removing ? destinationLabel(removing) : "destination"}{" "}
              will no longer receive operational notifications.
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
                      destinations.filter(
                        (row) =>
                          destinationKey(row) !==
                          (removing ? destinationKey(removing) : ""),
                      ),
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
