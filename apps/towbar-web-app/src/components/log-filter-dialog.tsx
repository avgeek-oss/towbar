"use client";
import { useId, useState } from "react";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  FunnelIcon,
} from "@hugeicons/core-free-icons";
import { LogSelect, type LogOption } from "./log-select";
import {
  conditionFilters,
  logMatchOptions,
  logMatchNeedsValue,
  type LogCondition,
} from "./log-explorer-model";
import { logFilterSchema } from "@workspace/towbar-web-client";

export function LogFilterDialog({
  conditions,
  fields,
  values,
  match,
  onApply,
  onClose,
}: {
  conditions: LogCondition[];
  fields: LogOption[];
  values: Record<string, LogOption[]>;
  match: "and" | "or";
  onApply: (value: LogCondition[], match: "and" | "or") => void;
  onClose: () => void;
}) {
  const formId = useId();
  const firstCondition = (): LogCondition => ({
    id: crypto.randomUUID(),
    field: fields[0]?.id ?? "",
    value: "",
    operator: "equals",
  });
  const [draft, setDraft] = useState(() =>
    conditions.length ? conditions : fields.length ? [firstCondition()] : [],
  );
  const [combination, setCombination] = useState(match);
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, changes: Partial<LogCondition>) => {
    setError(null);
    setDraft((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  };
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
        className="w-full max-w-6xl data-[entering]:animate-none data-[exiting]:animate-none sm:w-full"
      >
        <Modal.Dialog className="max-w-5xl">
          <Modal.Header>
            <Modal.Heading className="flex items-center gap-2">
              <HugeiconsIcon aria-hidden="true" icon={FunnelIcon} size={20} />
              Filters
            </Modal.Heading>
            <Modal.CloseTrigger aria-label="Close filters" />
          </Modal.Header>
          <Modal.Body>
            <form
              id={formId}
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const parsed = logFilterSchema.safeParse({
                  from: new Date(Date.now() - 1000).toISOString(),
                  to: new Date().toISOString(),
                  ...conditionFilters(draft, combination),
                });
                if (!parsed.success) {
                  setError(
                    parsed.error.issues[0]?.message ??
                      "Check the filter values.",
                  );
                  return;
                }
                onApply(draft, combination);
                onClose();
              }}
            >
              <div className="mb-3 w-full max-w-60">
                <LogSelect
                  label="Match conditions"
                  value={combination}
                  options={[
                    { id: "and", label: "All conditions (AND)" },
                    { id: "or", label: "Any condition (OR)" },
                  ]}
                  onChange={(value) => setCombination(value as "and" | "or")}
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="grid gap-1">
                <div
                  className="hidden grid-cols-[minmax(0,1fr)_minmax(0,.6fr)_minmax(0,1fr)_2.75rem] gap-2 text-xs font-normal text-muted sm:grid"
                  aria-hidden="true"
                >
                  <span>Attribute</span>
                  <span>Match</span>
                  <span>Value</span>
                  <span />
                </div>
                {draft.map((condition, index) => (
                  <div
                    key={condition.id}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,.8fr)_2.75rem] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,.6fr)_minmax(0,1fr)_2.75rem]"
                  >
                    <div className="col-span-2 min-w-0 sm:col-span-1">
                      <LogSelect
                        label={`Attribute ${index + 1}`}
                        hideLabel
                        searchable
                        value={condition.field}
                        options={fields}
                        onChange={(field) =>
                          update(condition.id, {
                            field,
                            value: "",
                            operator: "equals",
                          })
                        }
                      />
                    </div>
                    <div className="col-start-1 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
                      <LogSelect
                        label={`Match ${index + 1}`}
                        hideLabel
                        value={condition.operator}
                        options={logMatchOptions.filter(
                          (option) =>
                            condition.field.startsWith("attribute:") ||
                            [
                              "service",
                              "containerId",
                              "traceId",
                              "spanId",
                            ].includes(condition.field) ||
                            [
                              "equals",
                              "not_equals",
                              "exists",
                              "not_exists",
                            ].includes(option.id),
                        )}
                        onChange={(operator) =>
                          update(condition.id, {
                            operator: operator as LogCondition["operator"],
                            value: "",
                          })
                        }
                      />
                    </div>
                    <div className="col-start-2 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
                      {["equals", "not_equals"].includes(condition.operator) &&
                      values[condition.field]?.length ? (
                        <LogSelect
                          label={`Value ${index + 1}`}
                          hideLabel
                          searchable
                          value={condition.value}
                          options={values[condition.field]!}
                          onChange={(value) => update(condition.id, { value })}
                        />
                      ) : (
                        <Input
                          aria-label={`Value ${index + 1}`}
                          className="w-full min-w-0 text-base sm:text-sm"
                          placeholder={
                            logMatchNeedsValue(condition.operator)
                              ? "Value"
                              : "No value needed"
                          }
                          disabled={!logMatchNeedsValue(condition.operator)}
                          autoComplete="off"
                          spellCheck={false}
                          variant="secondary"
                          value={condition.value}
                          maxLength={512}
                          required
                          onChange={(event) =>
                            update(condition.id, { value: event.target.value })
                          }
                        />
                      )}
                    </div>
                    <Button
                      className="col-start-3 row-span-2 size-9 min-h-9 min-w-9 rounded-lg self-center sm:col-start-auto sm:row-span-1 max-sm:size-11 max-sm:min-h-11 max-sm:min-w-11"
                      variant="danger"
                      isIconOnly
                      aria-label={`Remove condition ${index + 1}`}
                      onPress={() => {
                        setDraft((current) =>
                          current.filter((item) => item.id !== condition.id),
                        );
                        setError(null);
                      }}
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={Delete02Icon}
                        size={18}
                      />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                className="w-fit"
                variant="secondary"
                isDisabled={draft.length >= 8 || !fields.length}
                onPress={() =>
                  setDraft((current) => [...current, firstCondition()])
                }
              >
                <HugeiconsIcon aria-hidden="true" icon={Add01Icon} size={18} />
                Add condition
              </Button>
            </form>
          </Modal.Body>
          <Modal.Footer className="flex-wrap justify-between gap-3">
            <Button
              variant="danger"
              isDisabled={!draft.length}
              onPress={() => {
                setDraft([]);
                setError(null);
              }}
            >
              Clear all filters
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                form={formId}
                isDisabled={draft.some(
                  (item) =>
                    logMatchNeedsValue(item.operator) && !item.value.trim(),
                )}
              >
                Apply
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
