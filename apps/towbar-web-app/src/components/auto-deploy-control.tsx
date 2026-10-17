"use client";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { FloppyDiskIcon } from "@hugeicons/core-free-icons";

import { HugeiconsIcon } from "@hugeicons/react";

import { useState } from "react";
import type { FormEvent } from "react";

import type { AutoDeployControlResponse } from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Switch } from "@avgeek-oss/design-system/forms/switch";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";

import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

type TargetType = "app" | "resource" | "source";

export function AutoDeployControlEditor({
  id,
  onChanged,
  type,
}: {
  id: string;
  onChanged?: () => void;
  type: TargetType;
}) {
  const endpoint = controlEndpoint(type, id);
  const query = useApiQuery<AutoDeployControlResponse>(endpoint);
  const [draftPaused, setPaused] = useState<boolean | null>(null);
  const paused = draftPaused ?? query.data?.autoDeploy.paused ?? false;
  const releaseDraft = useUnsavedChanges(
    draftPaused !== null && paused !== query.data?.autoDeploy.paused,
  );
  const [saving, setSaving] = useState(false);

  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.patch<AutoDeployControlResponse>(endpoint, { paused });
      releaseDraft();
      setPaused(null);
      toast.success(
        paused
          ? "Automatic deployments paused"
          : "Automatic deployments resumed",
      );
      query.refresh();
      onChanged?.();
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "Could not update automatic deployments",
      );
    } finally {
      setSaving(false);
    }
  }

  const inheritedPause =
    type !== "source" &&
    !paused &&
    query.data.autoDeploy.effective.paused &&
    query.data.autoDeploy.effective.scope !== "deployable";

  return (
    <div className="content-grid">
      <form onSubmit={save}>
        <Widget>
          <Widget.Header>
            <Widget.Title help={false}>Auto-deploy</Widget.Title>
          </Widget.Header>
          <Widget.Content className="content-grid">
            <Switch
              isDisabled={!query.data.canManageAutoDeploy}
              isSelected={paused}
              onChange={setPaused}
            >
              <Switch.Content className="min-h-11">
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="grid gap-1">
                  <Label>Pause automatic deployments</Label>
                  <span className="text-xs font-normal text-muted">
                    {inheritedPause
                      ? query.data.autoDeploy.effective.scope === "environment"
                        ? "Automatic deployments are paused for this environment. Ask an Admin to review its branch mapping."
                        : "Automatic deployments are currently paused for the entire Repository."
                      : "Running and queued deployments continue, and manual deployments remain available."}
                  </span>
                </span>
              </Switch.Content>
            </Switch>
            <Button
              className="w-fit"
              isDisabled={
                saving ||
                !query.data.canManageAutoDeploy ||
                paused === query.data.autoDeploy.paused
              }
              type="submit"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={FloppyDiskIcon}
                className="size-4 shrink-0"
              />
              {saving ? "Saving…" : "Save"}
            </Button>
          </Widget.Content>
        </Widget>
      </form>
    </div>
  );
}

function controlEndpoint(type: TargetType, id: string) {
  if (type === "source") return `/v1/core/sources/${id}/auto-deploy-control`;
  return `/v1/core/${type === "app" ? "apps" : "resources"}/${id}/auto-deploy-control`;
}
