// Towbar's own lint rules, loaded by oxlint as a JS plugin (see .oxlintrc.json).

const requireDisableJustification = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require eslint-disable comments to name rules and include a justification.",
    },
    messages: {
      broadDisable:
        "ESLint disable comments must name the specific rule being disabled.",
      missingJustification:
        "ESLint disable comments must include a justification after `--`.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.trim();
          const directiveMatch = text.match(
            /^eslint-disable(?:-next-line|-line)?\b/,
          );
          if (!directiveMatch) continue;

          const [directiveText, justification = ""] = text.split(/\s--\s+/, 2);
          const ruleNames = directiveText
            .slice(directiveMatch[0].length)
            .trim()
            .split(",")
            .map((ruleName) => ruleName.trim())
            .filter(Boolean);

          if (ruleNames.length === 0)
            context.report({ loc: comment.loc, messageId: "broadDisable" });
          if (justification.trim().length === 0)
            context.report({
              loc: comment.loc,
              messageId: "missingJustification",
            });
        }
      },
    };
  },
};

const elementName = (element) =>
  element.openingElement.name.type === "JSXIdentifier"
    ? element.openingElement.name.name
    : undefined;

// Replaces ESLint's no-restricted-syntax selector
// `JSXElement[openingElement.name.name=/^(Link|a)$/] > JSXElement[openingElement.name.name='Button']`.
const noButtonInLink = {
  meta: {
    type: "problem",
    docs: { description: "Disallow <Button> directly inside <Link> or <a>." },
    messages: {
      nested:
        "Do not nest <Button> inside <Link> or <a>. Use <Button render={<Link href='...' />}> instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        if (elementName(node) !== "Button") return;
        const parent = node.parent;
        if (
          parent?.type === "JSXElement" &&
          ["Link", "a"].includes(elementName(parent))
        )
          context.report({ node, messageId: "nested" });
      },
    };
  },
};

export default {
  meta: { name: "towbar" },
  rules: {
    "no-button-in-link": noButtonInLink,
    "require-eslint-disable-justification": requireDisableJustification,
  },
};
