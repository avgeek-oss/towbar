import { sessionUser } from "../../../http/session-user.js";
import { Hono } from "hono";
import { z } from "zod";
import { workspaceRoles } from "@workspace/towbar-access";
import {
  createTeamInvitation,
  getTeam,
  listInvitations,
  listTeamMembers,
  removeTeamMember,
  revokeInvitation,
  updateMemberRole,
  updateTeam,
} from "../../../areas/team/service.js";
import { requireRecentAuthentication } from "../../../areas/auth/recent-authentication.js";
import { operation } from "../../../http/operation.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";
const role = z.enum(workspaceRoles);
const teamSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
const invitationSchema = z.object({ email: z.email().max(320), role }).strict();
const roleSchema = z
  .object({ role, name: z.string().trim().min(1).max(120).optional() })
  .strict();
const paging = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const teamRoutes = new Hono<TowbarHonoEnvironment>();
teamRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
teamRoutes.get(
  "/",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "Get team settings",
    responseSchema: 'team.ts:get:"/"',
    response: "Team name and description.",
  }),
  async (c) => c.json({ team: await getTeam(sessionUser(c)) }),
);
teamRoutes.patch(
  "/",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "Update team settings",
    responseSchema: 'team.ts:patch:"/"',
    response: "Updated team settings.",
    body: teamSchema,
  }),
  async (c) =>
    c.json({
      team: await updateTeam(sessionUser(c), await readJson(c, teamSchema)),
    }),
);
teamRoutes.get(
  "/members",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "List team members",
    responseSchema: 'team.ts:get:"/members"',
    response: "Members and total.",
    query: paging,
  }),
  async (c) =>
    c.json(await listTeamMembers(sessionUser(c), paging.parse(c.req.query()))),
);
teamRoutes.patch(
  "/members/:memberId",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "Update member details and role",
    responseSchema: 'team.ts:patch:"/members/:memberId"',
    response: "Updated role.",
    body: roleSchema,
  }),
  async (c) => {
    const input = await readJson(c, roleSchema);
    if (input.role === "admin")
      await requireRecentAuthentication(
        sessionUser(c).id,
        c.get("currentSessionId"),
      );
    return c.json(
      await updateMemberRole(
        sessionUser(c),
        readUuidPathParameter(c.req.param("memberId"), "memberId"),
        input.role,
        input.name,
      ),
    );
  },
);
teamRoutes.delete(
  "/members/:memberId",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "Remove member access",
    responseSchema: 'team.ts:delete:"/members/:memberId"',
    response: "No response body.",
    status: 204,
  }),
  async (c) => {
    await removeTeamMember(
      sessionUser(c),
      readUuidPathParameter(c.req.param("memberId"), "memberId"),
    );
    return c.body(null, 204);
  },
);
teamRoutes.get(
  "/invitations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "List team invitations",
    responseSchema: 'team.ts:get:"/invitations"',
    response: "Invitations and email delivery state.",
  }),
  async (c) => c.json({ invitations: await listInvitations(sessionUser(c)) }),
);
teamRoutes.post(
  "/invitations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "Create team invitation",
    responseSchema: 'team.ts:post:"/invitations"',
    response: "Invitation link and expiry.",
    status: 201,
    body: invitationSchema,
  }),
  async (c) => {
    const input = await readJson(c, invitationSchema);
    if (input.role === "admin")
      await requireRecentAuthentication(
        sessionUser(c).id,
        c.get("currentSessionId"),
      );
    return c.json(
      await createTeamInvitation(sessionUser(c), input, c.req.raw.headers),
      201,
    );
  },
);
teamRoutes.delete(
  "/invitations/:invitationId",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "Revoke team invitation",
    responseSchema: 'team.ts:delete:"/invitations/:invitationId"',
    response: "No response body.",
    status: 204,
  }),
  async (c) => {
    await revokeInvitation(
      sessionUser(c),
      readUuidPathParameter(c.req.param("invitationId"), "invitationId"),
    );
    return c.body(null, 204);
  },
);
