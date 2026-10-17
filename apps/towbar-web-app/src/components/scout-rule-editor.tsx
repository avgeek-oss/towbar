"use client";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { requestNavigation } from "@/lib/unsaved-navigation";
import { ScoutIcon } from "./scout-icons";
import { ScoutHttpEditor } from "./scout-http-editor";
import { useId, useState, type FormEvent } from "react";
import {
  SCOUT_ALERT_DURATIONS_SECONDS,
  scoutAlertPresets,
  scoutAlertRuleSchema,
  type ScoutAlertRuleInput,
} from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import {
  FieldDescription,
  Field,
  FieldLabel,
} from "@avgeek-oss/design-system/forms/field";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { api } from "@/lib/api";
import {
  ScoutNumber,
  ScoutSelect,
  conditionDescription,
  metricDefinition,
  scoutMetrics,
  type ScoutRule,
} from "./scout-controls";

export function ScoutRuleEditor({
  serverId,
  initial,
  deployableId,
  analytics,
  onClose,
  onSaved,
}: {
  serverId: string;
  initial?: ScoutRule;
  deployableId?: string;
  analytics?: { httpRequests: boolean; pageviews: boolean };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ScoutAlertRuleInput>(() =>
    initial
      ? scoutAlertRuleSchema.parse({
          name: initial.name,
          enabled: initial.enabled,
          severity: initial.severity,
          deployableId: deployableId ?? null,
          condition: initial.condition,
        })
      : {
          name: "",
          enabled: true,
          severity: "warning",
          condition: {
            ...scoutAlertPresets.find((p) => p.id === "memory")!.condition,
            durationSeconds: 60,
          },
          deployableId: deployableId ?? null,
        },
  );
  const [original] = useState(() => JSON.stringify(draft));
  const releaseDraft = useUnsavedChanges(JSON.stringify(draft) !== original);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const nameId = useId();
  const definition = metricDefinition(draft.condition.metric);
  const condition = (values: Partial<ScoutAlertRuleInput["condition"]>) => {
    setDraft((old) => ({ ...old, condition: { ...old.condition, ...values } }));
  };
  const isTraffic = ["httpRequests", "pageviews"].includes(
    draft.condition.metric,
  );
  const isCounter = ["missingReports", "restarts", "httpAvailability"].includes(
    draft.condition.metric,
  );
  const hasDuration = ![
    "missingReports",
    "restarts",
    "httpRequests",
    "pageviews",
  ].includes(draft.condition.metric);
  const durationOptions = [
    ...(initial && draft.condition.durationSeconds === 0
      ? [{ id: "0", label: "Immediately" }]
      : []),
    ...SCOUT_ALERT_DURATIONS_SECONDS.map((seconds) => ({
      id: String(seconds),
      label: `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`,
    })),
  ];
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const result = scoutAlertRuleSchema.safeParse(draft);
    if (!result.success) {
      setFieldErrors(
        Object.fromEntries(
          result.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      );
      toast.danger(
        result.error.issues.map((issue) => issue.message).join(". "),
      );
      return;
    }
    setSaving(true);
    setFieldErrors({});
    try {
      const path = `/v1/core/servers/${serverId}/scout-alerts/rules`;
      if (initial) await api.put(`${path}/${initial.id}`, result.data);
      else await api.post(path, result.data);
      toast.success(initial ? "Alert rule updated" : "Alert rule created");
      releaseDraft();
      onSaved();
      onClose();
    } catch (cause) {
      toast.danger(
        cause instanceof Error ? cause.message : "Could not save the rule",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !saving) requestNavigation(onClose);
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>
              {initial ? "Edit alert rule" : "Create alert rule"}
            </Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <form onSubmit={save} className="grid gap-6">
              <Field>
                <FieldLabel htmlFor={nameId} isRequired>
                  Rule name
                </FieldLabel>
                <Input
                  id={nameId}
                  value={draft.name}
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.currentTarget.value })
                  }
                  maxLength={100}
                  required
                  variant="secondary"
                  aria-invalid={Boolean(fieldErrors.name)}
                />
                {fieldErrors.name ? (
                  <p className="text-sm text-danger">{fieldErrors.name}</p>
                ) : null}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <ScoutSelect
                  label="Severity"
                  required
                  value={draft.severity}
                  options={[
                    { id: "warning", label: "Warning" },
                    { id: "critical", label: "Critical" },
                  ]}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      severity: value as "warning" | "critical",
                    })
                  }
                />
              </div>
              <fieldset className="grid gap-4">
                <legend className="mb-4 font-medium">Alert condition</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ScoutSelect
                    label="Metric"
                    required
                    value={draft.condition.metric}
                    options={scoutMetrics
                      .filter((m) =>
                        m.id === "httpRequests" || m.id === "pageviews"
                          ? Boolean(draft.deployableId && analytics?.[m.id]) ||
                            initial?.condition.metric === m.id
                          : true,
                      )
                      .filter(
                        (m) =>
                          !draft.deployableId ||
                          ![
                            "diskPercent",
                            "dockerDiskPercent",
                            "missingReports",
                            "load1",
                            "load5",
                            "load15",
                            "swapUsedBytes",
                            "httpAvailability",
                          ].includes(m.id),
                      )
                      .map((m) => ({ id: m.id, label: m.label }))}
                    onChange={(metric) => {
                      if (metric === "httpAvailability") {
                        condition({
                          metric,
                          threshold: 1,
                          durationSeconds: hasDuration
                            ? draft.condition.durationSeconds
                            : 60,
                          operator: "above",
                          http: {
                            url: "",
                            method: "GET",
                            intervalSeconds: 60,
                            timeoutSeconds: 5,
                            expectedStatusMin: 200,
                            expectedStatusMax: 299,
                            maxRedirects: 0,
                          },
                        });
                        return;
                      }
                      const preset = scoutAlertPresets.find(
                        (p) => p.condition.metric === metric,
                      );
                      condition({
                        http: undefined,
                        ...(preset
                          ? preset.condition
                          : {
                              metric:
                                metric as ScoutAlertRuleInput["condition"]["metric"],
                              threshold: metricDefinition(metric).factor,
                              operator: "above",
                            }),
                        durationSeconds: [
                          "missingReports",
                          "restarts",
                          "httpRequests",
                          "pageviews",
                        ].includes(metric)
                          ? 0
                          : hasDuration
                            ? draft.condition.durationSeconds
                            : 60,
                      });
                    }}
                  />
                  {!isCounter && !isTraffic && !draft.condition.http ? (
                    <ScoutSelect
                      label="Use readings"
                      required
                      value={draft.condition.aggregation}
                      options={[
                        { id: "average", label: "Average" },
                        { id: "peak", label: "Peak" },
                      ]}
                      onChange={(aggregation) =>
                        condition({
                          aggregation: aggregation as "average" | "peak",
                        })
                      }
                    />
                  ) : null}
                </div>
                {draft.condition.http ? (
                  <ScoutHttpEditor
                    value={draft.condition.http}
                    onChange={(http) => condition({ http })}
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ScoutSelect
                      label="Trigger when"
                      required
                      value={draft.condition.operator}
                      options={[
                        { id: "above", label: "At least" },
                        ...(!isCounter
                          ? [{ id: "below", label: "At most" }]
                          : []),
                      ]}
                      onChange={(operator) =>
                        condition({
                          operator: operator as "above" | "below",
                        })
                      }
                    />
                    <ScoutNumber
                      label={`Threshold${definition.unit ? ` (${definition.unit})` : ""}`}
                      value={draft.condition.threshold / definition.factor}
                      onChange={(value) =>
                        condition({ threshold: value * definition.factor })
                      }
                      step={isCounter || isTraffic ? 1 : 0.01}
                    />
                  </div>
                )}
                {hasDuration ? (
                  <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                    <ScoutSelect
                      label="Duration"
                      required
                      value={String(draft.condition.durationSeconds)}
                      options={durationOptions}
                      onChange={(value) =>
                        condition({ durationSeconds: Number(value) })
                      }
                    />
                  </div>
                ) : null}
                {fieldErrors["condition.threshold"] ? (
                  <p className="text-sm text-danger">
                    {fieldErrors["condition.threshold"]}
                  </p>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  {draft.condition.metric === "restarts" || isTraffic ? (
                    <ScoutNumber
                      label="Count within (minutes)"
                      value={draft.condition.windowSeconds / 60}
                      min={1}
                      max={60}
                      onChange={(value) =>
                        condition({ windowSeconds: value * 60 })
                      }
                    />
                  ) : null}
                </div>
              </fieldset>
              <FieldDescription>
                {conditionDescription(draft.condition)}
              </FieldDescription>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  isDisabled={saving}
                  onPress={onClose}
                >
                  Cancel
                </Button>
                <Button type="submit" isDisabled={saving}>
                  <ScoutIcon name={initial ? "save" : "add"} />
                  {saving
                    ? "Saving…"
                    : initial
                      ? "Save changes"
                      : "Create rule"}
                </Button>
              </div>
            </form>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
