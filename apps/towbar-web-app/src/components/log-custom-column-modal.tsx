"use client";
import { useId, useState } from "react";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { ComboBox } from "@avgeek-oss/design-system/pickers/combo-box";
import { ListBox } from "@avgeek-oss/design-system/collections/list-box";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import { validLogColumnPath, type CustomLogColumn } from "./log-explorer-model";
export function LogCustomColumnModal({
  names,
  paths,
  onAdd,
  onClose,
}: {
  names: string[];
  paths: string[];
  onAdd: (column: CustomLogColumn) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [error, setError] = useState<string | null>(null);
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Add custom column</Modal.Heading>
            <Modal.CloseTrigger aria-label="Close custom column" />
          </Modal.Header>
          <Modal.Body>
            <form
              id={formId}
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const title = name.trim(),
                  query = path.trim();
                if (!validLogColumnPath(query)) {
                  setError(
                    "Use a dot-separated field path, such as meta.username.",
                  );
                  return;
                }
                if (
                  names.some(
                    (existing) =>
                      existing.toLocaleLowerCase() ===
                      title.toLocaleLowerCase(),
                  )
                ) {
                  setError("A column with this name already exists.");
                  return;
                }
                onAdd({
                  id: `custom:${crypto.randomUUID()}`,
                  title,
                  path: query,
                  width: 190,
                });
                onClose();
              }}
            >
              <Field>
                <FieldLabel htmlFor={`${formId}-name`}>Column name</FieldLabel>
                <Input
                  id={`${formId}-name`}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  variant="secondary"
                />
              </Field>
              <Field>
                <FieldLabel
                  id={`${formId}-path-label`}
                  htmlFor={`${formId}-path`}
                >
                  Field path
                </FieldLabel>
                <ComboBox
                  aria-labelledby={`${formId}-path-label`}
                  allowsCustomValue
                  isRequired
                  inputValue={path}
                  onInputChange={setPath}
                  selectedKey={paths.includes(path) ? path : null}
                  onSelectionChange={(key) => {
                    if (key !== null) setPath(String(key));
                  }}
                  defaultItems={paths.map((id) => ({ id }))}
                  defaultFilter={(text, query) =>
                    text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
                  }
                  variant="secondary"
                >
                  <ComboBox.InputGroup>
                    <Input
                      id={`${formId}-path`}
                      maxLength={256}
                      placeholder="meta.username"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <ComboBox.Trigger aria-label="Show field paths" />
                  </ComboBox.InputGroup>
                  <ComboBox.Popover>
                    <ListBox className="max-h-60 overflow-y-auto">
                      {(item: { id: string }) => (
                        <ListBox.Item id={item.id} textValue={item.id}>
                          {item.id}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      )}
                    </ListBox>
                  </ComboBox.Popover>
                </ComboBox>
              </Field>
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              isDisabled={!name.trim() || !path.trim()}
            >
              Add column
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
