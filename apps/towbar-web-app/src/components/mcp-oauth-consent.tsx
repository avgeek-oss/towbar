"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { AuthFrame, AuthBrand } from "./auth-frame";
import {
  McpAuthorization,
  type McpAccessLevel,
} from "@avgeek-oss/design-system";
import { McpClientLogo } from "./mcp-client-logo";
import { config } from "@/lib/config";
import { api } from "@/lib/api";
import { ReauthenticationDialog } from "./reauthentication-dialog";

type Consent = {
  clientName: string;
  clientId: string;
  clientLogo: string | null;
  clientTrust: "metadata-document" | "unverified";
  redirectUri: string;
  scope: string;
  user: {
    name: string;
    email: string;
    teamName?: string;
    role: string;
    twoFactorEnabled: boolean;
  };
};
export function McpOAuthConsent() {
  const id = useSearchParams().get("request");
  return <ConsentRequest key={id} id={id} />;
}
function ConsentRequest({ id }: { id: string | null }) {
  const [details, setDetails] = useState<Consent>();
  const [error, setError] = useState<string>();
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accessLevel, setAccessLevel] = useState<McpAccessLevel>("read");
  const inFlight = useRef(false);
  const endpoint = `${config.apiBaseUrl}/v1/oauth/consent/${encodeURIComponent(id ?? "")}`;
  const self = `/oauth/consent?request=${encodeURIComponent(id ?? "")}`;
  useEffect(() => {
    const controller = new AbortController();
    if (!id) return;
    void fetch(endpoint, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setLogin(true);
          return;
        }
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error_description ?? "Unable to load this connection",
          );
        setDetails(body);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load this connection",
          );
      });
    return () => controller.abort();
  }, [endpoint, id]);
  async function decide(allow: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const body = await api.post<{ redirectTo: string }>(
        new URL(endpoint).pathname,
        allow ? { allow, accessLevel } : { allow },
      );
      window.location.assign(body.redirectTo);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to connect this app",
      );
      setBusy(false);
      inFlight.current = false;
    }
  }
  if (details && !login)
    return (
      <>
        <ReauthenticationDialog
          twoFactorEnabled={details.user.twoFactorEnabled}
        />
        <McpAuthorization
          brand={<AuthBrand />}
          productName="Towbar"
          isPending={busy}
          error={error}
          clientName={details.clientName}
          clientLogo={
            <McpClientLogo client={details.clientLogo ?? "unknown"} />
          }
          accessLevel={accessLevel}
          availableAccessLevels={
            details.user.role === "admin"
              ? ["read", "write", "admin"]
              : details.user.role === "viewer"
                ? ["read"]
                : ["read", "write"]
          }
          onAccessLevelChange={setAccessLevel}
          onApprove={() => void decide(true)}
          onDeny={() => void decide(false)}
        />
      </>
    );
  return (
    <AuthFrame
      title="Connect to Towbar"
      description="Choose whether to give this app access."
    >
      {(error || !id) && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {error ??
                "This connection link is incomplete. Start again from your app."}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {login ? (
        <ButtonLink href={`/login?next=${encodeURIComponent(self)}`}>
          Sign in to continue
        </ButtonLink>
      ) : (
        !error && id && <QueryLoading />
      )}
    </AuthFrame>
  );
}
