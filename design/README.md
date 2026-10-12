# Towbar artwork

`Towbar.sketch` is the source document. `exports/` contains its fourteen logo
variants as 1024 × 1024 PNGs and SVGs, plus the SEO page's `OpenGraph` card as a
1200 × 630 PNG. The SVGs preserve the source document's embedded bitmap artwork.

The documentation site uses these exports:

- `towbar_light_transparent.png` → `docs/assets/towbar-logo.png`. The light and
  dark transparent variants are identical in this document.
- `towbar_favicon` → `docs/assets/towbar-favicon.png`, exported at 64 × 64.
- `OpenGraph.png` → `docs/assets/towbar-og.png` and `towbar-open-graph.png`.

`docs/docs.json` uses the logo in both themes and the Open Graph card for Open
Graph and Twitter previews.

Export the logo layers with Sketch's `sketchtool export layers` using their
existing export presets. Export `OpenGraph` as PNG at scale 1, and
`towbar_favicon` as PNG at scale 0.16 for the documentation favicon. Keep the
symbol bounds intact when exporting the transparent logos.
