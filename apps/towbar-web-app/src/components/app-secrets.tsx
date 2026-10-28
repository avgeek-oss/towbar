"use client";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { useAccess } from "./access-context";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import { usePageQuery, useQueryChoice } from "@/hooks/use-page-query";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Add01Icon,
  Delete02Icon,
  FloppyDiskIcon,
  GitBranchIcon,
  GitCommitIcon,
  LockIcon,
  Menu01Icon,
  PackageIcon,
  PlayIcon,
  SourceCodeIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";

import dynamic from "next/dynamic";
import { ResponsiveChoice } from "./responsive-choice";
import { SecretReferenceTooltip } from "./secret-reference-tooltip";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { Tabs } from "@avgeek-oss/design-system/navigation/tabs";
import {
  managedSecretKeyError,
  parseSecretEnv,
  serializeSecretEnv,
} from "@/lib/secret-env";
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { HugeiconsIcon } from "@hugeicons/react";
import type {
  App,
  AppSecretBinding,
  AppSecretStage,
  AppSecretsResponse,
} from "@workspace/towbar-web-client";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { InputGroup } from "@avgeek-oss/design-system/forms/input-group";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { FieldError } from "@avgeek-oss/design-system/forms/field";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

const CodeEditor = dynamic(() => import("./code-editor"), {
  ssr: false,
});

function isPreviewEnvironment(name: string | undefined) {
  return name === "preview" || name?.startsWith("preview:") === true;
}

function secretEnvironmentIcon(name: string | undefined) {
  return isPreviewEnvironment(name) ? GitBranchIcon : GitCommitIcon;
}

const stageLabels: Record<AppSecretStage, string> = {
  build: "Build",
  deployment: "Runtime",
  pre_deploy: "Pre-deploy",
  post_deploy: "Post-deploy",
};

type ExternalSecretSource = NonNullable<App["config"]["externalSecrets"]>;

export function AppSecrets({
  appId,
  externalSource,
  previewsEnabled,
}: {
  appId: string;
  externalSource?: ExternalSecretSource;
  previewsEnabled: boolean;
}) {
  const active = useDetailNavigation().section === "settings";
  return (
    <EnvironmentSecretSettings
      active={active}
      endpoint={`/v1/core/apps/${appId}/secrets`}
      externalSource={externalSource}
      previewsEnabled={previewsEnabled}
    />
  );
}

export function ResourceSecrets({
  resourceId,
  externalSource,
}: {
  resourceId: string;
  externalSource?: ExternalSecretSource;
}) {
  const active = useDetailNavigation().section === "settings";
  const endpoint = `/v1/core/resources/${resourceId}/secrets`;
  const query = useApiQuery<AppSecretsResponse>(active ? endpoint : null);
  if (!active) return null;
  return (
    <div className="w-full">
      <EnvironmentEditors
        endpoint={endpoint}
        externalSource={externalSource}
        query={query}
      />
    </div>
  );
}

type Query = { data?: AppSecretsResponse; error?: string; refresh: () => void };

export function WorkspaceSecrets() {
  return <SharedStoreSecrets endpoint="/v1/core/settings/secrets" />;
}

export function RepositorySecrets({ sourceId }: { sourceId: string }) {
  return (
    <SharedStoreSecrets endpoint={`/v1/core/sources/${sourceId}/secrets`} />
  );
}

function SharedStoreSecrets({ endpoint }: { endpoint: string }) {
  const query = useApiQuery<AppSecretsResponse>(endpoint);
  const [stage, setStage] = useQueryChoice(
    "stage",
    ["build", "deployment", "pre_deploy", "post_deploy"],
    "deployment",
  );
  const binding = query.data?.bindings.find((item) => item.stage === stage);
  return (
    <div className="w-full">
      <div className="mb-4 grid min-w-0 gap-2 md:w-fit">
        <p className="text-xs font-medium text-muted">Secret stage</p>
        <ResponsiveChoice
          label="Secret stage"
          value={stage}
          onChange={(value) => setStage(value as AppSecretStage)}
          options={Object.entries(stageLabels).map(([value, label]) => ({
            value,
            label,
            icon: stageIcons[value as AppSecretStage],
          }))}
        />
      </div>
      {query.error ? (
        <QueryError message={query.error} />
      ) : !query.data ? (
        <QueryLoading />
      ) : binding ? (
        <SecretVariablesEditor
          key={`${endpoint}:${binding.stage}:${binding.revision}`}
          endpoint={endpoint}
          binding={binding}
          canManage={query.data.canManageSecrets}
          canManageKeys
          onUpdated={query.refresh}
        />
      ) : null}
    </div>
  );
}

function EnvironmentSecretSettings({
  active,
  endpoint,
  externalSource,
  previewsEnabled,
}: {
  active: boolean;
  endpoint: string;
  externalSource?: ExternalSecretSource;
  previewsEnabled: boolean;
}) {
  const { search, update } = usePageQuery();
  const defaults = useApiQuery<AppSecretsResponse>(active ? endpoint : null);
  const environments = (defaults.data?.environments ?? []).filter(
    (name) => previewsEnabled || !isPreviewEnvironment(name),
  );
  const requested = search.get("environment");
  const environment =
    environments.find((name) => name === requested) ?? environments[0];
  const selectedQuery = useApiQuery<AppSecretsResponse>(
    active && environment && environment !== environments[0]
      ? `${endpoint}?environment=${encodeURIComponent(environment)}`
      : null,
    undefined,
    { keepPreviousData: false },
  );
  const query = environment === environments[0] ? defaults : selectedQuery;
  if (!active) return null;
  return (
    <div className="w-full">
      <EnvironmentEditors
        key={environment}
        endpoint={endpoint}
        externalSource={externalSource}
        query={query}
        environment={environment}
        environments={environments}
        onEnvironmentChange={(value) =>
          update({ environment: value === environments[0] ? null : value })
        }
      />
    </div>
  );
}

function secretEnvironmentLabel(name: string) {
  return isPreviewEnvironment(name) ? "preview" : "mainline";
}

const stageIcons = {
  build: PackageIcon,
  deployment: PlayIcon,
  pre_deploy: ArrowLeft01Icon,
  post_deploy: ArrowRight01Icon,
};

function EnvironmentEditors({
  query,
  endpoint,
  environment,
  externalSource,
  onEnvironmentChange,
  environments = [],
}: {
  query: Query;
  endpoint: string;
  environment?: string;
  externalSource?: ExternalSecretSource;
  environments?: string[];
  onEnvironmentChange?: (value: string) => void;
}) {
  const [stage, setStage] = useQueryChoice(
    "stage",
    ["build", "deployment", "pre_deploy", "post_deploy"],
    "deployment",
  );
  const data = query.data;
  const binding =
    data?.bindings.find((item) => item.stage === stage) ?? data?.bindings[0];
  if (data && !data.environments.length)
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No connected environments</EmptyState.Title>
          <EmptyState.Description>
            Connect a repository environment to configure its shared secrets.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-wrap items-end gap-4">
        {environments.length > 1 && environment && onEnvironmentChange ? (
          <div className="grid w-full min-w-0 gap-2 md:w-auto">
            <p className="text-xs font-medium text-muted">Target</p>
            <ResponsiveChoice
              label="Target"
              value={environment}
              onChange={onEnvironmentChange}
              options={environments.map((name) => ({
                value: name,
                label: secretEnvironmentLabel(name),
                icon: secretEnvironmentIcon(name),
              }))}
            />
          </div>
        ) : null}
        {binding && data ? (
          <div className="grid w-full min-w-0 gap-2 md:w-auto">
            <p className="text-xs font-medium text-muted">Secret stage</p>
            <ResponsiveChoice
              label="Secret stage"
              value={binding.stage}
              options={data.bindings.map((item) => ({
                value: item.stage,
                label: stageLabels[item.stage],
                icon: stageIcons[item.stage],
              }))}
              onChange={(value) => setStage(value as AppSecretStage)}
            />
          </div>
        ) : null}
      </div>
      {binding?.stage === "deployment" && externalSource ? (
        <ExternalSecretSourceCard source={externalSource} />
      ) : null}
      {query.error ? (
        <QueryError message={query.error} />
      ) : !data ? (
        <QueryLoading />
      ) : binding &&
        !(
          externalSource &&
          binding.stage === "deployment" &&
          !binding.keys.length
        ) ? (
        <SecretVariablesEditor
          key={`${endpoint}:${binding.environment}:${binding.stage}:${binding.revision}:${binding.inheritedRevisions.global}:${binding.inheritedRevisions.repository}`}
          endpoint={endpoint}
          binding={binding}
          canManage={data.canManageSecrets}
          onUpdated={query.refresh}
        />
      ) : null}
    </div>
  );
}

function ExternalSecretSourceCard({
  source,
}: {
  source: ExternalSecretSource;
}) {
  const provider = source.integration;
  return (
    <Attributes
      icon={<IntegrationProviderLogo provider={provider} />}
      columns={2}
      title="External secret source"
      variant="card"
    >
      <Attributes.Item label="Provider">
        {provider === "infisical" ? "Infisical" : "Doppler"}
      </Attributes.Item>
      <Attributes.Item label="Project">
        <TypographyCode className="break-all">{source.project}</TypographyCode>
      </Attributes.Item>
      {source.integration === "infisical" ? (
        <>
          <Attributes.Item label="Environment slug">
            <TypographyCode>{source.environmentSlug ?? "prod"}</TypographyCode>
          </Attributes.Item>
          <Attributes.Item label="Secret path">
            <TypographyCode className="break-all">
              {source.secretPath ?? "/"}
            </TypographyCode>
          </Attributes.Item>
        </>
      ) : (
        <Attributes.Item label="Config">
          {source.config ? (
            <TypographyCode>{source.config}</TypographyCode>
          ) : (
            "Service token scope"
          )}
        </Attributes.Item>
      )}
      <Attributes.Item className="col-span-full" label="Runtime values">
        Fetched at deployment; never displayed here
      </Attributes.Item>
    </Attributes>
  );
}

function SecretVariablesEditor({
  binding,
  endpoint,
  canManage,
  canManageKeys = false,
  onUpdated,
}: {
  binding: AppSecretBinding;
  endpoint: string;
  canManage: boolean;
  canManageKeys?: boolean;
  onUpdated: () => void;
}) {
  const { can } = useAccess();
  const canReveal = can("admin");
  const [busyAction, setBusyAction] = useState<"mode" | "save" | null>(null);
  const busy = busyAction !== null;
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const [deletedKeys, setDeletedKeys] = useState<string[]>([]);
  const [newEntries, setNewEntries] = useState<
    Array<{ id: string; key: string; value: string }>
  >([]);
  const [error, setError] = useState<string>();
  const [fileMode, setFileMode] = useState(false);
  const [fileText, setFileText] = useState("");
  const [initialFile, setInitialFile] = useState("");
  const originalValues = useRef(new Map<string, string>());
  const modeRequest = useRef(0);
  useEffect(
    () => () => {
      modeRequest.current++;
    },
    [],
  );
  useLayoutEffect(() => {
    modeRequest.current++;
    setFileMode(false);
    setFileText("");
    setInitialFile("");
    originalValues.current.clear();
  }, [canReveal]);
  const revealReference = useCallback(
    async (scope: "globals" | "repo", key: string) => {
      if (!can("admin") || (scope === "repo" && !binding.repositoryId))
        throw new Error("You don't have permission to view this value");
      const result = await api.post<{ value: string }>(
        `${scope === "globals" ? "/v1/core/settings/secrets" : `/v1/core/sources/${binding.repositoryId}/secrets`}/production/${binding.stage}/reveal`,
        { key },
      );
      return result.value;
    },
    [can, binding.repositoryId, binding.stage],
  );
  const keys = [...binding.keys].sort();
  const visibleKeys = keys.filter((key) => !deletedKeys.includes(key));
  const emptyStage = !fileMode && !keys.length && !newEntries.length;
  const hasChanges =
    (fileMode &&
      (fileText !== initialFile || Boolean(binding.missingKeys?.length))) ||
    Object.keys(replacements).length > 0 ||
    deletedKeys.length > 0 ||
    newEntries.length > 0;
  useUnsavedChanges(hasChanges);

  function fileChanges() {
    const values = parseSecretEnv(fileText);
    if (!canManageKeys) {
      const keyError = managedSecretKeyError(keys, values.keys());
      if (keyError) throw new Error(keyError);
    }
    const replacement: Record<string, string> = Object.create(null);
    for (const [key, value] of values) {
      if (value === "••••••••" && originalValues.current.get(key) !== value)
        throw new Error("Replace the masked value with a secret or reference");
      if (value !== originalValues.current.get(key)) replacement[key] = value;
    }
    return {
      set: replacement,
      delete: canManageKeys
        ? keys.filter((key) => !values.has(key))
        : ([] as string[]),
    };
  }

  async function toggleMode() {
    if (busy) return;
    const request = ++modeRequest.current;
    setBusyAction("mode");
    try {
      if (fileMode) {
        const changes = fileChanges();
        setReplacements(
          Object.fromEntries(
            Object.entries(changes.set).filter(([key]) => keys.includes(key)),
          ),
        );
        setDeletedKeys(changes.delete);
        setNewEntries(
          Object.entries(changes.set)
            .filter(([key]) => !keys.includes(key))
            .map(([key, value]) => ({ id: crypto.randomUUID(), key, value })),
        );
        setFileText("");
        originalValues.current.clear();
      } else {
        const result =
          keys.length && canReveal
            ? await api.post<{
                values: Record<string, string>;
                revision: string | null;
              }>(
                `${endpoint}/${binding.environment}/${binding.stage}/reveal-all`,
                {},
              )
            : {
                values: Object.fromEntries(
                  keys
                    .filter((key) => !binding.missingKeys?.includes(key))
                    .map((key) => [key, "••••••••"]),
                ),
                revision: binding.revision,
              };
        if (request !== modeRequest.current) return;
        if (result.revision !== binding.revision)
          throw new Error("Secrets changed. Refresh before opening file mode.");
        const entries: Array<[string, string]> = [];
        const stored = new Map<string, string>();
        for (const key of keys) {
          if (
            !Object.hasOwn(result.values, key) &&
            !binding.missingKeys?.includes(key)
          )
            throw new Error(
              "Secrets changed. Refresh before opening file mode.",
            );
          if (Object.hasOwn(result.values, key))
            stored.set(key, result.values[key]!);
          if (!deletedKeys.includes(key))
            entries.push([
              key,
              Object.hasOwn(replacements, key)
                ? replacements[key]!
                : (result.values[key] ?? ""),
            ]);
        }
        entries.push(
          ...newEntries.map((entry): [string, string] => [
            entry.key,
            entry.value,
          ]),
        );
        const text = serializeSecretEnv(entries);
        const originalText = serializeSecretEnv(
          keys.map((key) => [key, result.values[key] ?? ""]),
        );
        parseSecretEnv(text);
        originalValues.current = stored;
        setFileText(text);
        setInitialFile(originalText);
      }
      setError(undefined);
      setFileMode(!fileMode);
    } catch (failure) {
      if (request === modeRequest.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not open file mode.",
        );
    } finally {
      if (request === modeRequest.current) setBusyAction(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let mutation: { set: Record<string, string>; delete: string[] };
    try {
      if (fileMode) mutation = fileChanges();
      else {
        const added: Record<string, string> = Object.create(null);
        for (const entry of newEntries) {
          const key = entry.key.trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
            throw new Error(
              "Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.",
            );
          if (keys.includes(key) || Object.hasOwn(added, key))
            throw new Error(`Variable ${key} already exists.`);
          added[key] = entry.value;
        }
        mutation = {
          set: { ...replacements, ...added },
          delete: deletedKeys,
        };
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Check the .env file.",
      );
      return;
    }
    if (!Object.keys(mutation.set).length && !mutation.delete.length) {
      setError("Change at least one secret.");
      return;
    }
    setBusyAction("save");
    setError(undefined);
    try {
      await api.patch(`${endpoint}/${binding.environment}/${binding.stage}`, {
        expectedRevision: binding.revision,
        ...mutation,
      });
      setReplacements({});
      setDeletedKeys([]);
      setNewEntries([]);
      setFileMode(false);
      setFileText("");
      toast.success("Secrets saved. Changes apply on the next deployment.");
      onUpdated();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Secrets could not be saved",
      );
    } finally {
      setBusyAction(null);
    }
  }

  function addVariable() {
    setNewEntries((current) => [
      ...current,
      { id: crypto.randomUUID(), key: "", value: "" },
    ]);
  }

  const stageLabel = stageLabels[binding.stage];
  return (
    <form onSubmit={submit}>
      <Widget className="min-w-0">
        <Widget.Header>
          <Widget.Title help={false}>{stageLabel} secrets</Widget.Title>
        </Widget.Header>
        <Widget.Content className="content-grid min-w-0">
          {fileMode && binding.missingKeys?.length ? (
            <p className="text-sm text-muted">
              Required keys without saved values appear blank. Saving a blank
              value sets it to an intentionally empty string.
            </p>
          ) : null}
          <Tabs
            selectedKey={fileMode ? "file" : "form"}
            onSelectionChange={(key) => {
              if ((key === "file") !== fileMode) void toggleMode();
            }}
          >
            <Tabs.ListContainer
              className={keys.length > 0 ? "mb-2 w-fit" : "hidden"}
            >
              <Tabs.List aria-label="Secret editing mode">
                <Tabs.Tab
                  id="form"
                  className="min-w-0 gap-2 px-3"
                  isDisabled={busy}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={Menu01Icon}
                    size={16}
                  />
                  Form
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab
                  id="file"
                  className="min-w-0 gap-2 px-3"
                  isDisabled={busy || !canManage}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={SourceCodeIcon}
                    size={16}
                  />
                  Editor
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel
              id={fileMode ? "file" : "form"}
              key={fileMode ? "file" : "form"}
              className="content-grid m-0 min-w-0 p-0"
            >
              {fileMode ? (
                <div className="grid min-w-0 gap-3">
                  <CodeEditor
                    value={fileText}
                    onChange={setFileText}
                    disabled={busy}
                    revealReference={can("admin") ? revealReference : undefined}
                    readOnlyLinePrefixes={
                      canManageKeys ? undefined : keys.map((key) => `${key}=`)
                    }
                  />
                </div>
              ) : null}
              {emptyStage ? (
                <EmptyState>
                  <EmptyState.Header>
                    <EmptyState.Title>
                      No {stageLabel.toLowerCase()} secrets
                    </EmptyState.Title>
                    <EmptyState.Description className="max-w-sm text-pretty">
                      {canManageKeys
                        ? "Add a variable to share it with workloads that reference it."
                        : "Declare required keys in the entity YAML and sync this environment."}
                    </EmptyState.Description>
                  </EmptyState.Header>
                  {canManage && canManageKeys ? (
                    <EmptyState.Content>
                      <Button
                        type="button"
                        variant="secondary"
                        isDisabled={busy}
                        onPress={addVariable}
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          icon={Add01Icon}
                          className="size-4 shrink-0"
                        />
                        Add variable
                      </Button>
                    </EmptyState.Content>
                  ) : null}
                </EmptyState>
              ) : null}
              {!fileMode &&
              (visibleKeys.length > 0 || newEntries.length > 0) ? (
                <div className="grid gap-4 sm:gap-1">
                  {visibleKeys.map((key) => {
                    const configured =
                      !Object.hasOwn(replacements, key) &&
                      !binding.missingKeys?.includes(key);
                    const reveal = canReveal
                      ? async () => {
                          const result = await api.post<{
                            value: string;
                            revision: string | null;
                          }>(
                            `${endpoint}/${binding.environment}/${binding.stage}/reveal`,
                            { key },
                          );
                          if (result.revision !== binding.revision)
                            throw new Error(
                              "This secret changed. Refresh before viewing it.",
                            );
                          return result.value;
                        }
                      : undefined;
                    return (
                      <div
                        key={key}
                        className="grid min-w-0 gap-2 sm:grid-cols-2"
                      >
                        <div className="flex min-h-10 min-w-0 items-center gap-2">
                          <span className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-sm">
                              {key}
                            </span>
                            {binding.inheritedOrigins[key] ? (
                              <TooltipText
                                className="inline-flex"
                                tooltip={`This value comes from ${binding.inheritedOrigins[key]} and can be overridden here.`}
                              >
                                <Chip size="sm" color="default">
                                  <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                                    Inherited from{" "}
                                    {binding.inheritedOrigins[key]}
                                  </Chip.Label>
                                </Chip>
                              </TooltipText>
                            ) : binding.missingKeys?.includes(key) ? (
                              <TooltipText
                                className="inline-flex"
                                tooltip="This declared key does not have a saved value in the selected environment and stage."
                              >
                                <Chip size="sm" color="warning">
                                  <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                                    Missing
                                  </Chip.Label>
                                </Chip>
                              </TooltipText>
                            ) : null}
                          </span>
                          {canManageKeys ? (
                            <SecretRowDeleteButton
                              className="sm:hidden"
                              label={`Remove ${key}`}
                              disabled={!canManage || busy}
                              onPress={() =>
                                setDeletedKeys((current) => [...current, key])
                              }
                            />
                          ) : null}
                          <span
                            aria-hidden="true"
                            className="hidden min-w-0 flex-1 border-t border-dashed border-muted/50 lg:block"
                          />
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <SecretValueInput
                              label={`Value for ${key}`}
                              value={replacements[key] ?? ""}
                              configured={configured}
                              disabled={!canManage || busy}
                              reveal={reveal}
                              revealReference={
                                can("admin") ? revealReference : undefined
                              }
                              onChange={(value) =>
                                setReplacements((current) => ({
                                  ...current,
                                  [key]: value,
                                }))
                              }
                            />
                          </div>
                          {canManageKeys ? (
                            <SecretRowDeleteButton
                              className="hidden sm:inline-flex"
                              label={`Remove ${key}`}
                              disabled={!canManage || busy}
                              onPress={() =>
                                setDeletedKeys((current) => [...current, key])
                              }
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {newEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="grid min-w-0 gap-2 sm:grid-cols-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Input
                          aria-label="Variable name"
                          className="min-w-0 flex-1 font-mono"
                          variant="secondary"
                          placeholder="VARIABLE_NAME"
                          autoComplete="off"
                          spellCheck={false}
                          value={entry.key}
                          disabled={!canManage || busy}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setNewEntries((current) =>
                              current.map((item) =>
                                item.id === entry.id
                                  ? { ...item, key: value }
                                  : item,
                              ),
                            );
                          }}
                        />
                        <SecretRowDeleteButton
                          className="sm:hidden"
                          label="Remove new variable"
                          disabled={!canManage || busy}
                          onPress={() =>
                            setNewEntries((current) =>
                              current.filter((item) => item.id !== entry.id),
                            )
                          }
                        />
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <SecretValueInput
                            label={`Value for ${entry.key || "new variable"}`}
                            value={entry.value}
                            disabled={!canManage || busy}
                            onChange={(value) =>
                              setNewEntries((current) =>
                                current.map((item) =>
                                  item.id === entry.id
                                    ? { ...item, value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </div>
                        <SecretRowDeleteButton
                          className="hidden sm:inline-flex"
                          label="Remove new variable"
                          disabled={!canManage || busy}
                          onPress={() =>
                            setNewEntries((current) =>
                              current.filter((item) => item.id !== entry.id),
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {error ? (
                <FieldError className="whitespace-pre-line">{error}</FieldError>
              ) : null}
              {canManage &&
              !emptyStage &&
              (fileMode || keys.length > 0 || canManageKeys) ? (
                <div className="flex flex-wrap gap-2">
                  {!fileMode && canManageKeys ? (
                    <Button
                      type="button"
                      variant="secondary"
                      isDisabled={busy}
                      onPress={addVariable}
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={Add01Icon}
                        className="size-4 shrink-0"
                      />
                      Add variable
                    </Button>
                  ) : null}
                  <Button type="submit" isDisabled={busy || !hasChanges}>
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={FloppyDiskIcon}
                      className="size-4 shrink-0"
                    />
                    {busyAction === "save" ? "Saving…" : "Save"}
                  </Button>
                </div>
              ) : null}
            </Tabs.Panel>
          </Tabs>
        </Widget.Content>
      </Widget>
    </form>
  );
}

function SecretRowDeleteButton({
  className,
  label,
  disabled,
  onPress,
}: {
  className: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      type="button"
      isIconOnly
      variant="ghost"
      className={className}
      aria-label={label}
      isDisabled={disabled}
      onPress={onPress}
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={Delete02Icon}
        className="size-4 shrink-0"
      />
    </Button>
  );
}

function SecretValueInput({
  label,
  value,
  configured = false,
  disabled,
  reveal,
  revealReference,
  onChange,
}: {
  label: string;
  value: string;
  configured?: boolean;
  disabled: boolean;
  reveal?: () => Promise<string>;
  revealReference?: (scope: "globals" | "repo", key: string) => Promise<string>;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(!configured);
  const [stored, setStored] = useState<string>();
  const [loading, setLoading] = useState(false);
  const request = useRef({ generation: 0 });
  useEffect(() => {
    const state = request.current;
    const hide = () => {
      state.generation++;
      setVisible(false);
      setStored(undefined);
      setLoading(false);
    };
    window.addEventListener("blur", hide);
    return () => {
      state.generation++;
      window.removeEventListener("blur", hide);
    };
  }, []);
  async function toggle() {
    const current = ++request.current.generation;
    if (visible) {
      setVisible(false);
      setStored(undefined);
      return;
    }
    if (!configured) {
      setVisible(true);
      return;
    }
    if (!reveal) return;
    setLoading(true);
    try {
      const revealed = await reveal();
      if (request.current.generation !== current) return;
      setStored(revealed);
      setVisible(true);
    } catch (error) {
      if (request.current.generation === current)
        toast.danger(
          error instanceof Error
            ? error.message
            : "Secret could not be revealed",
        );
    } finally {
      if (request.current.generation === current) setLoading(false);
    }
  }
  const displayedValue = visible ? (configured ? (stored ?? "") : value) : "";
  const hasReference =
    visible &&
    /\{\{\s*(?:globals|repo)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/u.test(
      displayedValue,
    );
  const references = [
    ...displayedValue.matchAll(
      /\{\{\s*(globals|repo)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
    ),
  ];
  const referenceKey =
    visible && references.length === 1 ? references[0]?.[2] : undefined;
  const input = (
    <InputGroup fullWidth variant="secondary">
      <InputGroup.Prefix>
        <HugeiconsIcon aria-hidden="true" icon={LockIcon} size={16} />
      </InputGroup.Prefix>
      <InputGroup.Input
        aria-label={label}
        className={hasReference ? "secret-reference" : undefined}
        type="text"
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore
        spellCheck={false}
        placeholder={
          visible
            ? configured
              ? ""
              : "Value or reference"
            : configured || value
              ? "••••••••"
              : "Reveal to enter a value"
        }
        value={displayedValue}
        disabled={disabled || loading}
        readOnly={!visible}
        onChange={(event) => {
          if (!visible) return;
          const nextValue = event.currentTarget.value;
          setStored(undefined);
          onChange(nextValue);
        }}
      />
      <InputGroup.Suffix className="pl-0 pr-1">
        {!configured || reveal ? (
          <Button
            type="button"
            isIconOnly
            variant="ghost"
            aria-label={`${visible ? "Hide" : "Reveal"} ${label.toLowerCase()}`}
            aria-pressed={visible}
            isDisabled={disabled || loading}
            onPress={() => void toggle()}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={visible ? ViewOffSlashIcon : ViewIcon}
              size={18}
            />
          </Button>
        ) : null}
      </InputGroup.Suffix>
    </InputGroup>
  );
  return referenceKey ? (
    <SecretReferenceTooltip
      key={references[0]?.[0]}
      reference={{
        scope: references[0]![1] as "globals" | "repo",
        key: referenceKey,
      }}
      reveal={
        revealReference
          ? () =>
              revealReference(
                references[0]![1] as "globals" | "repo",
                referenceKey,
              )
          : undefined
      }
    >
      {input}
    </SecretReferenceTooltip>
  ) : (
    input
  );
}
