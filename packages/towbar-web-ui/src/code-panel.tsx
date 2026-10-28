"use client";

import { Fragment, type ReactNode } from "react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { CodeBlock } from "@avgeek-oss/design-system/typography/code-block";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { cn } from "@avgeek-oss/design-system/lib/utils";

const jsonTheme: PrismTheme = {
  plain: { color: "var(--foreground)" },
  styles: [
    { types: ["property"], style: { color: "var(--accent-soft-foreground)" } },
    { types: ["string"], style: { color: "var(--success-soft-foreground)" } },
    { types: ["number"], style: { color: "var(--warning-soft-foreground)" } },
    {
      types: ["boolean", "null"],
      style: { color: "var(--danger-soft-foreground)" },
    },
    { types: ["punctuation", "operator"], style: { color: "var(--muted)" } },
  ],
};

export function CodePanel({
  ariaLabel,
  children,
  language = "text",
  codeClassName,
  renderLine,
  headerActions,
}: {
  ariaLabel: string;
  children: string;
  language?: string;
  codeClassName?: string;
  renderLine?: (content: ReactNode, lineIndex: number) => ReactNode;
  headerActions?: ReactNode;
}) {
  return (
    <CodeBlock aria-label={ariaLabel} className="w-full min-w-0">
      <CodeBlock.Header>
        <CodeBlock.Filename>{ariaLabel}</CodeBlock.Filename>
        <div className="flex shrink-0 items-center gap-3">
          {headerActions}
          <CodeBlock.CopyButton code={children} />
        </div>
      </CodeBlock.Header>
      {language === "json" ? (
        <Widget.Content className="p-0">
          <pre
            aria-label={`${ariaLabel} code`}
            className={cn(
              "m-0 max-h-[30rem] overflow-auto p-4 text-sm",
              codeClassName,
            )}
            data-language="json"
            data-slot="code-block-code"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be reachable by keyboard so its overflow can be scrolled (WCAG 2.1.1).
            tabIndex={0}
          >
            <Highlight code={children} language="json" theme={jsonTheme}>
              {({ tokens, getTokenProps }) => (
                <code>
                  {tokens.map((line, lineIndex) => {
                    const content = line.map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ));
                    return (
                      <Fragment key={lineIndex}>
                        {lineIndex > 0 ? "\n" : null}
                        {renderLine ? renderLine(content, lineIndex) : content}
                      </Fragment>
                    );
                  })}
                </code>
              )}
            </Highlight>
          </pre>
        </Widget.Content>
      ) : (
        <CodeBlock.Code
          aria-label={`${ariaLabel} code`}
          className={cn("max-h-[30rem] overflow-auto", codeClassName)}
          tabIndex={0}
          code={children}
          language={language}
        />
      )}
    </CodeBlock>
  );
}
