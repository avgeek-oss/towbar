import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  apiKeyPolicies,
  apiKeys,
  mcpOAuthRequests,
} from "@workspace/towbar-database/schema";
import type { AuthDatabase } from "../../infrastructure/database.js";

/**
 * Revoke the bearer access a user holds in their own name: personal API keys,
 * MCP OAuth tokens (personal keys of type mcp-oauth) and MCP authorization
 * requests that have not been exchanged yet. Team keys are service identities
 * of the team and stay valid. Returns the number of revoked keys.
 */
export async function revokePersonalAccess(
  database: AuthDatabase,
  userId: string,
) {
  const now = new Date();
  const revoked = await database
    .update(apiKeyPolicies)
    .set({ revokedAt: now })
    .where(
      and(
        eq(apiKeyPolicies.ownerUserId, userId),
        eq(apiKeyPolicies.scope, "personal"),
        isNull(apiKeyPolicies.revokedAt),
      ),
    )
    .returning({ id: apiKeyPolicies.keyId });
  if (revoked.length)
    await database
      .update(apiKeys)
      .set({ enabled: false, updatedAt: now })
      .where(
        inArray(
          apiKeys.id,
          revoked.map((key) => key.id),
        ),
      );
  await database
    .delete(mcpOAuthRequests)
    .where(
      and(
        eq(mcpOAuthRequests.userId, userId),
        isNull(mcpOAuthRequests.consumedAt),
      ),
    );
  return revoked.length;
}
