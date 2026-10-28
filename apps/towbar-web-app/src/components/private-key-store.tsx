"use client";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  InformationCircleIcon,
  Key01Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { FieldError, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import { Textarea } from "@avgeek-oss/design-system/forms/textarea";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";

import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { ActionButton } from "./page-parts";
import { RelativeTime } from "./last-synced-time";

export type StoredPrivateKey = {
  algorithm: "ed25519" | "rsa" | "other";
  createdAt: string;
  description: string | null;
  generated: boolean;
  id: string;
  name: string;
  publicKey: string | null;
  updatedAt: string;
  usageCount: number;
};

export type PrivateKeyCollection = {
  canManage: boolean;
  privateKeys: StoredPrivateKey[];
};

type PrivateKeyMode = "ed25519" | "rsa" | "manual";

const privateKeysEndpoint = "/v1/core/settings/private-keys";
const addPrivateKeyOption = "__add_private_key__";

function privateKeyType(privateKey: StoredPrivateKey) {
  return privateKey.algorithm === "other"
    ? "Imported"
    : privateKey.algorithm.toUpperCase();
}

function PublicKeyLabel({ htmlFor }: { htmlFor?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <FieldLabel htmlFor={htmlFor}>Public key</FieldLabel>
      <Tooltip>
        <Tooltip.Trigger>
          <Button aria-label="About the public key" isIconOnly variant="ghost">
            <HugeiconsIcon
              aria-hidden="true"
              icon={InformationCircleIcon}
              className="size-4"
            />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content
          className="max-w-64 whitespace-normal break-normal text-xs [overflow-wrap:normal] [word-break:normal]"
          placement="top"
          showArrow
        >
          <Tooltip.Arrow />
          Copy this value to{" "}
          <code className="whitespace-nowrap">~/.ssh/authorized_keys</code> on
          the target server.
        </Tooltip.Content>
      </Tooltip>
    </span>
  );
}

function PrivateKeyModal({
  edit,
  isOpen,
  onCreated,
  onOpenChange,
  onUpdated,
}: {
  edit?: StoredPrivateKey | null;
  isOpen: boolean;
  onCreated?: (privateKey: StoredPrivateKey) => void;
  onOpenChange: (open: boolean) => void;
  onUpdated?: (privateKey: StoredPrivateKey) => void;
}) {
  const draft = useUnsavedForm();
  const nameId = useId();
  const descriptionId = useId();
  const publicKeyId = useId();
  const privateKeyId = useId();
  const [mode, setMode] = useState<PrivateKeyMode>("ed25519");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [materialDirty, setMaterialDirty] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    setName(edit?.name ?? "");
    setDescription(edit?.description ?? "");
    setPublicKey(edit?.publicKey ?? "");
    setPrivateKey("");
    setPrivateKeyVisible(false);
    setMaterialDirty(false);
    setError(undefined);
    setMode(edit ? "manual" : "ed25519");
  }, [edit, isOpen]);

  async function togglePrivateKey() {
    if (privateKeyVisible) {
      setPrivateKeyVisible(false);
      return;
    }
    if (edit && !privateKey) {
      setRevealing(true);
      try {
        const response = await api.get<{ value: string }>(
          `${privateKeysEndpoint}/${edit.id}/reveal`,
        );
        setPrivateKey(response.value);
      } catch (caught) {
        toast.danger(
          caught instanceof Error ? caught.message : "Could not reveal key",
        );
        return;
      } finally {
        setRevealing(false);
      }
    }
    setPrivateKeyVisible(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (edit) {
        const response = await api.patch<{ privateKey: StoredPrivateKey }>(
          `${privateKeysEndpoint}/${edit.id}`,
          {
            description: description.trim() || null,
            name: name.trim(),
            ...(materialDirty
              ? { privateKey, publicKey: publicKey || null }
              : {}),
          },
        );
        toast.success("Private key updated");
        onUpdated?.(response.privateKey);
      } else {
        const response = await api.post<{ privateKey: StoredPrivateKey }>(
          privateKeysEndpoint,
          mode === "manual"
            ? {
                description: description.trim() || null,
                mode: "manual",
                name: name.trim(),
                privateKey,
                publicKey: publicKey.trim() || null,
              }
            : {
                algorithm: mode,
                description: description.trim() || null,
                mode: "generate",
                name: name.trim(),
              },
        );
        toast.success("Private key added");
        onCreated?.(response.privateKey);
      }
      draft.markSaved();
      refreshApiQueries();
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Private key could not be saved",
      );
    } finally {
      setBusy(false);
    }
  }

  const title = edit ? `Edit ${edit.name}` : "Add private key";

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => !busy && onOpenChange(open)}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger isDisabled={busy} />
          </Modal.Header>
          <Modal.Body>
            <form
              {...draft.formProps}
              className="content-grid"
              onSubmit={submit}
            >
              {!edit ? (
                <Select
                  fullWidth
                  isRequired
                  selectedKey={mode}
                  variant="secondary"
                  onSelectionChange={(key) =>
                    key !== null && setMode(String(key) as PrivateKeyMode)
                  }
                >
                  <Label isRequired>Type</Label>
                  <Select.Trigger>
                    <Select.Value>
                      {mode === "ed25519"
                        ? "Generate ED25519"
                        : mode === "rsa"
                          ? "Generate RSA"
                          : "Add manually"}
                    </Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="ed25519" textValue="ED25519">
                        <HugeiconsIcon aria-hidden="true" icon={Key01Icon} />
                        <span>Generate ED25519</span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="rsa" textValue="RSA">
                        <HugeiconsIcon aria-hidden="true" icon={Key01Icon} />
                        <span>Generate RSA</span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="manual" textValue="Manual">
                        <HugeiconsIcon aria-hidden="true" icon={Add01Icon} />
                        <span>Add manually</span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <FieldLabel htmlFor={nameId} isRequired>
                    Name
                  </FieldLabel>
                  <Input
                    id={nameId}
                    autoComplete="off"
                    maxLength={120}
                    required
                    value={name}
                    variant="secondary"
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
                  <Input
                    id={descriptionId}
                    autoComplete="off"
                    maxLength={500}
                    value={description}
                    variant="secondary"
                    onChange={(event) =>
                      setDescription(event.currentTarget.value)
                    }
                  />
                </div>
              </div>

              {edit?.publicKey ? (
                <div className="grid gap-2">
                  <PublicKeyLabel />
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      aria-label="Public key"
                      className="min-w-0 flex-1 font-mono"
                      disabled
                      spellCheck={false}
                      value={edit.publicKey}
                      variant="secondary"
                    />
                    <Button
                      aria-label="Copy public key"
                      isIconOnly
                      variant="ghost"
                      onPress={() => {
                        void navigator.clipboard.writeText(edit.publicKey!);
                        toast.success("Public key copied");
                      }}
                    >
                      <HugeiconsIcon aria-hidden="true" icon={Copy01Icon} />
                    </Button>
                  </div>
                </div>
              ) : mode === "manual" && !edit ? (
                <div className="grid gap-2">
                  <PublicKeyLabel htmlFor={publicKeyId} />
                  <Input
                    id={publicKeyId}
                    autoComplete="off"
                    placeholder="ssh-ed25519 AAAA…"
                    spellCheck={false}
                    value={publicKey}
                    variant="secondary"
                    onChange={(event) =>
                      setPublicKey(event.currentTarget.value)
                    }
                  />
                </div>
              ) : null}

              {edit || mode === "manual" ? (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor={privateKeyId} isRequired={!edit}>
                      Private key
                    </FieldLabel>
                    <Button
                      aria-label={
                        privateKeyVisible
                          ? "Hide private key"
                          : "Show private key"
                      }
                      aria-pressed={privateKeyVisible}
                      isDisabled={busy || revealing}
                      isIconOnly
                      variant="ghost"
                      onPress={() => void togglePrivateKey()}
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={privateKeyVisible ? ViewOffSlashIcon : ViewIcon}
                      />
                    </Button>
                  </div>
                  {!edit || privateKeyVisible ? (
                    <Textarea
                      id={privateKeyId}
                      autoComplete="off"
                      className="w-full font-mono"
                      disabled={busy}
                      minLength={64}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      required={!edit}
                      rows={8}
                      spellCheck={false}
                      style={
                        privateKeyVisible
                          ? undefined
                          : ({ WebkitTextSecurity: "disc" } as CSSProperties)
                      }
                      value={privateKey}
                      variant="secondary"
                      onChange={(event) => {
                        setPrivateKey(event.currentTarget.value);
                        setMaterialDirty(true);
                      }}
                    />
                  ) : (
                    <Input
                      id={privateKeyId}
                      aria-label="Private key is configured"
                      readOnly
                      value="••••••••••••"
                      variant="secondary"
                    />
                  )}
                </div>
              ) : null}

              {error ? <FieldError>{error}</FieldError> : null}
              <div className="flex justify-end gap-2">
                <Button
                  isDisabled={busy}
                  variant="secondary"
                  onPress={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" isDisabled={busy}>
                  {busy ? "Saving…" : edit ? "Update" : "Add private key"}
                </Button>
              </div>
            </form>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function PrivateKeyStore({
  createOpen,
  onCreateOpenChange,
}: {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const query = useApiQuery<PrivateKeyCollection>(privateKeysEndpoint);
  const [editing, setEditing] = useState<StoredPrivateKey | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  const data = query.data;

  const columns: ResourceTableColumn<StoredPrivateKey>[] = [
    {
      key: "name",
      header: "Private key",
      className: "min-w-64",
      cell: (key) => (
        <TableCellStack as="div">
          <span>{key.name}</span>
          {key.description ? (
            <TableCellDescription>{key.description}</TableCellDescription>
          ) : null}
        </TableCellStack>
      ),
    },
    {
      key: "algorithm",
      header: "Type",
      cell: (key) => (
        <TooltipText
          className="inline-flex"
          tooltip={
            key.generated
              ? `${privateKeyType(key)} key generated by Towbar.`
              : `${privateKeyType(key)} key imported manually.`
          }
        >
          <Chip size="sm" color="warning">
            <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
              {key.algorithm === "other"
                ? "Imported"
                : key.algorithm.toUpperCase()}
            </Chip.Label>
          </Chip>
        </TooltipText>
      ),
    },
    {
      key: "servers",
      header: "Servers",
      cell: (key) => (
        <Chip size="sm" color={key.usageCount === 0 ? "default" : "success"}>
          <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
            {key.usageCount === 0
              ? "Not used"
              : `Used in ${key.usageCount} server${key.usageCount === 1 ? "" : "s"}`}
          </Chip.Label>
        </Chip>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      cell: (key) => <RelativeTime label="Updated" value={key.updatedAt} />,
    },
    {
      key: "actions",
      header: "",
      cell: (key) =>
        data.canManage ? (
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onPress={() => {
                setEditing(key);
                setEditOpen(true);
              }}
            >
              <HugeiconsIcon aria-hidden="true" icon={Edit02Icon} />
              Edit
            </Button>
            <Tooltip isDisabled={key.usageCount === 0}>
              <Tooltip.Trigger>
                <span
                  className="inline-flex"
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The delete button is disabled while the key is in use; this wrapper takes focus so keyboard users can reach the tooltip that explains why.
                  tabIndex={key.usageCount > 0 ? 0 : undefined}
                >
                  <ActionButton
                    action={async () => {
                      await api.delete(`${privateKeysEndpoint}/${key.id}`);
                      query.refresh();
                    }}
                    confirm={{
                      title: `Delete ${key.name}?`,
                      description:
                        key.usageCount > 0
                          ? "This key is attached to a server. Detach it before deleting the stored key."
                          : "This permanently deletes the encrypted private key and its public key from Towbar.",
                      actionLabel: "Delete private key",
                    }}
                    isDisabled={key.usageCount > 0}
                    pendingLabel="Deleting…"
                    success="Private key deleted"
                    variant="danger"
                  >
                    <HugeiconsIcon aria-hidden="true" icon={Delete02Icon} />
                    Delete
                  </ActionButton>
                </span>
              </Tooltip.Trigger>
              <Tooltip.Content placement="top" showArrow>
                <Tooltip.Arrow />
                This key is used by {key.usageCount} server
                {key.usageCount === 1 ? "" : "s"}. Detach it before deleting.
              </Tooltip.Content>
            </Tooltip>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <ResourceTable
        ariaLabel="Stored private keys"
        columns={columns}
        emptyDescription="Generate a key or add an existing SSH private key."
        emptyTitle="No private keys yet"
        getRowKey={(key) => key.id}
        items={data.privateKeys}
      />
      <PrivateKeyModal
        edit={editing}
        isOpen={editOpen}
        onOpenChange={setEditOpen}
        onUpdated={() => query.refresh()}
      />
      <PrivateKeyModal
        isOpen={createOpen}
        onCreated={() => query.refresh()}
        onOpenChange={onCreateOpenChange}
      />
    </>
  );
}

export function PrivateKeySelector({
  disabled,
  onCreated,
  onSelectionChange,
  selectedKey,
}: {
  disabled?: boolean;
  onCreated?: (privateKey: StoredPrivateKey) => void;
  onSelectionChange: (privateKeyId: string) => void;
  selectedKey: string | null;
}) {
  const query = useApiQuery<PrivateKeyCollection>(privateKeysEndpoint);
  const [modalOpen, setModalOpen] = useState(false);

  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  const data = query.data;
  const selectedPrivateKey = data.privateKeys.find(
    (privateKey) => privateKey.id === selectedKey,
  );

  return (
    <>
      <Select
        fullWidth
        isDisabled={disabled}
        isRequired
        selectedKey={selectedKey}
        variant="secondary"
        onSelectionChange={(key) => {
          if (key === null) return;
          if (String(key) === addPrivateKeyOption) {
            setModalOpen(true);
            return;
          }
          onSelectionChange(String(key));
        }}
      >
        <Label isRequired>Stored private key</Label>
        <Select.Trigger>
          <Select.Value>
            {selectedPrivateKey
              ? `${selectedPrivateKey.name} (${privateKeyType(selectedPrivateKey)})`
              : undefined}
          </Select.Value>
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {data.privateKeys.map((privateKey) => (
              <ListBox.Item
                id={privateKey.id}
                key={privateKey.id}
                textValue={privateKey.name}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate">{privateKey.name}</span>
                  {privateKey.description ? (
                    <span className="truncate text-xs text-muted">
                      {privateKey.description}
                    </span>
                  ) : null}
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
            {data.canManage ? (
              <ListBox.Item
                id={addPrivateKeyOption}
                textValue="Add private key"
              >
                <HugeiconsIcon aria-hidden="true" icon={Add01Icon} />
                <span>Add private key</span>
              </ListBox.Item>
            ) : null}
          </ListBox>
        </Select.Popover>
      </Select>
      <PrivateKeyModal
        isOpen={modalOpen}
        onCreated={(privateKey) => {
          query.refresh();
          onSelectionChange(privateKey.id);
          onCreated?.(privateKey);
        }}
        onOpenChange={setModalOpen}
      />
    </>
  );
}
