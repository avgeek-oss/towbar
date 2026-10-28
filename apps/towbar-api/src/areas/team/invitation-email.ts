import type { AuthDatabase } from "../../infrastructure/database.js";
import { enqueueAdminEmail } from "./email-outbox.js";

export async function invitationAccepted(
  tx: AuthDatabase,
  row: {
    invitation: {
      id: string;
      workspaceId: string;
      email: string;
      role: string;
    };
  },
) {
  await enqueueAdminEmail(tx, {
    workspaceId: row.invitation.workspaceId,
    template: "invitation-accepted",
    dedupeKey: `invitation-accepted:${row.invitation.id}`,
    data: { name: row.invitation.email, role: row.invitation.role },
  });
}
