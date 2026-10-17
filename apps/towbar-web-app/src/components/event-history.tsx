"use client";
import { usePageQuery } from "@/hooks/use-page-query";
import { useUrlCursorPagination } from "@/hooks/use-url-pagination";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Select, ListBox } from "@avgeek-oss/design-system/forms/select";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { useApiQuery } from "@/hooks/use-api-query";
import { CodeBlock } from "@avgeek-oss/design-system/typography/code-block";

export type HistoryCursor = { before: string; beforeId: string } | null;
export type HistoryResponse<T> = { items: T[]; nextCursor: HistoryCursor };
export function useEventHistory<T>(path: string) {
  const { search, update } = usePageQuery();
  const pagination = useUrlCursorPagination();
  const filterKeys = path.includes("audit-logs")
    ? ["event", "userId", "search"]
    : ["provider", "category", "state", "entityId", "search"];
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const value = search.get(key);
    if (value && value.length <= 200) filters[key] = value;
  }
  const params = new URLSearchParams({ limit: "25", ...filters });
  const query = useApiQuery<HistoryResponse<T>>(
    `${path}?${params}${pagination.suffix}`,
    pagination.page === 1 ? 30_000 : undefined,
    { keepPreviousData: true },
  );
  return {
    query,
    filters,
    page: pagination.page,
    previousLabel: pagination.previousLabel,
    setFilter(key: string, value: string) {
      if (filterKeys.includes(key))
        update({
          [key]: value.slice(0, 200) || null,
          cursors: null,
          cursorsPage: null,
        });
    },
    changePage(page: number) {
      if (query.isPreviousData) return;
      if (page < pagination.page) pagination.previous();
      else if (query.data?.nextCursor) pagination.next(query.data.nextCursor);
    },
  };
}
export function HistoryFilter({
  label,
  value,
  options,
  onChange,
  allIcon,
  searchPlaceholder,
}: {
  label: string;
  value?: string;
  options: {
    id: string;
    label: string;
    icon?: ReactNode;
    searchText?: string;
    trailing?: ReactNode;
    selectedLabel?: string;
    ariaLabel?: string;
  }[];
  onChange: (value: string) => void;
  allIcon?: ReactNode;
  searchPlaceholder?: string;
}) {
  const selected = options.find((option) => option.id === value);
  const selectedIcon = selected?.icon ?? allIcon;
  const list = (
    <ListBox
      className={searchPlaceholder ? "max-h-72 overflow-y-auto" : undefined}
      renderEmptyState={() => (
        <p className="px-3 py-4 text-sm text-muted">
          No matching {label.toLowerCase()}.
        </p>
      )}
    >
      <ListBox.Item
        id="all"
        textValue={`All ${label.toLowerCase()}`}
        className="pr-8!"
      >
        {allIcon ? (
          <span className="shrink-0" aria-hidden="true">
            {allIcon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">All {label.toLowerCase()}</span>
        <ListBox.ItemIndicator />
      </ListBox.Item>
      {options.map((option) => (
        <ListBox.Item
          id={option.id}
          key={option.id}
          textValue={option.searchText ?? option.label}
          aria-label={option.ariaLabel ?? option.label}
          className="pr-8!"
        >
          {option.icon ? (
            <span className="shrink-0" aria-hidden="true">
              {option.icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.trailing ? (
            <span className="shrink-0">{option.trailing}</span>
          ) : null}
          <ListBox.ItemIndicator />
        </ListBox.Item>
      ))}
    </ListBox>
  );
  return (
    <Select
      fullWidth
      variant="secondary"
      selectedKey={value || "all"}
      onSelectionChange={(key) => onChange(key === "all" ? "" : String(key))}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          <span className="flex min-w-0 max-w-full items-center gap-2">
            {selectedIcon ? (
              <span
                className="flex size-4 shrink-0 items-center justify-center leading-none [&>span]:size-4 [&_img]:size-4 [&_svg]:size-4"
                aria-hidden="true"
              >
                {selectedIcon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">
              {selected?.selectedLabel ??
                selected?.label ??
                `All ${label.toLowerCase()}`}
            </span>
          </span>
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover
        className={`w-(--trigger-width) max-w-[calc(100vw-2rem)] ${searchPlaceholder ? "min-w-[min(18rem,calc(100vw-2rem))] overflow-hidden" : ""}`}
      >
        {searchPlaceholder ? (
          <Autocomplete.Filter
            filter={(text, search) =>
              text
                .toLocaleLowerCase()
                .includes(search.trim().toLocaleLowerCase())
            }
          >
            <SearchField
              aria-label={`Search ${label.toLowerCase()}`}
              className="px-2 pt-2"
              variant="secondary"
            >
              <SearchField.Group className="rounded-md">
                <SearchField.SearchIcon />
                <SearchField.Input
                  className="text-base sm:text-sm"
                  placeholder={searchPlaceholder}
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={
                    typeof window !== "undefined" &&
                    window.matchMedia("(pointer: fine)").matches
                  }
                />
                <SearchField.ClearButton
                  aria-label={`Clear ${label.toLowerCase()} search`}
                />
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
export function HistorySearch({
  label,
  placeholder,
  onSearch,
  value: applied = "",
}: {
  label: string;
  placeholder: string;
  onSearch: (value: string) => void;
  value?: string;
}) {
  const [value, setValue] = useState(applied);
  useEffect(() => setValue(applied), [applied]);
  return (
    <form
      className="grid min-w-0 gap-1"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(value.trim());
      }}
    >
      <Label htmlFor="history-search">{label}</Label>
      <div className="flex gap-2">
        <Input
          id="history-search"
          type="search"
          className="min-w-0 flex-1"
          placeholder={placeholder}
          value={value}
          maxLength={200}
          onChange={(event) => {
            setValue(event.target.value);
            if (!event.target.value) onSearch("");
          }}
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </div>
    </form>
  );
}
export function HistoryTable<T extends { id: string }>({
  history,
  columns,
  label,
  emptyDescription,
}: {
  history: ReturnType<typeof useEventHistory<T>>;
  columns: ResourceTableColumn<T>[];
  label: string;
  emptyDescription: string;
}) {
  const { query } = history;
  return (
    <div className="grid min-w-0 gap-4" aria-busy={query.isPreviousData}>
      {query.error ? (
        <QueryError message={query.error} />
      ) : query.data ? (
        <>
          <ResourceTable
            ariaLabel={label}
            columns={columns}
            items={query.data.items}
            getRowKey={(item) => item.id}
            emptyTitle={`No ${label.toLowerCase()} found`}
            emptyDescription={
              Object.keys(history.filters).length
                ? "Try a different search or change the filters."
                : emptyDescription
            }
          />
          {history.page > 1 || query.data.nextCursor ? (
            <Pagination aria-label={`${label} pages`}>
              <Pagination.Content>
                <Pagination.Item>
                  <Pagination.Previous
                    isDisabled={history.page === 1 || query.isPreviousData}
                    onPress={() => history.changePage(history.page - 1)}
                  >
                    {history.previousLabel}
                  </Pagination.Previous>
                </Pagination.Item>
                <Pagination.Summary>Page {history.page}</Pagination.Summary>
                <Pagination.Item>
                  <Pagination.Next
                    isDisabled={!query.data.nextCursor || query.isPreviousData}
                    onPress={() => history.changePage(history.page + 1)}
                  >
                    Next
                  </Pagination.Next>
                </Pagination.Item>
              </Pagination.Content>
            </Pagination>
          ) : null}
        </>
      ) : (
        <QueryLoading />
      )}
    </div>
  );
}
export function EventDetails({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">{children}</dl>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => onOpenChange(false)}>
              Close
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
export function EventDetail({
  label,
  value,
  copy = false,
}: {
  label: string;
  value: ReactNode;
  copy?: boolean;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2 text-sm text-foreground">
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {value ?? "—"}
        </span>
        {copy && typeof value === "string" ? (
          <CodeBlock.CopyButton
            code={value}
            aria-label={`Copy ${label.toLowerCase()}`}
          />
        ) : null}
      </dd>
    </div>
  );
}
