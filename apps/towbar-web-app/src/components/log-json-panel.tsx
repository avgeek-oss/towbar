"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ColumnInsertIcon,
  Copy01Icon,
  FilterRemoveIcon,
  FunnelIcon,
  Link01Icon,
  MoreHorizontalIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Dropdown } from "@avgeek-oss/design-system/overlays/dropdown";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { CodePanel } from "@workspace/towbar-web-ui/code-panel";
import type { LogRecord } from "@workspace/towbar-web-client";
import type { LogCondition } from "./log-explorer-model";
import {
  logJsonLines,
  logJsonColumnPath,
  logJsonCondition,
  logJsonValue,
  type LogJsonField,
} from "./log-json-model";

type FieldActions = {
  record: LogRecord;
  canFilter: boolean;
  onFilter: (condition: Omit<LogCondition, "id">) => void;
  onColumn: (field: LogJsonField, path: string) => void;
  onSearch: (text: string) => void;
};

export function LogJsonPanel(props: FieldActions) {
  const { code, fields } = useMemo(
    () => logJsonLines(props.record),
    [props.record],
  );
  return (
    <div className="min-w-0">
      <CodePanel
        ariaLabel="Full log JSON"
        language="json"
        renderLine={(content, line) => {
          const field = fields.get(line);
          return field ? (
            <LogJsonLine {...props} field={field}>
              {content}
            </LogJsonLine>
          ) : (
            content
          );
        }}
      >
        {code}
      </CodePanel>
    </div>
  );
}

function LogJsonLine({
  field,
  children,
  ...actions
}: FieldActions & {
  field: LogJsonField;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const pointerAnchor = useRef<HTMLSpanElement>(null);
  const selectedText = useRef("");
  const line = useRef<HTMLSpanElement>(null);
  const path = field.path.join(".");
  const columnPath = logJsonColumnPath(field);
  const condition = logJsonCondition(actions.record, field);
  const excluded = logJsonCondition(actions.record, field, true);
  const text = selectedText.current || logJsonValue(field.value);
  const captureSelection = () => {
    const selection = window.getSelection();
    selectedText.current =
      selection?.anchorNode && line.current?.contains(selection.anchorNode)
        ? selection.toString().trim()
        : "";
  };
  const items = [
    {
      id: "include",
      label: "Add to filters",
      icon: FunnelIcon,
      disabled: !condition || !actions.canFilter,
    },
    {
      id: "column",
      label: "Add as column",
      icon: ColumnInsertIcon,
      disabled: !columnPath,
    },
    {
      id: "exclude",
      label: "Exclude this value",
      icon: FilterRemoveIcon,
      disabled: !excluded || !actions.canFilter,
    },
    { id: "value", label: "Copy value", icon: Copy01Icon },
    { id: "path", label: "Copy field path", icon: Link01Icon },
    {
      id: "search",
      label: "Search selected text",
      icon: Search01Icon,
      disabled: !text || text.length > 512,
    },
  ];
  const act = async (key: string) => {
    if (key === "include" && condition && actions.canFilter)
      actions.onFilter(condition);
    if (key === "exclude" && excluded && actions.canFilter)
      actions.onFilter(excluded);
    if (key === "column" && columnPath) actions.onColumn(field, columnPath);
    if (key === "search" && text && text.length <= 512) actions.onSearch(text);
    if (key === "value" || key === "path") {
      try {
        await navigator.clipboard.writeText(
          key === "value" ? logJsonValue(field.value) : path,
        );
        toast.success(key === "value" ? "Value copied" : "Field path copied");
      } catch {
        toast.danger("Could not copy", {
          description: "Select the text and use your device’s copy command.",
        });
      }
    }
  };
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <span
        ref={line}
        data-log-field={path}
        data-menu-open={open || undefined}
        className="group/log-field relative inline-flex min-w-full items-center rounded-sm align-middle"
        style={
          open
            ? {
                backgroundColor:
                  "color-mix(in oklab, var(--accent) 12%, transparent)",
              }
            : undefined
        }
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          captureSelection();
          const bounds = event.currentTarget.getBoundingClientRect();
          setPointer(
            event.clientX || event.clientY
              ? {
                  x: event.clientX - bounds.left,
                  y: event.clientY - bounds.top,
                }
              : null,
          );
          setOpen(true);
        }}
      >
        <span>{children}</span>
        {pointer ? (
          <span
            ref={pointerAnchor}
            aria-hidden="true"
            className="pointer-events-none absolute size-0"
            style={{ left: pointer.x, top: pointer.y }}
          />
        ) : null}
        <Dropdown.Trigger
          aria-label={`Actions for ${path}`}
          className="ml-2 inline-flex size-5 shrink-0 items-center justify-center rounded p-0 leading-none text-muted opacity-100 hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus [@media(pointer:coarse)]:size-11 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/log-field:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100"
          onPressStart={() => {
            captureSelection();
            setPointer(null);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              captureSelection();
              setPointer(null);
              setOpen(true);
            }
          }}
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={MoreHorizontalIcon}
            size={16}
          />
        </Dropdown.Trigger>
      </span>
      <Dropdown.Popover
        key={pointer ? `${pointer.x}:${pointer.y}` : "trigger"}
        triggerRef={pointer ? pointerAnchor : undefined}
        placement="bottom start"
        offset={pointer ? 0 : 8}
        className="min-w-56"
      >
        <Dropdown.Menu
          aria-label={`Actions for ${path}`}
          onAction={(key) => void act(String(key))}
        >
          {items.map((item) => (
            <Dropdown.Item
              key={item.id}
              id={item.id}
              textValue={item.label}
              isDisabled={item.disabled}
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={item.icon}
                size={18}
                className="shrink-0 text-muted"
              />
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
