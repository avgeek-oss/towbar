"use client";
import { useState } from "react";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { LogSelect, type LogOption } from "./log-select";
import { conditionFilters, type LogCondition } from "./log-explorer-model";
import { logFilterSchema } from "@workspace/towbar-web-client";

export function LogFilterDialog({
  conditions,
  fields,
  values,
  onApply,
  onClose,
}: {
  conditions: LogCondition[];
  fields: LogOption[];
  values: Record<string, LogOption[]>;
  onApply: (value: LogCondition[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(conditions);
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, changes: Partial<LogCondition>) =>
    setDraft((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Filters</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = logFilterSchema.safeParse({
                from: new Date(Date.now() - 1000).toISOString(),
                to: new Date().toISOString(),
                ...conditionFilters(draft),
              });
              if (!parsed.success) {
                setError(
                  parsed.error.issues[0]?.message ?? "Check the filter values.",
                );
                return;
              }
              onApply(draft);
              onClose();
            }}
          >
            <Modal.Body>
              <div className="grid gap-4">
                {error ? (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                ) : null}
                {draft.map((condition, index) => (
                  <div
                    key={condition.id}
                    className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]"
                  >
                    <LogSelect
                      label={`Attribute ${index + 1}`}
                      searchable
                      value={condition.field}
                      options={fields.filter(
                        (field) =>
                          field.id.startsWith("attribute:") ||
                          !draft.some(
                            (other) =>
                              other.id !== condition.id &&
                              other.field === field.id,
                          ),
                      )}
                      onChange={(field) =>
                        update(condition.id, {
                          field,
                          value: "",
                          operator: "equals",
                        })
                      }
                    />
                    <LogSelect
                      label="Match"
                      value={condition.operator}
                      options={[
                        { id: "equals", label: "Equals" },
                        ...(condition.field.startsWith("attribute:")
                          ? [{ id: "contains", label: "Contains" }]
                          : []),
                      ]}
                      onChange={(operator) =>
                        update(condition.id, {
                          operator: operator as LogCondition["operator"],
                        })
                      }
                    />
                    {values[condition.field]?.length ? (
                      <LogSelect
                        label="Value"
                        searchable
                        value={condition.value}
                        options={values[condition.field]!}
                        onChange={(value) => update(condition.id, { value })}
                      />
                    ) : (
                      <Field>
                        <FieldLabel htmlFor={`log-filter-${condition.id}`}>
                          Value
                        </FieldLabel>
                        <Input
                          id={`log-filter-${condition.id}`}
                          variant="secondary"
                          value={condition.value}
                          maxLength={512}
                          required
                          onChange={(event) =>
                            update(condition.id, { value: event.target.value })
                          }
                        />
                      </Field>
                    )}
                    <Button
                      variant="ghost"
                      isIconOnly
                      aria-label={`Remove filter ${index + 1}`}
                      onPress={() =>
                        setDraft((current) =>
                          current.filter((item) => item.id !== condition.id),
                        )
                      }
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={18} />
                    </Button>
                  </div>
                ))}
                <Button
                  className="w-fit"
                  variant="secondary"
                  isDisabled={draft.length >= 8 || !fields.length}
                  onPress={() =>
                    setDraft((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        field:
                          fields.find(
                            (field) =>
                              field.id.startsWith("attribute:") ||
                              !current.some((item) => item.field === field.id),
                          )?.id ?? fields[0]!.id,
                        value: "",
                        operator: "equals",
                      },
                    ])
                  }
                >
                  <HugeiconsIcon icon={Add01Icon} size={18} />
                  Add filter
                </Button>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onPress={() => setDraft([])}>
                Clear filters
              </Button>
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                isDisabled={draft.some((item) => !item.value.trim())}
              >
                Apply filters
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
