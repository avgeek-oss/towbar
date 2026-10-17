"use client";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { ArrowRight01Icon, FloppyDiskIcon } from "@hugeicons/core-free-icons";

import { HugeiconsIcon } from "@hugeicons/react";

import { useRouter } from "@/hooks/use-guarded-router";
import { useState } from "react";
import type { FormEvent } from "react";

import type { Server } from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import {
  FieldDescription,
  Field,
  FieldLabel,
} from "@avgeek-oss/design-system/forms/field";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { toast } from "@avgeek-oss/design-system/overlays/toast";

import { FormCard } from "@/components/page-parts";
import { refreshApiQueries } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { ServerCredentials } from "./credential-editor";

export function ServerEditor({
  canManage = true,
  server,
}: {
  canManage?: boolean;
  server?: Server;
}) {
  const router = useRouter();
  const nameDraft = useUnsavedForm();
  const configDraft = useUnsavedForm();
  const [busy, setBusy] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const editing = Boolean(server);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!server) return;
    const name = String(
      new FormData(event.currentTarget).get("name") ?? "",
    ).trim();
    setSavingName(true);
    try {
      await api.patch(`/v1/core/servers/${server.id}/name`, {
        name: name || null,
      });
      nameDraft.markSaved();
      toast.success("Server name saved");
      refreshApiQueries();
    } catch (error) {
      toast.danger("Couldn't save server name", {
        description:
          error instanceof Error ? error.message : "The request failed",
      });
    } finally {
      setSavingName(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const values = new FormData(event.currentTarget);
    const ip = editing
      ? server!.canonicalIp
      : String(values.get("ip") ?? "").trim();
    const host = editing
      ? (server!.config.ssh.host ?? server!.canonicalIp)
      : String(values.get("sshHost") ?? "").trim();
    const config = {
      buildConcurrency: Number(values.get("buildConcurrency")),
      previewBuildConcurrency: Number(values.get("previewBuildConcurrency")),
      hostLogCollection: server?.config.hostLogCollection === true,
      ip,
      ssh: {
        ...(host && host !== ip ? { host } : {}),
        port: Number(values.get("sshPort")),
        username: String(values.get("sshUsername") ?? "").trim(),
      },
    };
    try {
      const response = editing
        ? await api.patch<{ server: Server }>(
            `/v1/core/servers/${server!.id}`,
            config,
          )
        : await api.post<{ server: Server }>("/v1/core/servers", config);
      configDraft.markSaved();
      toast.success(editing ? "Server settings saved" : "Server added");
      refreshApiQueries();
      if (!editing)
        router.push(`/servers/${response.server.id}?section=settings`);
    } catch (error) {
      toast.danger(editing ? "Couldn't save server" : "Couldn't add server", {
        description:
          error instanceof Error ? error.message : "The request failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content-grid">
      {server ? (
        <FormCard title="Server info">
          <form
            {...nameDraft.formProps}
            className="content-grid"
            onSubmit={saveName}
          >
            <Field className="max-w-md">
              <FieldLabel htmlFor="server-name">Name</FieldLabel>
              <Input
                id="server-name"
                defaultValue={server.name ?? ""}
                disabled={!canManage}
                maxLength={120}
                name="name"
                placeholder="Production database"
                variant="secondary"
              />
              <FieldDescription>
                Optional. A name makes this server easier to find; its IP
                address stays the same.
              </FieldDescription>
            </Field>
            <Button
              className="w-fit"
              isDisabled={savingName || !canManage}
              type="submit"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={FloppyDiskIcon}
                className="size-4 shrink-0"
              />
              {savingName ? "Saving…" : "Save"}
            </Button>
          </form>
        </FormCard>
      ) : null}
      <FormCard
        title={
          editing ? "Connection and capacity" : "Server identity and capacity"
        }
      >
        <form
          {...configDraft.formProps}
          className="content-grid"
          onSubmit={save}
        >
          <div className="content-grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {!editing ? (
              <>
                <Field>
                  <FieldLabel htmlFor="server-ip" isRequired>
                    IP address
                  </FieldLabel>
                  <Input
                    id="server-ip"
                    disabled={!canManage}
                    name="ip"
                    placeholder="203.0.113.10"
                    required
                    variant="secondary"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="server-ssh-host">SSH host</FieldLabel>
                  <Input
                    id="server-ssh-host"
                    disabled={!canManage}
                    name="sshHost"
                    placeholder="Defaults to the IP address"
                    variant="secondary"
                  />
                </Field>
              </>
            ) : null}
            <Field>
              <FieldLabel htmlFor="server-ssh-username" isRequired>
                SSH username
              </FieldLabel>
              <Input
                id="server-ssh-username"
                defaultValue={server?.config.ssh.username ?? "ubuntu"}
                disabled={!canManage}
                name="sshUsername"
                placeholder="ubuntu"
                required
                variant="secondary"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="server-ssh-port" isRequired>
                SSH port
              </FieldLabel>
              <Input
                id="server-ssh-port"
                defaultValue={String(server?.config.ssh.port ?? 22)}
                disabled={!canManage}
                max={65_535}
                min={1}
                name="sshPort"
                required
                type="number"
                variant="secondary"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="server-build-concurrency" isRequired>
                Concurrent builds
              </FieldLabel>
              <Input
                id="server-build-concurrency"
                defaultValue={String(server?.config.buildConcurrency ?? 1)}
                disabled={!canManage}
                max={16}
                min={1}
                name="buildConcurrency"
                required
                type="number"
                variant="secondary"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="server-preview-concurrency" isRequired>
                Concurrent preview builds
              </FieldLabel>
              <Input
                id="server-preview-concurrency"
                defaultValue={String(
                  server?.config.previewBuildConcurrency ?? 1,
                )}
                disabled={!canManage}
                max={4}
                min={1}
                name="previewBuildConcurrency"
                required
                type="number"
                variant="secondary"
              />
            </Field>
          </div>
          <FieldDescription>
            Build concurrency limits simultaneous work on this server. Start
            with 1 until its available CPU and memory are verified.
          </FieldDescription>
          <Button
            className="w-fit"
            isDisabled={busy || !canManage}
            type="submit"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={editing ? FloppyDiskIcon : ArrowRight01Icon}
              className="size-4 shrink-0"
            />
            {busy ? "Saving…" : editing ? "Save" : "Continue to credentials"}
          </Button>
        </form>
      </FormCard>
      {server ? (
        <ServerCredentials canManage={canManage} server={server} />
      ) : null}
    </div>
  );
}
