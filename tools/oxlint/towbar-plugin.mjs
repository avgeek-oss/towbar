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

// Ported from the ESLint accessibility config's workspace-a11y rule.
const explicitSvgAccessibilityRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require SVG content to be explicitly labelled or hidden from assistive technology.",
    },
    messages: {
      missingAccessibility:
        "SVG content must have aria-hidden, aria-label, or aria-labelledby.",
    },
    schema: [],
  },
  create(context) {
    function getAttributeName(attribute) {
      return attribute.type === "JSXAttribute" &&
        attribute.name.type === "JSXIdentifier"
        ? attribute.name.name
        : undefined;
    }

    function isExplicitlyHidden(attribute) {
      if (getAttributeName(attribute) !== "aria-hidden") return false;
      if (attribute.value === null) return true;

      if (attribute.value.type === "Literal") {
        return attribute.value.value === "true";
      }

      return (
        attribute.value.type === "JSXExpressionContainer" &&
        attribute.value.expression.type === "Literal" &&
        attribute.value.expression.value === true
      );
    }

    function hasNonEmptyLabel(attribute) {
      const name = getAttributeName(attribute);
      if (name !== "aria-label" && name !== "aria-labelledby") return false;
      if (attribute.value === null) return false;

      return (
        attribute.value.type !== "Literal" ||
        String(attribute.value.value ?? "").trim().length > 0
      );
    }

    function hasAccessibilityAttribute(node) {
      return node.attributes.some(
        (attribute) =>
          isExplicitlyHidden(attribute) || hasNonEmptyLabel(attribute),
      );
    }

    function isInsideHiddenContent(node) {
      let parent = node.parent;

      while (parent) {
        if (
          parent.type === "JSXElement" &&
          parent.openingElement.attributes.some(isExplicitlyHidden)
        ) {
          return true;
        }

        parent = parent.parent;
      }

      return false;
    }

    return {
      JSXOpeningElement(node) {
        if (
          node.name.type !== "JSXIdentifier" ||
          (node.name.name !== "svg" && node.name.name !== "HugeiconsIcon")
        ) {
          return;
        }

        if (hasAccessibilityAttribute(node) || isInsideHiddenContent(node)) {
          return;
        }

        context.report({
          node,
          messageId: "missingAccessibility",
        });
      },
    };
  },
};

export default {
  meta: { name: "towbar" },
  rules: {
    "explicit-svg-accessibility": explicitSvgAccessibilityRule,
    "no-button-in-link": noButtonInLink,
    "require-eslint-disable-justification": requireDisableJustification,
  },
};
