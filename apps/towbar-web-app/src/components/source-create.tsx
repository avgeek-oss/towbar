"use client";
import { useAccess } from "./access-context";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import {
  Add01Icon,
  Shield01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";

import { HugeiconsIcon } from "@hugeicons/react";

import { useRouter } from "@/hooks/use-guarded-router";
import { useState } from "react";
import type {
  GitHubConnectionMetadata,
  GitHubRepository,
  Source,
} from "@workspace/towbar-web-client";
import { Button, ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import { ListBox } from "@avgeek-oss/design-system/collections/list-box";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Select } from "@avgeek-oss/design-system/forms/select";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";

import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { SourceBranchSelect } from "./source-branch-select";

export function SourceCreateModal({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>
              <span className="flex items-center gap-2">
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  className="size-5"
                  aria-hidden="true"
                />
                Add repository
              </span>
            </Modal.Heading>
            <Modal.CloseTrigger isDisabled={busy} />
          </Modal.Header>
          <Modal.Body>
            <SourceCreate busy={busy} setBusy={setBusy} onClose={onClose} />
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function SourceCreate({
  busy,
  setBusy,
  onClose,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { can } = useAccess();
  const [account, setAccount] = useState("all");
  const connection = useApiQuery<{ connections: GitHubConnectionMetadata[] }>(
    "/v1/core/github/installation",
  );
  const repositoryPath = connection.data?.connections.length
    ? `/v1/core/github/repositories${account === "all" ? "" : `?${new URLSearchParams({ connectionId: account })}`}`
    : null;
  const repositories = useApiQuery<{
    repositories: GitHubRepository[];
    identityWarnings?: string[];
    unavailableConnections?: {
      id: string;
      accountLogin: string;
      message: string;
    }[];
  }>(repositoryPath, undefined, { keepPreviousData: false });
  const [fullName, setFullName] = useState("");
  const [owner, repository] = fullName.split("/");
  const selectedRepository = repositories.data?.repositories.find(
    (repo) => repo.fullName === fullName,
  );
  const branches = useApiQuery<{ branches: string[] }>(
    fullName && selectedRepository
      ? `/v1/core/github/branches?${new URLSearchParams({ owner: owner ?? "", repository: repository ?? "", ...(selectedRepository.connectionId ? { connectionId: selectedRepository.connectionId } : {}) })}`
      : null,
    undefined,
    { keepPreviousData: false },
  );

  const [customEnvironment, setCustomEnvironment] = useState("");
  const [discovered, setDiscovered] = useState<
    { name: string; previewsEnabled: boolean }[] | null
  >(null);
  const [selectedEnvironments, setSelectedEnvironments] = useState<string[]>(
    [],
  );
  const [mappings, setMappings] = useState<Record<string, string>>({});
  function addEnvironment() {
    const name = customEnvironment.trim();
    if (
      busy ||
      !name ||
      !discovered ||
      discovered.some((item) => item.name === name)
    )
      return;
    setDiscovered([...discovered, { name, previewsEnabled: false }]);
    setSelectedEnvironments([...selectedEnvironments, name]);
    setCustomEnvironment("");
  }
  if (connection.error && !connection.data)
    return (
      <>
        <QueryError message={connection.error} />
      </>
    );
  if (!connection.data)
    return (
      <>
        <QueryLoading />
      </>
    );
  if (!connection.data.connections.some((item) => !item.suspendedAt))
    return (
      <div className="grid gap-6">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>GitHub not connected</EmptyState.Title>
            <EmptyState.Description>
              Install the GitHub App before adding a Repository.
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            {can("integration.manage") ? (
              <ButtonLink href="/manage/integrations/github">
                <IntegrationProviderLogo provider="github" className="invert" />
                Open GitHub integration
              </ButtonLink>
            ) : (
              <p className="text-muted">
                Ask an Admin to connect GitHub before adding a repository.
              </p>
            )}
          </EmptyState.Content>
        </EmptyState>
      </div>
    );
  const accountSelection = (
    <Select
      fullWidth
      variant="secondary"
      selectedKey={account}
      isDisabled={busy}
      onSelectionChange={(key) => {
        setAccount(String(key));
        setFullName("");
        setDiscovered(null);
        setSelectedEnvironments([]);
        setMappings({});
      }}
    >
      <Label>GitHub account</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id="all" textValue="All connected accounts">
            All connected accounts
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {connection.data.connections
            .filter((item) => !item.suspendedAt)
            .map((item) => (
              <ListBox.Item
                key={item.id}
                id={item.id}
                textValue={item.accountLogin}
              >
                {item.accountLogin}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
  const unavailableAccounts = repositories.data?.unavailableConnections
    ?.length ? (
    <p role="status" className="text-sm text-danger">
      {repositories.data.unavailableConnections
        .map((item) => `${item.accountLogin}: ${item.message}`)
        .join("; ")}
    </p>
  ) : null;
  if (repositories.error)
    return (
      <>
        {accountSelection}
        <QueryError message={repositories.error} />
      </>
    );
  if (!repositories.data)
    return (
      <div className="grid gap-6">
        {accountSelection}
        <QueryLoading />
      </div>
    );
  if (repositories.data.repositories.length === 0)
    return (
      <div className="grid gap-6">
        {accountSelection}
        {unavailableAccounts}
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>No repositories available</EmptyState.Title>
            <EmptyState.Description>
              Grant the selected GitHub connection access to at least one
              repository, then return here.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </div>
    );
  const githubInstallationId = selectedRepository?.connectionId;
  const selected = repositories.data.repositories.find(
    (repo) => repo.fullName === fullName,
  );
  const environmentsToConnect = (discovered ?? []).filter((environment) =>
    selectedEnvironments.includes(environment.name),
  );
  const invalidSelection = Boolean(
    discovered &&
    (!environmentsToConnect.length ||
      environmentsToConnect.some(
        (environment) => !mappings[environment.name]?.trim(),
      )),
  );
  return (
    <form
      className="grid gap-6 pt-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!selected || busy || invalidSelection) return;
        setBusy(true);
        try {
          const repository = {
            provider: "github",
            githubInstallationId: githubInstallationId!,
            repositoryName: selected.name,
            repositoryOwner: selected.owner,
          };
          const result = await api.post<{
            source: Source;
            syncs: { error: string | null }[];
          }>("/v1/core/sources/connect", {
            ...repository,
            environments: environmentsToConnect.map((environment) => ({
              environment: environment.name,
              branch: mappings[environment.name]?.trim(),
            })),
          });
          if (result.syncs.some((sync) => sync.error)) {
            toast.danger("Repository connected; some syncs need retry", {
              description: "Open the environment to retry its initial sync.",
            });
          } else toast.success("Repository connected");
          refreshApiQueries();
          onClose();
          router.push(`/repositories/${result.source.id}`);
        } catch (caught) {
          toast.danger(
            discovered
              ? "Couldn't connect repository"
              : "Couldn't read configuration",
            {
              description:
                caught instanceof Error ? caught.message : "The request failed",
            },
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-6">
        {accountSelection}
        {unavailableAccounts}
        {repositories.data.identityWarnings?.map((message) => (
          <p key={message} role="status" className="text-sm text-muted">
            {message}
          </p>
        ))}
        <div className="grid min-w-0 gap-6">
          <Select
            aria-required={true}
            fullWidth
            isDisabled={busy}
            selectedKey={fullName || null}
            variant="secondary"
            onSelectionChange={async (value) => {
              const name = String(value ?? "");
              setFullName(name);
              setDiscovered(null);
              setSelectedEnvironments([]);
              setMappings({});
              setCustomEnvironment("");
              const repository = repositories.data?.repositories.find(
                (repo) => repo.fullName === name,
              );
              if (!repository) return;
              setBusy(true);
              try {
                const result = await api.post<{
                  environments: {
                    name: string;
                    previewsEnabled: boolean;
                  }[];
                }>("/v1/core/sources/discover", {
                  provider: "github",
                  githubInstallationId: repository.connectionId!,
                  repositoryOwner: repository.owner,
                  repositoryName: repository.name,
                  discoveryBranch: repository.defaultBranch,
                });
                const productionWasDiscovered = result.environments.some(
                  (environment) => environment.name === "production",
                );
                const discoveredEnvironments = productionWasDiscovered
                  ? result.environments
                  : [
                      { name: "production", previewsEnabled: false },
                      ...result.environments,
                    ];
                setDiscovered(discoveredEnvironments);
                setSelectedEnvironments(
                  discoveredEnvironments.map((environment) => environment.name),
                );
                setMappings(
                  Object.fromEntries(
                    discoveredEnvironments.map((environment) => [
                      environment.name,
                      environment.name === "production" &&
                      productionWasDiscovered
                        ? repository.defaultBranch
                        : "",
                    ]),
                  ),
                );
              } catch {
                setDiscovered([{ name: "production", previewsEnabled: false }]);
                setSelectedEnvironments(["production"]);
                setMappings({ production: "" });
              } finally {
                setBusy(false);
              }
            }}
          >
            <Label isRequired>Repository</Label>
            <Select.Trigger>
              <Select.Value className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {selected?.fullName ?? "Choose a repository"}
                </span>
                {selected?.private ? (
                  <span
                    className="flex shrink-0 items-center gap-1.5 text-xs text-muted"
                    title="Private repository"
                  >
                    <HugeiconsIcon
                      icon={Shield01Icon}
                      className="size-4"
                      aria-hidden="true"
                    />
                  </span>
                ) : null}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="w-(--trigger-width) min-w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden">
              <Autocomplete.Filter
                filter={(text, search) =>
                  text
                    .toLocaleLowerCase()
                    .includes(search.trim().toLocaleLowerCase())
                }
              >
                <SearchField
                  aria-label="Search repositories"
                  className="px-2 pt-2"
                  variant="secondary"
                >
                  <SearchField.Group className="rounded-md">
                    <SearchField.SearchIcon />
                    <SearchField.Input
                      className="text-base sm:text-sm"
                      placeholder="Search repositories…"
                      maxLength={200}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus={
                        typeof window !== "undefined" &&
                        window.matchMedia("(pointer: fine)").matches
                      }
                    />
                    <SearchField.ClearButton aria-label="Clear repository search" />
                  </SearchField.Group>
                </SearchField>
                <ListBox>
                  {repositories.data.repositories.map((repo) => (
                    <ListBox.Item
                      key={repo.id}
                      id={repo.fullName}
                      textValue={repo.fullName}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {repo.fullName}
                      </span>
                      {repo.private ? (
                        <span
                          aria-label="Private repository"
                          className="ml-auto mr-6 flex shrink-0 items-center text-muted"
                          title="Private repository"
                        >
                          <HugeiconsIcon
                            icon={Shield01Icon}
                            className="size-4"
                            aria-hidden="true"
                          />
                        </span>
                      ) : null}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Autocomplete.Filter>
            </Select.Popover>
          </Select>
        </div>
        {discovered ? (
          <div className="grid min-w-0 gap-4">
            <div className="grid min-w-0 gap-3">
              {branches.error ? (
                <p className="text-sm text-danger">
                  Could not load branches: {branches.error}
                </p>
              ) : null}
              <div
                className="hidden gap-4 text-xs text-muted sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                aria-hidden="true"
              >
                <span>Environment</span>
                <span>
                  Deployment branch{" "}
                  <span aria-hidden="true" className="text-danger">
                    *
                  </span>
                </span>
              </div>
              {discovered.map((environment) => (
                <div
                  key={environment.name}
                  className="grid grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                >
                  <div className="col-start-1 row-start-1 flex min-h-9 min-w-0 items-center">
                    <Checkbox
                      variant="secondary"
                      isDisabled={busy}
                      isSelected={selectedEnvironments.includes(
                        environment.name,
                      )}
                      onChange={(checked) => {
                        const name = environment.name;
                        setSelectedEnvironments((current) =>
                          checked
                            ? [...current, name]
                            : current.filter((item) => item !== name),
                        );
                        if (
                          !checked &&
                          name !== "production" &&
                          name !== "staging"
                        ) {
                          setDiscovered(
                            (current) =>
                              current?.filter((item) => item.name !== name) ??
                              [],
                          );
                          setMappings((current) => {
                            const next = { ...current };
                            delete next[name];
                            return next;
                          });
                        }
                      }}
                    >
                      <Checkbox.Content>
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        <Label>{environment.name}</Label>
                      </Checkbox.Content>
                    </Checkbox>
                  </div>
                  <div className="relative row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                    <SourceBranchSelect
                      ariaLabel={`${environment.name} deployment branch`}
                      branches={branches.data?.branches ?? []}
                      disabled={
                        busy || !selectedEnvironments.includes(environment.name)
                      }
                      required={selectedEnvironments.includes(environment.name)}
                      value={mappings[environment.name] ?? ""}
                      onChange={(branch) => {
                        setMappings((current) => ({
                          ...current,
                          [environment.name]: branch,
                        }));
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {discovered ? (
              <div className="grid gap-2 border-t border-separator pt-4">
                <Label htmlFor="new-environment">Add another environment</Label>
                <div className="flex max-w-xl flex-wrap gap-2">
                  <Input
                    id="new-environment"
                    className="min-w-0 flex-1"
                    variant="secondary"
                    value={customEnvironment}
                    disabled={busy}
                    placeholder="e.g. qa"
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        addEnvironment();
                      }
                    }}
                    onChange={(event) =>
                      setCustomEnvironment(event.target.value)
                    }
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    isDisabled={
                      busy ||
                      !customEnvironment.trim() ||
                      discovered.some(
                        (item) => item.name === customEnvironment.trim(),
                      )
                    }
                    onPress={addEnvironment}
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      className="size-4"
                      aria-hidden="true"
                    />
                    Add environment
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button
          className="w-fit shrink-0"
          isDisabled={!selected || !discovered || busy || invalidSelection}
          type="submit"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={Add01Icon}
            className="size-4 shrink-0"
          />
          {busy ? "Loading…" : "Connect and Validate"}
        </Button>
      </div>
    </form>
  );
}
