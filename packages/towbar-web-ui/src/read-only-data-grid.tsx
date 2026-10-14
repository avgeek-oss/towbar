"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DataEditor, {
  GridCellKind,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";

export type ReadOnlyDataGridProps = {
  label: string;
  columns: readonly { id: string; title: string; width: number }[];
  rows: readonly Record<string, string>[];
  onRowActivated?: (index: number) => void;
};

export function ReadOnlyDataGrid({
  label,
  columns,
  rows,
  onRowActivated,
}: ReadOnlyDataGridProps) {
  const container = useRef<HTMLDivElement>(null),
    accent = useRef<HTMLSpanElement>(null),
    muted = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 400 });
  const [theme, setTheme] = useState<Partial<Theme>>({});
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: Math.floor(entry.contentRect.width),
          height: Math.floor(entry.contentRect.height),
        });
    });
    resize.observe(element);
    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const color = (value: string) => {
      if (!colorContext) return value;
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = value;
      colorContext.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = colorContext.getImageData(
        0,
        0,
        1,
        1,
      ).data;
      return `rgba(${red}, ${green}, ${blue}, ${(alpha ?? 255) / 255})`;
    };
    const updateTheme = () => {
      const style = getComputedStyle(element),
        accentStyle = getComputedStyle(accent.current!),
        mutedStyle = getComputedStyle(muted.current!);
      setTheme({
        bgCell: color(style.backgroundColor),
        bgHeader: color(style.backgroundColor),
        bgHeaderHasFocus: color(style.backgroundColor),
        bgHeaderHovered: color(style.backgroundColor),
        borderColor: color(style.borderColor),
        horizontalBorderColor: color(style.borderColor),
        textDark: color(style.color),
        textHeader: color(style.color),
        textMedium: color(mutedStyle.color),
        textLight: color(mutedStyle.color),
        accentColor: color(accentStyle.color),
        fontFamily: style.fontFamily,
        baseFontStyle: "14px",
        headerFontStyle: "500 13px",
      });
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    return () => {
      resize.disconnect();
      observer.disconnect();
    };
  }, []);
  const getCellContent = useCallback(
    ([column, row]: Item) => {
      const value = rows[row]?.[columns[column]?.id ?? ""] ?? "";
      return {
        kind: GridCellKind.Text as const,
        data: value,
        displayData: value.replace(/\s+/gu, " ").slice(0, 512),
        allowOverlay: false,
        readonly: true,
      };
    },
    [rows, columns],
  );
  return (
    <div
      ref={container}
      role="region"
      aria-label={label}
      className="relative h-[65svh] max-h-[680px] min-h-80 min-w-0 overflow-hidden rounded-2xl border border-border bg-surface text-foreground"
    >
      <span
        ref={accent}
        className="pointer-events-none absolute opacity-0 text-accent"
        aria-hidden="true"
      >
        .
      </span>
      <span
        ref={muted}
        className="pointer-events-none absolute opacity-0 text-muted"
        aria-hidden="true"
      >
        .
      </span>
      {size.width > 0 ? (
        <DataEditor
          width={size.width}
          height={size.height}
          theme={theme}
          columns={columns}
          rows={rows.length}
          getCellContent={getCellContent}
          getCellsForSelection
          rowHeight={size.width < 640 ? 44 : 36}
          headerHeight={40}
          rowMarkers="none"
          onCellActivated={([_column, row]) => onRowActivated?.(row)}
          onCellClicked={([_column, row], event) => {
            if (event.isTouch) onRowActivated?.(row);
          }}
          onDelete={() => false}
          onPaste={false}
          fillHandle={false}
          smoothScrollX
          smoothScrollY
        />
      ) : null}
    </div>
  );
}
