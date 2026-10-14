"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import { Select, ListBox } from "@avgeek-oss/design-system/forms/select";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { api } from "@/lib/api";
import type { CustomMonitoringRange } from "./monitoring-range";
import { ScoutIcon } from "./scout-icons";

type RangeFormValues = {
  start: string;
  end: string;
  startOccurrence: string;
  endOccurrence: string;
  timeZone: string;
  example: string;
};
type Choices = Record<
  "start" | "end",
  Array<{ instant: string; label: string }>
>;

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
  const loadingId = useId();
  const [request] = useState(() => ({ ...initial, retentionDays }));
  const [form, setForm] = useState<RangeFormValues>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    window.addEventListener("towbar:clear-private-data", onClose);
    return () =>
      window.removeEventListener("towbar:clear-private-data", onClose);
  }, [onClose]);
  useEffect(() => {
    let active = true;
    void api
      .post<{ form: RangeFormValues }>(
        "/v1/core/profile/preferences/range",
        request,
      )
      .then((result) => {
        if (active) setForm(result.form);
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
        size="md"
        className="data-[entering]:animate-none data-[exiting]:animate-none"
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
            ) : form ? (
              <RangeForm
                form={form}
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
                {(["start", "end"] as const).map((field) => (
                  <Field key={field}>
                    <FieldLabel htmlFor={`${loadingId}-${field}`} isRequired>
                      {field === "start" ? "Start" : "End"} date and time
                    </FieldLabel>
                    <Input
                      id={`${loadingId}-${field}`}
                      variant="secondary"
                      disabled
                    />
                  </Field>
                ))}
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
  retentionDays,
  onApply,
  onClose,
}: Omit<Props, "initial"> & { form: RangeFormValues }) {
  const id = useId();
  const [values, setValues] = useState({ start: form.start, end: form.end });
  const [occurrences, setOccurrences] = useState<
    Partial<Record<"start" | "end", string>>
  >({ start: form.startOccurrence, end: form.endOccurrence });
  const [choices, setChoices] = useState<Choices>({ start: [], end: [] });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const result = await api.post<{
        range: CustomMonitoringRange | null;
        choices: Choices;
      }>("/v1/core/profile/preferences/range/resolve", {
        start: { value: values.start, occurrence: occurrences.start },
        end: { value: values.end, occurrence: occurrences.end },
        retentionDays,
      });
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
      setError(cause instanceof Error ? cause.message : "Invalid time range");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="grid gap-4" onSubmit={submit}>
      {(["start", "end"] as const).map((field) => (
        <Field key={field}>
          <FieldLabel htmlFor={`${id}-${field}`} isRequired>
            {field === "start" ? "Start" : "End"} date and time
          </FieldLabel>
          <Input
            id={`${id}-${field}`}
            type="text"
            autoComplete="off"
            variant="secondary"
            required
            disabled={busy}
            value={values[field]}
            placeholder={form.example}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setValues((current) => ({
                ...current,
                [field]: event.target.value,
              }));
              setOccurrences((current) => ({ ...current, [field]: undefined }));
              setChoices((current) => ({ ...current, [field]: [] }));
            }}
          />
          {choices[field].length ? (
            <Select
              variant="secondary"
              fullWidth
              isRequired
              aria-label={`${field === "start" ? "Start" : "End"} time occurrence`}
              selectedKey={occurrences[field] ?? null}
              onSelectionChange={(key) => {
                if (typeof key === "string")
                  setOccurrences((current) => ({ ...current, [field]: key }));
              }}
            >
              <Select.Trigger>
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
          ) : null}
        </Field>
      ))}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button type="submit" isPending={busy} isDisabled={busy}>
          <ScoutIcon name="date" />
          Apply range
        </Button>
      </div>
    </form>
  );
}
