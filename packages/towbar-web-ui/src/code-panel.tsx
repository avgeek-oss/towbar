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
}: {
  ariaLabel: string;
  children: string;
  language?: string;
  codeClassName?: string;
  renderLine?: (content: ReactNode, lineIndex: number) => ReactNode;
}) {
  return (
    <CodeBlock aria-label={ariaLabel} className="w-full min-w-0">
      <CodeBlock.Header>
        <CodeBlock.Filename>{ariaLabel}</CodeBlock.Filename>
        <CodeBlock.CopyButton code={children} />
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
