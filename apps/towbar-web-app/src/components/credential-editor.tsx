"use client";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  Alert02Icon,
  CheckmarkCircle01Icon,
  FloppyDiskIcon,
  InformationCircleIcon,
  ReloadIcon,
} from "@hugeicons/core-free-icons";

import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "@/hooks/use-guarded-router";

import { useEffect, useState, type FormEvent } from "react";
import type {
  SecretMetadata,
  Server,
  TrustedHostKey,
} from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { FieldError } from "@avgeek-oss/design-system/forms/field";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";

import { FormCard } from "@/components/page-parts";
import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { formatDate } from "./dashboard-overview";
import { PrivateKeySelector, type StoredPrivateKey } from "./private-key-store";

type DiscoveredHostKey = {
  algorithm: string;
  fingerprint: string;
  publicKey: string;
};

type CredentialVerification = {
  errorCode: string | null;
  errorMessage: string | null;
  id: string;
  result: { discoveredHostKeys?: DiscoveredHostKey[] } | null;
  status: "queued" | "running" | "succeeded" | "failed";
};

export function ServerCredentials({
  canManage,
  server,
}: {
  canManage: boolean;
  server: Server;
}) {
  const endpoint = `/v1/core/servers/${server.id}/credentials`;
  const query = useApiQuery<{
    credential: SecretMetadata;
    canManage: boolean;
    selectedPrivateKeyId: string | null;
  }>(endpoint);
  const hostKeys = useApiQuery<{ hostKeys: TrustedHostKey[] }>(
    `/v1/core/servers/${server.id}/host-keys`,
  );
  const error = query.error ?? hostKeys.error;
  if (error) return <QueryError message={error} />;
  if (!query.data || !hostKeys.data) return <QueryLoading />;
  return (
    <ServerCredentialForm
      key={`${query.data.credential.revision ?? "empty"}:${query.data.selectedPrivateKeyId ?? "legacy"}`}
      canManage={canManage && query.data.canManage}
      credential={query.data.credential}
      endpoint={endpoint}
      hostKeys={hostKeys.data.hostKeys}
      refresh={query.refresh}
      serverId={server.id}
      preparationPending={server.setupStatus === "pending"}
      selectedPrivateKeyId={query.data.selectedPrivateKeyId}
    />
  );
}

function ServerCredentialForm({
  canManage,
  credential,
  endpoint,
  hostKeys,
  preparationPending,
  refresh,
  serverId,
  selectedPrivateKeyId,
}: {
  canManage: boolean;
  credential: SecretMetadata;
  endpoint: string;
  hostKeys: TrustedHostKey[];
  preparationPending: boolean;
  refresh: () => void;
  serverId: string;
  selectedPrivateKeyId: string | null;
}) {
  const router = useRouter();
  const [selectedKeyId, setSelectedKeyId] = useState(selectedPrivateKeyId);
  const releaseDraft = useUnsavedChanges(
    selectedKeyId !== selectedPrivateKeyId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [verification, setVerification] =
    useState<CredentialVerification | null>(null);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [trustingFingerprint, setTrustingFingerprint] = useState<string>();

  const verificationActive =
    verification?.status === "queued" || verification?.status === "running";
  const latestHostKey = hostKeys.reduce<TrustedHostKey | undefined>(
    (latest, hostKey) =>
      !latest || hostKey.createdAt > latest.createdAt ? hostKey : latest,
    undefined,
  );

  function finishVerification(continuePreparation = false) {
    if (verificationActive || trustingFingerprint) return;
    if (verification?.status === "succeeded") {
      refresh();
      refreshApiQueries();
      releaseDraft();
      toast.success("SSH private key verified and saved");
    }
    setVerificationOpen(false);
    setVerification(null);
    if (continuePreparation) router.push(`/servers/${serverId}/preparation`);
  }

  async function startVerification(privateKeyId = selectedKeyId) {
    if (!privateKeyId) {
      setError("Select a stored private key.");
      return;
    }
    setError(undefined);
    setVerificationOpen(true);
    setVerification(null);
    setBusy(true);
    try {
      const response = await api.post<{
        verification: CredentialVerification;
      }>(`${endpoint}/actions/verify-private-key`, {
        expectedRevision: credential.revision,
        privateKeyId,
      });
      setVerification(response.verification);
    } catch (failure) {
      setVerification({
        errorCode: "REQUEST_FAILED",
        errorMessage:
          failure instanceof Error
            ? failure.message
            : "The SSH private key could not be verified.",
        id: "",
        result: null,
        status: "failed",
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!verificationActive || !verification?.id) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await api.get<{
          verification: CredentialVerification;
        }>(`${endpoint}/verifications/${verification.id}`);
        if (cancelled) return;
        setVerification(response.verification);
        if (
          response.verification.status === "queued" ||
          response.verification.status === "running"
        )
          timer = window.setTimeout(() => void poll(), 900);
      } catch (failure) {
        if (cancelled) return;
        setVerification({
          errorCode: "REQUEST_FAILED",
          errorMessage:
            failure instanceof Error
              ? failure.message
              : "The verification result could not be loaded.",
          id: "",
          result: null,
          status: "failed",
        });
      }
    };
    timer = window.setTimeout(() => void poll(), 900);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [endpoint, refresh, verification?.id, verificationActive]);

  async function trustAndVerify(hostKey: DiscoveredHostKey) {
    setTrustingFingerprint(hostKey.fingerprint);
    try {
      await api.post(`/v1/core/servers/${serverId}/host-keys/actions/trust`, {
        ...hostKey,
        replaceExisting: hostKeys.length > 0,
      });
      await startVerification();
    } catch (failure) {
      setVerification((current) =>
        current
          ? {
              ...current,
              errorCode: "HOST_KEY_TRUST_FAILED",
              errorMessage:
                failure instanceof Error
                  ? failure.message
                  : "The host key could not be trusted.",
              status: "failed",
            }
          : current,
      );
    } finally {
      setTrustingFingerprint(undefined);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (!selectedKeyId || selectedKeyId === selectedPrivateKeyId) {
      setError("Select a different stored private key.");
      return;
    }
    await startVerification(selectedKeyId);
  }

  return (
    <FormCard
      headerEnd={
        credential.keys.includes("privateKey") ? (
          latestHostKey && hostKeys.length ? (
            <TooltipText
              className="inline-flex"
              tooltip={`Verified ${formatDate(latestHostKey.createdAt)}`}
            >
              <Chip size="sm" color="success">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  {
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={CheckmarkCircle01Icon}
                    />
                  }
                  Host verified
                </Chip.Label>
              </Chip>
            </TooltipText>
          ) : (
            <TooltipText
              className="inline-flex"
              tooltip="Verify the server's SSH host key before using stored credentials."
            >
              <Chip size="sm" color="warning">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  {
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={InformationCircleIcon}
                    />
                  }
                  Host verification required
                </Chip.Label>
              </Chip>
            </TooltipText>
          )
        ) : null
      }
      title="Server credentials"
    >
      <form className="content-grid w-full" onSubmit={submit}>
        <div className="grid gap-2">
          <PrivateKeySelector
            disabled={!canManage || busy}
            selectedKey={selectedKeyId}
            onSelectionChange={setSelectedKeyId}
            onCreated={(privateKey: StoredPrivateKey) =>
              void startVerification(privateKey.id)
            }
          />
          {credential.keys.includes("privateKey") && !selectedPrivateKeyId ? (
            <p className="text-sm text-warning">
              This server uses a legacy key. Select a stored key to replace it.
            </p>
          ) : null}
        </div>

        {error ? (
          <FieldError>
            {error}{" "}
            <Button variant="ghost" onPress={refresh}>
              <HugeiconsIcon
                aria-hidden="true"
                icon={ReloadIcon}
                className="size-4 shrink-0"
              />
              Refresh settings
            </Button>
          </FieldError>
        ) : null}
        {canManage ? (
          <Button
            type="submit"
            className="w-fit"
            isDisabled={
              busy || !selectedKeyId || selectedKeyId === selectedPrivateKeyId
            }
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={FloppyDiskIcon}
              className="size-4 shrink-0"
            />
            {busy ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </form>
      <CredentialVerificationModal
        active={verificationActive}
        canRetry={Boolean(selectedKeyId)}
        hostKeys={hostKeys}
        isOpen={verificationOpen}
        preparationPending={preparationPending}
        trustingFingerprint={trustingFingerprint}
        verification={verification}
        onClose={() => finishVerification()}
        onContinue={() => finishVerification(true)}
        onRetry={() => void startVerification()}
        onTrust={(hostKey) => void trustAndVerify(hostKey)}
      />
    </FormCard>
  );
}

function CredentialVerificationModal({
  active,
  canRetry,
  isOpen,
  hostKeys,
  onClose,
  onContinue,
  onRetry,
  onTrust,
  preparationPending,
  trustingFingerprint,
  verification,
}: {
  active: boolean;
  canRetry: boolean;
  isOpen: boolean;
  hostKeys: TrustedHostKey[];
  onClose: () => void;
  onContinue: () => void;
  onRetry: () => void;
  onTrust: (hostKey: DiscoveredHostKey) => void;
  trustingFingerprint?: string;
  preparationPending: boolean;
  verification: CredentialVerification | null;
}) {
  const discoveredKeys = verification?.result?.discoveredHostKeys ?? [];
  const orderedDiscoveredKeys = [...discoveredKeys].sort(
    (left, right) => hostKeyPriority(left) - hostKeyPriority(right),
  );
  const recommendedHostKey = orderedDiscoveredKeys.find(
    (hostKey) => hostKey.algorithm === "ssh-ed25519",
  );
  const displayedHostKeys = recommendedHostKey
    ? [recommendedHostKey]
    : orderedDiscoveredKeys;
  const needsTrust =
    verification?.status === "failed" &&
    verification.errorCode === "HOST_KEY_NOT_TRUSTED" &&
    discoveredKeys.length > 0;
  const replacingIdentity = needsTrust && hostKeys.length > 0;

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(next) => !next && onClose()}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>
              <span className="inline-flex items-center gap-2">
                {replacingIdentity ? (
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-5 text-warning"
                    icon={Alert02Icon}
                  />
                ) : null}
                {replacingIdentity
                  ? "Server identity changed"
                  : verification?.status === "succeeded"
                    ? "SSH connection verified"
                    : "Verify SSH private key"}
              </span>
            </Modal.Heading>
            <Modal.CloseTrigger
              isDisabled={active || Boolean(trustingFingerprint)}
            />
          </Modal.Header>
          <Modal.Body>
            <div className="content-grid">
              {active || !verification ? (
                <div
                  role="status"
                  className="flex items-center gap-3 text-muted"
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-5 animate-spin"
                    icon={ReloadIcon}
                  />
                  {!verification
                    ? "Starting SSH verification…"
                    : verification.status === "queued"
                      ? "SSH verification is queued. Waiting for the server to become available…"
                      : "Connecting to the server with this private key…"}
                </div>
              ) : verification.status === "succeeded" ? (
                <p className="text-sm text-muted">
                  The private key is now saved for this server.
                </p>
              ) : needsTrust ? (
                <div className="grid gap-4">
                  {replacingIdentity ? (
                    <div className="grid gap-2 text-sm text-muted">
                      <p>
                        This can happen after a server rebuild or IP
                        reassignment, but it can also indicate an intercepted
                        connection.
                      </p>
                      <p>
                        {recommendedHostKey
                          ? "Towbar selected the ED25519 host key. Trust it to continue."
                          : "Verify and trust one of the host keys below to continue."}
                      </p>
                    </div>
                  ) : recommendedHostKey ? (
                    <p className="text-sm text-muted">
                      Towbar selected the ED25519 host key. Trust it to
                      continue.
                    </p>
                  ) : (
                    <div className="grid gap-2 text-sm text-muted">
                      <p>
                        Servers commonly present one host key for each supported
                        algorithm. You only need to trust one verified key.
                      </p>
                      <p>Trust one of the host keys below to continue.</p>
                    </div>
                  )}
                  <div className="grid gap-4">
                    {displayedHostKeys.map((hostKey) => (
                      <div
                        className="grid gap-3"
                        key={`${hostKey.algorithm}:${hostKey.fingerprint}`}
                      >
                        <div className="grid min-w-0 gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {hostKey.algorithm === "ssh-ed25519" ? (
                              <Chip size="sm" color="warning">
                                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                                  ED25519
                                </Chip.Label>
                              </Chip>
                            ) : (
                              <span className="text-xs text-muted">
                                {hostKeyAlgorithmName(hostKey.algorithm)}
                              </span>
                            )}
                          </div>
                          <code className="break-all text-sm">
                            {hostKey.fingerprint}
                          </code>
                        </div>
                        <Button
                          className="w-fit justify-self-end"
                          isDisabled={Boolean(trustingFingerprint)}
                          onPress={() => onTrust(hostKey)}
                        >
                          {trustingFingerprint === hostKey.fingerprint
                            ? "Trusting…"
                            : replacingIdentity
                              ? "Trust host key"
                              : "Trust and continue"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid gap-2">
                  <p className="font-medium text-danger">
                    SSH connection could not be verified
                  </p>
                  <p role="alert" className="text-sm text-muted">
                    {verification.errorMessage ??
                      "Check the private key and server SSH settings, then try again."}
                  </p>
                </div>
              )}
              {!active && !trustingFingerprint ? (
                <div className="flex justify-end gap-2">
                  {verification?.status === "failed" && !needsTrust ? (
                    <Button
                      variant="secondary"
                      isDisabled={!canRetry}
                      onPress={onRetry}
                    >
                      Try again
                    </Button>
                  ) : null}
                  {verification?.status === "succeeded" ? (
                    <Button onPress={preparationPending ? onContinue : onClose}>
                      {preparationPending ? "Continue server setup" : "Done"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function hostKeyPriority(hostKey: DiscoveredHostKey) {
  if (hostKey.algorithm === "ssh-ed25519") return 0;
  if (hostKey.algorithm.startsWith("ecdsa-")) return 1;
  if (hostKey.algorithm === "ssh-rsa") return 2;
  return 3;
}

function hostKeyAlgorithmName(algorithm: string) {
  if (algorithm === "ssh-ed25519") return "ED25519";
  if (algorithm === "ecdsa-sha2-nistp256") return "ECDSA P-256";
  if (algorithm === "ssh-rsa") return "RSA";
  return algorithm;
}
