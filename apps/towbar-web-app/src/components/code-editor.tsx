"use client";

import { useEffect, useRef } from "react";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState } from "@codemirror/state";
import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  hoverTooltip,
  activateHover,
  closeHoverTooltips,
} from "@codemirror/view";
import {
  secretReferenceAt,
  type RevealSecretReference,
} from "@/lib/secret-reference";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

const tokens = new MatchDecorator({
  regexp:
    /(?:^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?=\s*=))|(?:\{\{\s*(?:globals|repo)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\})/g,
  decoration: (match) =>
    Decoration.mark({
      class: match[0].includes("{{")
        ? "text-warning"
        : "text-accent-soft-foreground",
    }),
});
const highlighting = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = tokens.createDeco(view);
    }
    update(update: import("@codemirror/view").ViewUpdate) {
      this.decorations = tokens.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const yamlHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.propertyName, tags.definition(tags.propertyName)],
      color: "var(--accent-soft-foreground)",
    },
    { tag: tags.string, color: "var(--success-soft-foreground)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
    { tag: tags.comment, color: "var(--muted)" },
  ]),
);

export default function CodeEditor({
  value,
  disabled = false,
  embedded = false,
  language = "env",
  ariaLabel = "Secrets .env file",
  readOnlyLinePrefixes,
  revealReference,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  embedded?: boolean;
  language?: "env" | "yaml";
  ariaLabel?: string;
  readOnlyLinePrefixes?: string[];
  revealReference?: RevealSecretReference;
  onChange?: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(null);
  const editable = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;
  const reveal = useRef(revealReference);
  reveal.current = revealReference;
  useEffect(() => {
    const previews = hoverTooltip(
      (view, pos, side) => {
        const revealValue = reveal.current;
        if (!revealValue) return null;
        const line = view.state.doc.lineAt(pos);
        const reference = secretReferenceAt(line.text, pos - line.from, side);
        if (!reference) return null;
        return {
          pos,
          end: line.from + reference.to,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className =
              "px-3 py-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]";
            dom.style.maxWidth = "min(24rem, calc(100vw - 2rem))";
            dom.setAttribute("role", "tooltip");
            dom.textContent = "Loading value…";
            let active = true;
            return {
              dom,
              mount() {
                void revealValue(reference.scope, reference.key).then(
                  (value) => {
                    if (active) dom.textContent = value || "Empty value";
                  },
                  () => {
                    if (active)
                      dom.textContent = "Unable to show shared secret value";
                  },
                );
              },
              destroy() {
                active = false;
                dom.textContent = "";
              },
            };
          },
        };
      },
      { hideOnChange: true, hoverTime: 250 },
    );
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          language === "yaml" ? [yaml(), yamlHighlighting] : highlighting,
          language === "env"
            ? [
                previews,
                keymap.of([
                  {
                    key: "Ctrl-Space",
                    run(view) {
                      activateHover(view, view.state.selection.main.head, 1, {
                        tooltip: previews,
                      });
                      return true;
                    },
                  },
                  {
                    key: "Escape",
                    run(view) {
                      view.dispatch({ effects: closeHoverTooltips });
                      return false;
                    },
                  },
                ]),
              ]
            : [],
          drawSelection(),
          disabled ? [] : highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          readOnlyLinePrefixes?.length
            ? EditorState.transactionFilter.of((transaction) =>
                !transaction.docChanged ||
                (transaction.newDoc.lines === readOnlyLinePrefixes.length &&
                  readOnlyLinePrefixes.every((prefix, index) =>
                    transaction.newDoc.line(index + 1).text.startsWith(prefix),
                  ))
                  ? transaction
                  : [],
              )
            : [],
          editable.current.of(EditorState.readOnly.of(disabled)),
          EditorView.contentAttributes.of((view) => ({
            "aria-label": ariaLabel,
            "aria-readonly": String(view.state.readOnly),
            autocapitalize: "off",
            spellcheck: "false",
            "data-lpignore": "true",
            "data-1p-ignore": "true",
          })),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              change.current?.(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              color: "var(--foreground)",
              backgroundColor: embedded
                ? "transparent"
                : "var(--surface-secondary)",
              borderRadius: embedded ? "0" : "var(--radius-lg)",
              overflow: "hidden",
            },
            "&.cm-focused": {
              outline: embedded ? "none" : "1px solid var(--border)",
              outlineOffset: "1px",
            },
            ".cm-scroller": {
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "14px",
              lineHeight: "1.6",
              overflow: "auto",
              minHeight: "240px",
              maxHeight: "480px",
            },
            ".cm-content": {
              padding: embedded ? "16px 0" : "12px 0",
              caretColor: "var(--foreground)",
            },
            ".cm-line": { padding: "0 12px" },
            ".cm-gutters": {
              backgroundColor: embedded
                ? "transparent"
                : "var(--surface-secondary)",
              color: "var(--muted)",
              border: "none",
              paddingLeft: "8px",
            },
            ".cm-activeLine": { backgroundColor: "var(--surface-tertiary)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "var(--accent-soft)",
            },
            ".cm-tooltip": {
              backgroundColor: "var(--overlay)",
              color: "var(--foreground)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-overlay)",
            },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
          }),
        ],
      }),
    });
    editor.current = view;
    const clearPreviews = () => view.dispatch({ effects: closeHoverTooltips });
    window.addEventListener("blur", clearPreviews);
    document.addEventListener("visibilitychange", clearPreviews);
    return () => {
      window.removeEventListener("blur", clearPreviews);
      document.removeEventListener("visibilitychange", clearPreviews);
      view.destroy();
      editor.current = null;
    };
    // Language, label, and protected prefixes are fixed for an editor instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    editor.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(disabled)),
    });
  }, [disabled]);
  useEffect(() => {
    const view = editor.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);
  return <div ref={host} className="min-w-0" />;
}
