import {
  EmailShell,
  type EmailMessage,
} from "@avgeek-oss/design-system/emails/email-shell";
import { authEmailMessage } from "@avgeek-oss/design-system/emails/auth-email";
import { renderEmailMessage } from "@avgeek-oss/design-system/emails/render";
import { compactDetail, operationalDetails } from "./operational-details.js";
export const transactionalTemplates = [
  "invitation",
  "invitation-verification",
  "email-verification",
  "email-change-verification",
  "email-changed",
  "account-created",
  "invitation-accepted",
  "role-changed",
  "access-removed",
  "password-reset",
  "password-changed",
  "mfa-changed",
  "team-key-created",
  "team-key-revoked",
] as const;
export type TransactionalTemplate = (typeof transactionalTemplates)[number];
export type TransactionalEmailData = {
  name?: string;
  teamName: string;
  actionUrl?: string;
  role?: string;
  previousRole?: string;
  keyName?: string;
  verificationCode?: string;
};
const brand = {
  name: "Towbar",
  accentColor: "#f3c530",
  theme: { accentForeground: "#1a1813" },
  logoUrl: "https://www.towbar.dev/assets/towbar-logo.png",
};
function message(
  template: TransactionalTemplate,
  data: TransactionalEmailData,
): EmailMessage {
  if (template === "team-key-created" || template === "team-key-revoked") {
    const created = template === "team-key-created";
    return {
      title: created ? "Team API key created" : "Team API key revoked",
      paragraphs: [
        created
          ? `A team API key named “${data.keyName ?? "Team key"}” was created for ${data.teamName}. Review it in Team Settings if this was unexpected.`
          : `The team API key “${data.keyName ?? "Team key"}” was revoked. Automations using it can no longer access ${data.teamName}.`,
      ],
      teamName: data.teamName,
      actionUrl: data.actionUrl,
    };
  }
  return authEmailMessage(template, { ...data, brand });
}
function renderMessage(content: EmailMessage) {
  return renderEmailMessage({ brand, message: content });
}
export function renderTransactionalEmail(
  template: TransactionalTemplate,
  data: TransactionalEmailData,
) {
  return renderMessage(message(template, data));
}
export function TransactionalEmail({
  template,
  data,
}: {
  template: TransactionalTemplate;
  data: TransactionalEmailData;
}) {
  return <EmailShell brand={brand} message={message(template, data)} />;
}
export type OperationalEmailData = {
  title: string;
  summary: string;
  actionUrl: string;
  details: Record<string, string | number | boolean | null | undefined>;
};
function operationalMessage(input: OperationalEmailData): EmailMessage {
  return {
    title: input.title,
    paragraphs: [input.summary],
    details: operationalDetails(input.details).map((detail) => ({
      ...detail,
      displayValue: compactDetail(detail),
    })),
    teamName: "Towbar notifications",
    actionUrl: input.actionUrl,
    actionLabel: "View in Towbar",
  };
}
export function OperationalEmail(input: OperationalEmailData) {
  return <EmailShell brand={brand} message={operationalMessage(input)} />;
}
export function renderOperationalEmail(input: OperationalEmailData) {
  return renderMessage(operationalMessage(input));
}
