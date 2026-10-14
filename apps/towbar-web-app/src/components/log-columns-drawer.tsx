"use client";
import { useRef, useState, type PointerEvent } from "react";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import {
  defaultLogColumns,
  reorderLogColumns,
  type CustomLogColumn,
} from "./log-explorer-model";
import { LogCustomColumnModal } from "./log-custom-column-modal";
export function LogColumnsDrawer({
  columns,
  selected,
  customColumns,
  onApply,
  onClose,
}: {
  columns: { id: string; title: string }[];
  selected: string[];
  customColumns: CustomLogColumn[];
  onApply: (columns: string[], custom: CustomLogColumn[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(selected),
    [search, setSearch] = useState("");
  const [order, setOrder] = useState(() => [
    ...selected,
    ...columns.map(({ id }) => id).filter((id) => !selected.includes(id)),
  ]);
  const [custom, setCustom] = useState(customColumns),
    [creating, setCreating] = useState(false),
    [dragging, setDragging] = useState<string | null>(null),
    [announcement, setAnnouncement] = useState("");
  const drag = useRef<{
      id: string;
      x: number;
      y: number;
      active: boolean;
    } | null>(null),
    list = useRef<HTMLDivElement>(null);
  const options = [
    ...columns,
    ...custom.filter(
      (column) => !columns.some((existing) => existing.id === column.id),
    ),
  ];
  const move = (from: string, to: string) =>
    setOrder((current) => reorderLogColumns(current, from, to));
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (
      !current ||
      (!current.active &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6)
    )
      return;
    current.active = true;
    setDragging(current.id);
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-log-column]");
    if (
      target &&
      list.current?.contains(target) &&
      target.dataset.logColumn !== current.id
    )
      move(current.id, target.dataset.logColumn!);
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <>
      <Drawer.Backdrop
        isOpen
        onOpenChange={(open) => {
          if (!open && !creating) onClose();
        }}
      >
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-full max-w-2xl">
            <Drawer.Header className="flex flex-row items-center justify-between gap-2 text-left">
              <Drawer.Heading className="min-w-0 shrink-0">
                Edit columns
              </Drawer.Heading>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="secondary"
                  aria-label="Add custom column"
                  onPress={() => setCreating(true)}
                >
                  <HugeiconsIcon icon={Add01Icon} size={18} />
                  <span className="hidden sm:inline">Add custom column</span>
                </Button>
                <Drawer.CloseTrigger
                  className="static shrink-0"
                  aria-label="Close columns"
                />
              </div>
            </Drawer.Header>
            <Drawer.Body>
              <div className="grid gap-2">
                <Input
                  aria-label="Search columns"
                  placeholder="Search columns"
                  variant="secondary"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div
                  ref={list}
                  className="grid gap-0.5"
                  onPointerMove={moveDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
                  onLostPointerCapture={() => {
                    drag.current = null;
                    setDragging(null);
                  }}
                >
                  {order
                    .map((id) => options.find((column) => column.id === id))
                    .filter((column) => column !== undefined)
                    .filter((column) =>
                      column.title
                        .toLocaleLowerCase()
                        .includes(search.toLocaleLowerCase()),
                    )
                    .map((column) => (
                      <div
                        key={column.id}
                        data-log-column={column.id}
                        className={`flex min-w-0 items-center gap-2 rounded-lg ${dragging === column.id ? "bg-surface-secondary" : ""}`}
                      >
                        <Button
                          variant="ghost"
                          isIconOnly
                          className="min-h-11 min-w-11 shrink-0 touch-none cursor-grab active:cursor-grabbing sm:min-h-9 sm:min-w-9"
                          aria-label={`Move ${column.title}`}
                          onKeyDown={(event) => {
                            if (!["ArrowUp", "ArrowDown"].includes(event.key))
                              return;
                            event.preventDefault();
                            const index = order.indexOf(column.id),
                              target =
                                order[
                                  index + (event.key === "ArrowUp" ? -1 : 1)
                                ];
                            if (target) {
                              move(column.id, target);
                              const handle = event.currentTarget;
                              requestAnimationFrame(() => handle.focus());
                              setAnnouncement(
                                `${column.title} moved ${event.key === "ArrowUp" ? "up" : "down"}.`,
                              );
                            }
                          }}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            drag.current = {
                              id: column.id,
                              x: event.clientX,
                              y: event.clientY,
                              active: false,
                            };
                          }}
                        >
                          <HugeiconsIcon
                            icon={DragDropVerticalIcon}
                            size={16}
                          />
                        </Button>
                        <Checkbox
                          className="min-w-0 flex-1"
                          isSelected={draft.includes(column.id)}
                          onChange={(checked) =>
                            setDraft((current) =>
                              checked
                                ? [...current, column.id]
                                : current.filter((id) => id !== column.id),
                            )
                          }
                        >
                          <Checkbox.Content className="min-h-11 w-full sm:min-h-9">
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                            <Label className="min-w-0 truncate">
                              {column.title}
                            </Label>
                          </Checkbox.Content>
                        </Checkbox>
                      </div>
                    ))}
                </div>
                <span className="sr-only" aria-live="polite">
                  {announcement}
                </span>
              </div>
            </Drawer.Body>
            <Drawer.Footer>
              <Button
                variant="secondary"
                onPress={() => {
                  setDraft(defaultLogColumns);
                  setOrder([
                    ...defaultLogColumns,
                    ...options
                      .map(({ id }) => id)
                      .filter((id) => !defaultLogColumns.includes(id)),
                  ]);
                }}
              >
                Reset
              </Button>
              <Button
                isDisabled={!draft.length}
                onPress={() => {
                  onApply(
                    order.filter((id) => draft.includes(id)),
                    custom,
                  );
                  onClose();
                }}
              >
                Apply columns
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
      {creating ? (
        <LogCustomColumnModal
          names={options.map(({ title }) => title)}
          onClose={() => setCreating(false)}
          onAdd={(column) => {
            setCustom((current) => [...current, column]);
            setDraft((current) => [...current, column.id]);
            setOrder((current) => [...current, column.id]);
            setSearch("");
          }}
        />
      ) : null}
    </>
  );
}
