import type {
  AccessActor,
  Scope,
  WorkspaceRole,
} from "@workspace/towbar-access";
import type { DateTimePreferences } from "@workspace/towbar-core/date-time";
export type AuthenticatedUser = {
  email: string;
  id: string;
  name: string;
  dateTimePreferences?: DateTimePreferences;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
  teamName?: string;
  emailVerified?: boolean;
  mustChangePassword?: boolean;
  passwordSetupRequired?: boolean;
  twoFactorEnabled?: boolean;
  capabilities?: readonly Scope[];
};

type RequestPrincipal =
  | AuthenticatedUser
  | {
      id: null;
      email: null;
      name: string;
      workspaceId: string;
      workspaceRole: null;
      capabilities: readonly Scope[];
    };

export type TowbarVariables = {
  actor: AccessActor;
  currentSessionId: string | null;
  apiKey:
    | {
        id: string;
        access: "read" | "edit";
        tokenType?: "api-key" | "mcp-oauth";
        resource?: string | null;
      }
    | undefined;
  requestId: string;
  user: RequestPrincipal;
};

export type TowbarHonoEnvironment = {
  Variables: TowbarVariables;
};
