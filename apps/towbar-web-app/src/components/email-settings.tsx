"use client";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { useEffect, useState } from "react";
import {
  EmailConfirmation,
  EmailChangeSettings,
} from "@avgeek-oss/design-system";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { displayDate } from "@/lib/date-time-display";
import { AuthBrand } from "./auth-frame";
import { useAccess } from "./access-context";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

export function EmailSettings() {
  const draft = useUnsavedForm<HTMLDivElement>();
  const { user } = useAccess();
  const [resendAt, setResendAt] = useState(0);
  const query = useApiQuery<{
    pending: { email: string; expiresAt: string } | null;
  }>("/v1/core/profile/email-change");
  if (!user) return null;
  return (
    <div {...draft.formProps}>
      <EmailChangeSettings
        email={user.email}
        isVerified={user.emailVerified}
        pendingChange={query.data?.pending}
        error={query.error}
        formatDate={displayDate}
        resendAvailableAt={resendAt}
        onRequestChange={async (email) => {
          await api.post("/v1/core/profile/email-change", { email });
          draft.markSaved();
          query.refresh();
          toast.success("Confirmation email queued");
        }}
        onCancelChange={async () => {
          await api.delete("/v1/core/profile/email-change");
          query.refresh();
          toast.success("Email change cancelled");
        }}
        onResendVerification={async () => {
          await api.post("/v1/public/auth/identity/send-verification-email", {
            email: user.email,
            callbackURL: `${window.location.origin}/settings/email-password`,
          });
          setResendAt(Date.now() + 60_000);
          toast.success("Confirmation email queued");
        }}
      />
    </div>
  );
}
export function ConfirmEmailChange() {
  const [proof, setProof] = useState<{ id: string; token: string } | null>(
    null,
  );
  const [done, setDone] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    function readProof() {
      const hash = window.location.hash.slice(1);
      const match = hash.match(/^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
      if (match?.[1] && match[2]) {
        setProof({ id: match[1], token: match[2] });
        setDone(false);
        window.history.replaceState(null, "", window.location.pathname);
      } else if (hash) setProof(null);
      setChecked(true);
    }
    readProof();
    window.addEventListener("hashchange", readProof);
    return () => window.removeEventListener("hashchange", readProof);
  }, []);
  const shared = {
    brand: <AuthBrand />,
    purpose: "email-change" as const,
    onBackToSignIn: () => window.location.assign("/login"),
  };
  if (!checked) return <EmailConfirmation {...shared} status="checking" />;
  if (done) return <EmailConfirmation {...shared} status="confirmed" />;
  if (!proof) return <EmailConfirmation {...shared} status="unavailable" />;
  return (
    <EmailConfirmation
      {...shared}
      status="ready"
      onConfirm={async () => {
        const result = await api.post<{ success: boolean }>(
          "/v1/public/auth/confirm-email-change",
          proof,
        );
        if (result?.success !== true)
          throw new Error("Email confirmation was not completed. Try again.");
        setDone(true);
        window.dispatchEvent(new Event("towbar:identity-changed"));
        toast.success("Email updated");
      }}
    />
  );
}
