"use client";
import { useState } from "react";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { defaultLogColumns } from "./log-explorer-model";
export function LogColumnsDrawer({
  columns,
  selected,
  onApply,
  onClose,
}: {
  columns: { id: string; title: string }[];
  selected: string[];
  onApply: (columns: string[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(selected),
    [search, setSearch] = useState("");
  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-full max-w-md">
          <Drawer.Header>
            <Drawer.Heading>Edit columns</Drawer.Heading>
            <Drawer.CloseTrigger />
          </Drawer.Header>
          <Drawer.Body>
            <div className="grid gap-3">
              <Input
                aria-label="Search columns"
                placeholder="Search columns"
                variant="secondary"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {columns
                .filter((column) =>
                  column.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((column) => (
                  <Checkbox
                    key={column.id}
                    isSelected={draft.includes(column.id)}
                    onChange={(checked) =>
                      setDraft((current) =>
                        checked
                          ? [...current, column.id]
                          : current.filter((id) => id !== column.id),
                      )
                    }
                  >
                    <Checkbox.Content className="min-h-11">
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Label>{column.title}</Label>
                    </Checkbox.Content>
                  </Checkbox>
                ))}
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            <Button
              variant="secondary"
              onPress={() => setDraft(defaultLogColumns)}
            >
              Reset
            </Button>
            <Button
              isDisabled={!draft.length}
              onPress={() => {
                onApply(draft);
                onClose();
              }}
            >
              Apply columns
            </Button>
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
