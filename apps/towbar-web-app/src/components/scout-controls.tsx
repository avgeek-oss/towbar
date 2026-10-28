"use client";
import { ScoutOptionIcon } from "./scout-icons";
import { useId } from "react";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import {
  Field,
  FieldLabel,
  FieldDescription,
} from "@avgeek-oss/design-system/forms/field";
import type {
  ScoutAlertCondition,
  ScoutAlertRuleInput,
  NotificationDestination,
} from "@workspace/towbar-web-client";

export type ScoutRule = ScoutAlertRuleInput & {
  id: string;
  evaluationState: string;
  evaluatedAt: string | null;
  observedValue: number | null;
  httpCheck?: {
    checked_at: string | null;
    state: string;
    status_code: number | null;
    latency_ms: number | null;
    reason: string | null;
  } | null;
};
export type ScoutIncident = {
  id: string;
  ruleId: string;
  ruleName: string;
  condition: ScoutAlertCondition;
  severity: string;
  deployableId: string | null;
  openedAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
  lastValue: number | null;
  lastNotifiedAt: string | null;
};
export type ScoutRulesResponse = {
  canManage: boolean;
  rules: ScoutRule[];
  workloads: Array<{
    id: string;
    name: string;
    sourceId: string;
    kind: string;
    analytics: { httpRequests: boolean; pageviews: boolean };
  }>;
  destinations: NotificationDestination[];
  providers: {
    slack: boolean;
    smtp: boolean;
    webhook: boolean;
  };
};
export const scoutMetrics = [
  { id: "httpRequests", label: "HTTP requests", unit: "requests", factor: 1 },
  { id: "pageviews", label: "Pageviews", unit: "pageviews", factor: 1 },
  {
    id: "httpAvailability",
    label: "Public HTTP endpoint",
    unit: "",
    factor: 1,
  },
  { id: "cpuPercent", label: "CPU usage", unit: "%", factor: 1 },
  { id: "memoryPercent", label: "Memory usage", unit: "%", factor: 1 },
  {
    id: "memoryUsedBytes",
    label: "Memory used",
    unit: "GiB",
    factor: 1024 ** 3,
  },
  { id: "diskPercent", label: "Root disk usage", unit: "%", factor: 1 },
  { id: "dockerDiskPercent", label: "Docker disk usage", unit: "%", factor: 1 },
  { id: "swapUsedBytes", label: "Swap used", unit: "GiB", factor: 1024 ** 3 },
  { id: "load1", label: "Load average (1 minute)", unit: "", factor: 1 },
  { id: "load5", label: "Load average (5 minutes)", unit: "", factor: 1 },
  { id: "load15", label: "Load average (15 minutes)", unit: "", factor: 1 },
  {
    id: "networkRxBytesPerSecond",
    label: "Network received",
    unit: "MiB/s",
    factor: 1024 ** 2,
  },
  {
    id: "networkTxBytesPerSecond",
    label: "Network sent",
    unit: "MiB/s",
    factor: 1024 ** 2,
  },
  {
    id: "diskReadBytesPerSecond",
    label: "Disk read",
    unit: "MiB/s",
    factor: 1024 ** 2,
  },
  {
    id: "diskWriteBytesPerSecond",
    label: "Disk written",
    unit: "MiB/s",
    factor: 1024 ** 2,
  },
  { id: "restarts", label: "Container restarts", unit: "restarts", factor: 1 },
  {
    id: "missingReports",
    label: "No Scout report for",
    unit: "minutes",
    factor: 60,
  },
] as const;
export function metricDefinition(metric: string) {
  return (
    scoutMetrics.find((m) => m.id === metric) ?? {
      id: metric,
      label: metric,
      unit: "",
      factor: 1,
    }
  );
}
export function scoutValue(value: number | null, metric: string) {
  if (metric === "httpAvailability")
    return value === null
      ? "No result"
      : value === 0
        ? "Available"
        : "Unavailable";
  const definition = metricDefinition(metric);
  const unit =
    value === 1 && ["httpRequests", "pageviews"].includes(metric)
      ? definition.unit.slice(0, -1)
      : definition.unit;
  return value === null
    ? "No measurement"
    : `${(value / definition.factor).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit === "%" ? "" : " "}${unit}`.trim();
}
export function conditionDescription(condition: ScoutAlertCondition) {
  const duration = condition.durationSeconds ?? 0;
  const durationText = duration
    ? ` for ${duration / 60} ${duration === 60 ? "minute" : "minutes"}`
    : "";
  if (condition.metric === "httpAvailability")
    return `Endpoint unavailable${durationText}`;
  return `${metricDefinition(condition.metric).label} ${condition.operator === "above" ? "at least" : "at most"} ${scoutValue(condition.threshold, condition.metric)}${["restarts", "httpRequests", "pageviews"].includes(condition.metric) ? ` in ${condition.windowSeconds / 60} ${condition.windowSeconds === 60 ? "minute" : "minutes"}` : durationText}`;
}
export function ScoutSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hideLabel = false,
  required = false,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string; detail?: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  hideLabel?: boolean;
  required?: boolean;
}) {
  const selectedOption = options.find((option) => option.id === value);
  return (
    <Select
      aria-label={label}
      selectedKey={value}
      onSelectionChange={(key) => key !== null && onChange(String(key))}
      variant="secondary"
      isDisabled={disabled}
      isRequired={required}
      className="min-w-0"
    >
      <Label
        isRequired={required}
        className={hideLabel ? "sr-only" : undefined}
      >
        {label}
      </Label>
      <Select.Trigger>
        <Select.Value className="flex min-w-0 flex-1 items-center overflow-hidden">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ScoutOptionIcon value={value} label={label} />
            <span className="truncate">{selectedOption?.label}</span>
            {selectedOption?.detail ? (
              <span className="ml-auto shrink-0 text-muted">
                {selectedOption.detail}
              </span>
            ) : null}
          </span>
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              id={option.id}
              key={option.id}
              textValue={option.label}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 pr-8">
                <ScoutOptionIcon value={option.id} label={label} />
                <span className="truncate">{option.label}</span>
                {option.detail ? (
                  <span className="ml-auto shrink-0 text-muted">
                    {option.detail}
                  </span>
                ) : null}
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
export function ScoutNumber({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  description,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}) {
  const id = useId();
  return (
    <Field className="min-w-0">
      <FieldLabel
        htmlFor={id}
        isRequired
        className="min-w-0 whitespace-nowrap text-foreground"
      >
        {label}
      </FieldLabel>
      <Input
        id={id}
        className="w-full min-w-0"
        type="number"
        required
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? String(value) : ""}
        onChange={(e) =>
          onChange(
            e.currentTarget.value === "" ? NaN : Number(e.currentTarget.value),
          )
        }
        variant="secondary"
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
