"use client";
import type { ReactNode } from "react";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Select, ListBox } from "@avgeek-oss/design-system/forms/select";
import { Header } from "@avgeek-oss/design-system/collections/list-box";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
export type LogOption = {
  id: string;
  label: string;
  icon?: ReactNode;
  group?: string;
  searchText?: string;
};
export function LogSelect({
  label,
  value,
  options,
  onChange,
  searchable = false,
  hideLabel = false,
}: {
  label: string;
  value: string;
  options: LogOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  hideLabel?: boolean;
}) {
  const chosen = options.find((option) => option.id === value);
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  const renderItem = (option: LogOption) => (
    <ListBox.Item
      id={option.id}
      key={option.id}
      textValue={option.searchText ?? option.label}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 pr-6">
        {option.icon}
        <span className="truncate">{option.label}</span>
      </span>
      <ListBox.ItemIndicator />
    </ListBox.Item>
  );
  const list = (
    <ListBox
      className="max-h-80 overflow-y-auto"
      renderEmptyState={() => (
        <p className="px-3 py-4 text-sm text-muted">No matching options.</p>
      )}
    >
      {groups.length > 1
        ? groups.map((group) => (
            <ListBox.Section key={group} id={`section:${group || "all"}`}>
              {group ? (
                <Header className="px-2 text-xs text-muted">{group}</Header>
              ) : null}
              {options
                .filter((option) => (option.group ?? "") === group)
                .map(renderItem)}
            </ListBox.Section>
          ))
        : options.map(renderItem)}
    </ListBox>
  );
  return (
    <Select
      aria-label={label}
      selectedKey={value || null}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      variant="secondary"
      className={`min-w-0 ${hideLabel ? "gap-0" : "gap-1"}`}
    >
      <Label
        className={hideLabel ? "sr-only" : "text-xs font-normal text-muted"}
      >
        {label}
      </Label>
      <Select.Trigger>
        <Select.Value className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {chosen?.icon}
          <span className="truncate">{chosen?.label ?? value}</span>
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="max-w-[calc(100vw-2rem)] overflow-hidden">
        {searchable ? (
          <Autocomplete.Filter
            filter={(text, query) =>
              text
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase())
            }
          >
            <SearchField
              aria-label={`Search ${label.toLowerCase()}`}
              variant="secondary"
              className="px-2 pt-2"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input
                  placeholder="Search…"
                  className="text-base sm:text-sm"
                  autoComplete="off"
                  maxLength={200}
                />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            {list}
          </Autocomplete.Filter>
        ) : (
          list
        )}
      </Select.Popover>
    </Select>
  );
}
