"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { FingerPrintIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ConfirmIdentityDialog } from "@avgeek-oss/design-system";
import { api } from "@/lib/api";
import { passkeyError, verifyPasskeySecondFactor } from "@/lib/passkeys";
import { useAccess } from "./access-context";

export function ReauthenticationDialog({
  twoFactorEnabled,
}: { twoFactorEnabled?: boolean } = {}) {
  const { user } = useAccess();
  const [open, setOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string>();
  const usePasskey = twoFactorEnabled ?? user?.twoFactorEnabled;
  const pending = useRef<Array<(result: boolean) => void>>([]);
  const passkeyRequest = useRef<AbortController | null>(null);
  const finish = useCallback((result: boolean) => {
    if (!result) {
      passkeyRequest.current?.abort();
      passkeyRequest.current = null;
      setRequesting(false);
      setVerifying(false);
    }
    setError(undefined);
    pending.current.splice(0).forEach((resolve) => resolve(result));
    setOpen(false);
  }, []);
  useEffect(() => {
    const queue = pending.current;
    const handle = (event: Event) => {
      const request = event as CustomEvent<{
        resolve: (result: boolean) => void;
      }>;
      queue.push(request.detail.resolve);
      setOpen(true);
    };
    window.addEventListener("towbar:reauthenticate", handle);
    return () => {
      window.removeEventListener("towbar:reauthenticate", handle);
      passkeyRequest.current?.abort();
      queue.splice(0).forEach((resolve) => resolve(false));
    };
  }, []);
  const confirmPasskey = useCallback(async () => {
    if (passkeyRequest.current) return;
    const controller = new AbortController();
    passkeyRequest.current = controller;
    setRequesting(true);
    setError(undefined);
    try {
      await verifyPasskeySecondFactor(controller.signal, () =>
        setVerifying(true),
      );
      if (!controller.signal.aborted) finish(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(passkeyError(cause));
    } finally {
      if (passkeyRequest.current === controller) {
        passkeyRequest.current = null;
        setRequesting(false);
        setVerifying(false);
      }
    }
  }, [finish]);
  useEffect(() => {
    if (open && usePasskey) void confirmPasskey();
  }, [open, usePasskey, confirmPasskey]);
  const shared = {
    isOpen: open,
    onOpenChange: (value: boolean) => {
      if (!value) finish(false);
    },
  };
  return usePasskey ? (
    <ConfirmIdentityDialog
      {...shared}
      method="custom"
      isPending={requesting}
      isDismissDisabled={verifying}
    >
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          Confirm with your passkey to continue.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button
          className="w-full"
          isDisabled={requesting}
          isPending={requesting}
          onPress={() => void confirmPasskey()}
        >
          <HugeiconsIcon icon={FingerPrintIcon} size={16} aria-hidden="true" />
          {requesting ? "Waiting for passkey…" : "Use Passkey"}
        </Button>
      </div>
    </ConfirmIdentityDialog>
  ) : (
    <ConfirmIdentityDialog
      {...shared}
      onConfirm={async ({ password }) => {
        await api.post("/v1/core/session/reauthenticate", { password });
        finish(true);
      }}
    />
  );
}
