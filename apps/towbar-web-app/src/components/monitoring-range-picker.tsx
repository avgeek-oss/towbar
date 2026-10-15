"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  parseAbsolute,
  toCalendarDateTime,
  type CalendarDateTime,
} from "@internationalized/date";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { DateTimeRangePicker } from "@avgeek-oss/design-system/patterns/date-time-range-picker";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import { Select, ListBox } from "@avgeek-oss/design-system/forms/select";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import type { DateTimePreferences } from "@workspace/towbar-contracts";
import { api } from "@/lib/api";
import type { CustomMonitoringRange } from "./monitoring-range";
import { ScoutIcon } from "./scout-icons";

type RangeFormValues = {
  start: string;
  end: string;
  startOccurrence: string;
  endOccurrence: string;
  timeZone: string;
};
type Choices = Record<
  "start" | "end",
  Array<{ instant: string; label: string }>
>;
type DateTimeRange = { start: CalendarDateTime; end: CalendarDateTime };
type Props = {
  initial: CustomMonitoringRange;
  retentionDays: number;
  onApply: (range: CustomMonitoringRange) => void;
  onClose: () => void;
};

export function MonitoringRangePicker({
  initial,
  retentionDays,
  onApply,
  onClose,
}: Props) {
  const [request] = useState(() => ({ ...initial, retentionDays }));
  const [data, setData] = useState<{
    form: RangeFormValues;
    preferences: DateTimePreferences;
  }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    window.addEventListener("towbar:clear-private-data", onClose);
    window.addEventListener("towbar:preferences-changed", onClose);
    return () => {
      window.removeEventListener("towbar:clear-private-data", onClose);
      window.removeEventListener("towbar:preferences-changed", onClose);
    };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.post<{ form: RangeFormValues }>(
        "/v1/core/profile/preferences/range",
        request,
      ),
      api.get<{ preferences: DateTimePreferences }>(
        "/v1/core/profile/preferences",
      ),
    ])
      .then(([range, preferences]) => {
        if (active)
          setData({ form: range.form, preferences: preferences.preferences });
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load time range",
          );
      });
    return () => {
      active = false;
    };
  }, [request]);
  return (
    <Modal.Backdrop
      isOpen
      className="data-[entering]:animate-none data-[exiting]:animate-none"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container
        size="lg"
        className="w-full max-w-2xl data-[entering]:animate-none data-[exiting]:animate-none"
      >
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Custom time range</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : data ? (
              <RangeForm
                {...data}
                retentionDays={retentionDays}
                onApply={onApply}
                onClose={onClose}
              />
            ) : (
              <div
                className="grid gap-4"
                aria-busy="true"
                aria-label="Loading time range"
              >
                <DateTimeRangePicker
                  label="Date and time range"
                  locale="en-GB"
                  hourCycle={24}
                  variant="secondary"
                  isDisabled
                />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onPress={onClose}>
                    Cancel
                  </Button>
                  <Button isDisabled>
                    <ScoutIcon name="date" />
                    Apply range
                  </Button>
                </div>
              </div>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function RangeForm({
  form,
  preferences,
  retentionDays,
  onApply,
  onClose,
}: Omit<Props, "initial"> & {
  form: RangeFormValues;
  preferences: DateTimePreferences;
}) {
  const id = useId();
  const local = (instant: string) =>
    toCalendarDateTime(parseAbsolute(instant, form.timeZone));
  const [initial] = useState<DateTimeRange>(() => ({
    start: local(form.startOccurrence),
    end: local(form.endOccurrence),
  }));
  const [limits] = useState(() => ({
    // UTC validation resolves repeated hours and the exact retention cutoff.
    min: local(
      new Date(Date.now() - retentionDays * 86400000).toISOString(),
    ).set({ hour: 0, minute: 0, second: 0, millisecond: 0 }),
    max: local(new Date().toISOString()).set({
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    }),
  }));
  const [value, setValue] = useState<DateTimeRange | null>(initial);
  const [occurrences, setOccurrences] = useState<
    Partial<Record<"start" | "end", string>>
  >({ start: form.startOccurrence, end: form.endOccurrence });
  const [choices, setChoices] = useState<Choices>({ start: [], end: [] });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const invalidate = () => {
      active.current = false;
    };
    window.addEventListener("towbar:clear-private-data", invalidate);
    window.addEventListener("towbar:preferences-changed", invalidate);
    return () => {
      active.current = false;
      window.removeEventListener("towbar:clear-private-data", invalidate);
      window.removeEventListener("towbar:preferences-changed", invalidate);
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      const result = await api.post<{
        range: CustomMonitoringRange | null;
        choices: Choices;
      }>("/v1/core/profile/preferences/range/resolve", {
        start: {
          value:
            value.start.compare(initial.start) === 0
              ? form.start
              : value.start.toString(),
          occurrence: occurrences.start,
        },
        end: {
          value:
            value.end.compare(initial.end) === 0
              ? form.end
              : value.end.toString(),
          occurrence: occurrences.end,
        },
        retentionDays,
      });
      if (!active.current) return;
      if (result.range) {
        onApply(result.range);
        onClose();
      } else {
        setChoices(result.choices);
        setError(
          "This local time occurs twice. Choose which occurrence to use.",
        );
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Invalid time range");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const locale =
    preferences.dateFormat === "year-month-day"
      ? "en-CA-u-ca-gregory"
      : preferences.dateFormat === "month-day-year" ||
          preferences.dateFormat === "short-month-day-year"
        ? "en-US-u-ca-gregory"
        : "en-GB-u-ca-gregory";
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <DateTimeRangePicker
        label="Date and time range"
        locale={locale}
        hourCycle={preferences.timeFormat.startsWith("12") ? 12 : 24}
        granularity={
          preferences.timeFormat.endsWith("seconds") ? "second" : "minute"
        }
        variant="secondary"
        isRequired
        aria-describedby={error ? `${id}-error` : undefined}
        isDisabled={busy}
        value={value}
        minValue={limits.min}
        maxValue={limits.max}
        onChange={(next) => {
          setValue(next);
          setError(undefined);
          for (const field of ["start", "end"] as const) {
            if (!next || !value || next[field].compare(value[field]) !== 0) {
              setOccurrences((current) => ({ ...current, [field]: undefined }));
              setChoices((current) => ({ ...current, [field]: [] }));
            }
          }
        }}
      />
      {(["start", "end"] as const).map((field) =>
        choices[field].length ? (
          <Field key={field}>
            <FieldLabel htmlFor={`${id}-${field}-occurrence`}>
              {field === "start" ? "Start" : "End"} time occurrence
            </FieldLabel>
            <Select
              variant="secondary"
              fullWidth
              isRequired
              isDisabled={busy}
              aria-label={`${field === "start" ? "Start" : "End"} time occurrence`}
              selectedKey={occurrences[field] ?? null}
              onSelectionChange={(key) => {
                if (typeof key === "string")
                  setOccurrences((current) => ({ ...current, [field]: key }));
              }}
            >
              <Select.Trigger id={`${id}-${field}-occurrence`}>
                <Select.Value>
                  {choices[field].find(
                    (choice) => choice.instant === occurrences[field],
                  )?.label ?? "Choose an occurrence"}
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {choices[field].map((choice) => (
                    <ListBox.Item
                      key={choice.instant}
                      id={choice.instant}
                      textValue={choice.label}
                    >
                      {choice.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </Field>
        ) : null,
      )}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button type="submit" isPending={busy} isDisabled={busy || !value}>
          <ScoutIcon name="date" />
          Apply range
        </Button>
      </div>
    </form>
  );
}
