# Pinned dependency patches

## Glide Data Grid 6.0.3

`@glideapps__glide-data-grid@6.0.3.patch` resets `useDebouncedMemo`'s mounted ref
when its effect starts. Without the reset, React Strict Mode's effect replay
leaves the ref false. The grid then never updates its initially empty
accessibility tree, even though the canvas paints normally.

The patch covers the published ESM and CommonJS builds and their TypeScript
source. It changes no grid APIs. Keep it pinned to 6.0.3; remove it when a verified
upstream version fixes the hook.

Verification in Towbar's development route:

- Open workspace Monitor → Logs with rows available.
- Chromium's accessibility tree must contain a grid, column headers, rows, and
  grid cells after rendering and resizing.
- Focus a record and press Enter to open Log details.
- Confirm the same behavior after Strict Mode's effect cleanup/setup cycle.

The unpatched package produced two canvas nodes and no grid in that check. With
the patch, the grid and cells are exposed and keyboard activation works.
