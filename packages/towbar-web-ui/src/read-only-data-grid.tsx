"use client";

import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  onEndReached?: () => void;
  severityColors?: Record<string, string>;
  leadingHeader?: ReactNode;
  cellIcons?: Record<string, readonly (string | undefined)[]>;
  square?: boolean;
};

export function ReadOnlyDataGrid({
  label,
  columns,
  rows,
  onRowActivated,
  onEndReached,
  severityColors,
  leadingHeader,
  cellIcons,
  square = false,
}: ReadOnlyDataGridProps) {
  const renderedColumns = useMemo(
    () =>
      leadingHeader
        ? [{ id: "__actions", title: "", width: 44 }, ...columns]
        : columns,
    [leadingHeader, columns],
  );
  const container = useRef<HTMLDivElement>(null),
    accent = useRef<HTMLSpanElement>(null),
    muted = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 400 });
  const colors = useRef<Record<string, string>>({});
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
      colors.current = {};
      for (const [key, value] of Object.entries(severityColors ?? {})) {
        const probe = document.createElement("span");
        probe.style.color = value;
        element.append(probe);
        colors.current[key] = color(getComputedStyle(probe).color);
        probe.remove();
      }
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
  }, [severityColors]);
  const getCellContent = useCallback(
    ([column, row]: Item) => {
      const value = rows[row]?.[renderedColumns[column]?.id ?? ""] ?? "";
      return {
        kind: GridCellKind.Text as const,
        data: value,
        displayData: value.replace(/\s+/gu, " ").slice(0, 512),
        allowOverlay: false,
        readonly: true,
        ...((renderedColumns[column]?.id === "severity" && severityColors) ||
        cellIcons?.[renderedColumns[column]?.id ?? ""]
          ? {
              themeOverride: {
                cellHorizontalPadding:
                  renderedColumns[column]?.id === "severity" ? 22 : 34,
              },
            }
          : {}),
      };
    },
    [rows, renderedColumns, severityColors, cellIcons],
  );
  return (
    <div
      ref={container}
      role="region"
      aria-label={label}
      className={`group relative h-[65svh] max-h-[680px] min-h-80 min-w-0 border-border bg-surface text-foreground ${square ? "border-y" : "rounded-2xl border"}`}
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
      {leadingHeader ? (
        <div className="absolute left-0 top-0 z-10 grid size-11 place-items-center bg-surface">
          {leadingHeader}
        </div>
      ) : null}
      {size.width > 0 ? (
        <DataEditor
          width={size.width}
          height={size.height}
          theme={theme}
          columns={renderedColumns}
          rows={rows.length}
          getCellContent={getCellContent}
          getCellsForSelection
          rowHeight={size.width < 640 ? 44 : 36}
          headerHeight={44}
          freezeColumns={leadingHeader ? 1 : 0}
          cellActivationBehavior="double-click"
          drawCell={(args, drawContent) => {
            drawContent();
            const icon =
              cellIcons?.[renderedColumns[args.col]?.id ?? ""]?.[args.row];
            if (icon) {
              const image = args.imageLoader.loadOrGetImage(
                icon,
                args.col,
                args.row,
              );
              if (image)
                args.ctx.drawImage(
                  image,
                  args.rect.x + 9,
                  args.rect.y + (args.rect.height - 16) / 2,
                  16,
                  16,
                );
            }
            if (
              renderedColumns[args.col]?.id === "severity" &&
              severityColors
            ) {
              const color =
                colors.current[rows[args.row]?.severity ?? "unknown"];
              if (!color) return;
              args.ctx.save();
              args.ctx.fillStyle = color;
              args.ctx.beginPath();
              args.ctx.roundRect(
                args.rect.x + 9,
                args.rect.y + (args.rect.height - 16) / 2,
                4,
                16,
                2,
              );
              args.ctx.fill();
              args.ctx.restore();
            }
          }}
          onVisibleRegionChanged={(visible) => {
            if (rows.length && visible.y + visible.height >= rows.length - 5)
              onEndReached?.();
          }}
          rowMarkers="none"
          onCellActivated={([column, row]) => {
            if (!leadingHeader || column > 0) onRowActivated?.(row);
          }}
          onCellClicked={([column, row], event) => {
            if (event.isTouch && (!leadingHeader || column > 0))
              onRowActivated?.(row);
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
