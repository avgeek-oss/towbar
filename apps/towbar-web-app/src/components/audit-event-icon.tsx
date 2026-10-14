import {
  Activity01Icon,
  Alert02Icon,
  Archive01Icon,
  CommandLineIcon,
  CleanIcon,
  GitBranchIcon,
  Key01Icon,
  Mail01Icon,
  MailSend01Icon,
  ServerStack01Icon,
  Settings01Icon,
  Shield01Icon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AuditEventIcon as AuditEventIconName } from "@workspace/towbar-web-client";
import { ScoutMascot } from "./scout-mascot";

const icons = {
  team: UserGroupIcon,
  member: UserAccountIcon,
  invitation: MailSend01Icon,
  email: Mail01Icon,
  account: UserAccountIcon,
  shield: Shield01Icon,
  "api-key": Key01Icon,
  "private-key": Key01Icon,
  secrets: Key01Icon,
  repository: GitBranchIcon,
  branch: GitBranchIcon,
  automation: Settings01Icon,
  server: ServerStack01Icon,
  terminal: CommandLineIcon,
  scout: null,
  alert: Alert02Icon,
  restore: Archive01Icon,
  cleanup: CleanIcon,
} satisfies Record<AuditEventIconName, typeof Activity01Icon | null>;

export function AuditEventIcon({ icon }: { icon: AuditEventIconName | null }) {
  if (icon === "scout") return <ScoutMascot size={16} variant="icon" />;
  return (
    <HugeiconsIcon
      icon={(icon && icons[icon]) || Activity01Icon}
      className="size-4 shrink-0 text-muted"
      aria-hidden="true"
    />
  );
}
