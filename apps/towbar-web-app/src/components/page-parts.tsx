"use client";
import { useRefreshFailures } from "@/hooks/query-refresh-failures";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { pushPage, assignPage } from "@/lib/unsaved-navigation";
import { useAccess } from "./access-context";
import type { Action } from "@workspace/towbar-access";
import {
  PageSelectionContext,
  PageSelectionTitle,
  type PageSelection,
} from "./page-selection-title";
import { DetailSettingsContext, SecondaryItems } from "./secondary-sidebar";
import { FloppyDiskIcon } from "@hugeicons/core-free-icons";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  HeadingHelp,
  type HeadingDocumentation,
} from "@avgeek-oss/design-system/overlays/heading-help";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import { SecondaryEntityHeader } from "./secondary-sidebar";
import { Children, useEffect } from "react";
import type { ComponentProps, FormEvent, Key, ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useId, useState } from "react";

import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@avgeek-oss/design-system/forms/field";
import { PasswordInput } from "@avgeek-oss/design-system/forms/password-input";
import { Input } from "@avgeek-oss/design-system/forms/input";
import type { InputProps } from "@avgeek-oss/design-system/forms/input";
import { Textarea } from "@avgeek-oss/design-system/forms/textarea";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { Page, PageSection } from "@avgeek-oss/design-system/layouts/page";
import { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import type { AppShellBreadcrumbItems } from "@avgeek-oss/design-system/layouts/application-shell-types";
import { cn } from "@avgeek-oss/design-system/lib/utils";
import { ApplicationPage } from "@avgeek-oss/design-system/patterns/pages/page";
import type { BreadcrumbAncestors } from "@avgeek-oss/design-system/patterns/pages/page";

import { refreshApiQueries } from "@/hooks/use-api-query";
import {
  BreadcrumbEntitySwitcher,
  type BreadcrumbEntityKind,
} from "./breadcrumb-entity-switcher";

const appBreadcrumb = [{ href: "/", label: "Towbar" }] as const;
export const sourcesBreadcrumb = [
  ...appBreadcrumb,
  { href: "/repositories", label: "Repositories" },
] as BreadcrumbAncestors;
export const appsBreadcrumb = [
  ...appBreadcrumb,
  { href: "/services", label: "Services" },
] as BreadcrumbAncestors;
export const resourcesBreadcrumb = [
  ...appBreadcrumb,
  { href: "/datastores", label: "Datastores" },
] as BreadcrumbAncestors;
export const serversBreadcrumb = [
  ...appBreadcrumb,
  { href: "/servers", label: "Servers" },
] as BreadcrumbAncestors;

export function DashboardPage({
  actions,
  badge,
  breadcrumbAncestors = appBreadcrumb,
  breadcrumbLabel,
  breadcrumbSwitcher,
  children,
  contentOwnsTitle = false,
  fullWidth = false,
  icon,
  title,
  titleContent,
  titleIcon,
}: {
  actions?: ReactNode;
  badge?: ReactNode;
  breadcrumbAncestors?: BreadcrumbAncestors;
  breadcrumbLabel?: string;
  breadcrumbSwitcher?: {
    id: string;
    kind: BreadcrumbEntityKind;
    sourceId?: string;
  };
  children: ReactNode;
  contentOwnsTitle?: boolean;
  fullWidth?: boolean;
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  title: string;
  titleContent?: ReactNode;
  titleIcon?: ReactNode;
}) {
  const [selection, setSelection] = useState<PageSelection | null>(null);
  const heading = selection ? selection.label : title;
  const switcher = breadcrumbSwitcher ? (
    <BreadcrumbEntitySwitcher
      currentId={breadcrumbSwitcher.id}
      kind={breadcrumbSwitcher.kind}
      label={title}
      sourceId={breadcrumbSwitcher.sourceId}
    />
  ) : undefined;
  const switcherKey = breadcrumbSwitcher
    ? `${breadcrumbSwitcher.kind}:${breadcrumbSwitcher.id}`
    : undefined;
  if (contentOwnsTitle) {
    const [firstAncestor, ...otherAncestors] = breadcrumbAncestors;
    const items: AppShellBreadcrumbItems = firstAncestor
      ? [firstAncestor, ...otherAncestors, { label: title }]
      : [{ label: title }];
    return (
      <>
        <AppShellBreadcrumb items={items} title={title} />
        <Page>
          <PageSection
            width={fullWidth ? "full" : "content"}
            className="pt-0 sm:pt-0"
            xPadding="none"
            yPadding={fullWidth ? "none" : "compact"}
          >
            {children}
          </PageSection>
        </Page>
      </>
    );
  }
  return (
    <PageSelectionContext.Provider value={setSelection}>
      <ApplicationPage
        className={fullWidth ? "[&>div:first-child]:px-4" : undefined}
        actions={selection?.actions ?? actions}
        badge={selection ? selection.badge : badge}
        breadcrumbAncestors={
          selection?.keepEntityName
            ? [
                ...breadcrumbAncestors,
                { content: switcher, contentKey: switcherKey, label: title },
              ]
            : breadcrumbAncestors
        }
        breadcrumbContent={selection?.keepEntityName ? undefined : switcher}
        breadcrumbContentKey={
          selection?.keepEntityName ? undefined : switcherKey
        }
        breadcrumbLabel={breadcrumbLabel}
        title={heading}
        titleContent={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 [&_img]:size-6 [&_svg]:size-6"
            >
              {selection?.icon ?? titleIcon ?? <HugeiconsIcon icon={icon} />}
            </span>
            {titleContent && !selection ? (
              <>{titleContent}</>
            ) : (
              <TooltipText className="truncate" tooltip={heading}>
                {heading}
              </TooltipText>
            )}
            <HeadingHelp title={heading} kind="page" />
          </span>
        }
      >
        {selection?.keepEntityName ? (
          <SecondaryEntityHeader
            title={title}
            icon={titleIcon ?? <HugeiconsIcon icon={icon} />}
          >
            {titleContent ?? title}
          </SecondaryEntityHeader>
        ) : null}
        <PageSection
          width={fullWidth ? "full" : "content"}
          className="content-grid pt-0 sm:pt-0"
          xPadding="none"
          yPadding="compact"
        >
          {Children.toArray(children)}
        </PageSection>
      </ApplicationPage>
    </PageSelectionContext.Provider>
  );
}

export function PageTabs({
  aliases,
  canonicalizeDefault = true,
  defaultValue,
  tabs,
  ungroupedTitle = "Manage",
}: {
  aliases?: Record<string, string>;
  canonicalizeDefault?: boolean;
  defaultValue: string;
  ungroupedTitle?: string;
  tabs: Array<{
    badge?: ReactNode;
    content: ReactNode;
    contentOwnsTitle?: boolean;
    destructive?: boolean;
    group?: string;
    icon?: ReactNode;
    indicator?:
      | boolean
      | {
          ariaLabel?: string;
          label?: string;
          dot?: boolean;
          variant?:
            | "default"
            | "secondary"
            | "success"
            | "warning"
            | "destructive"
            | "info";
        };
    label: string;
    sidebarLabel?: string;
    value: string;
  }>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const detail = useDetailNavigation();
  const section = detail.base ? detail.section : searchParams.get("section");
  const requestedSection = section ? (aliases?.[section] ?? section) : null;
  const selectedKey = tabs.some((tab) => tab.value === requestedSection)
    ? requestedSection!
    : defaultValue;

  useEffect(() => {
    if (
      canonicalizeDefault &&
      detail.base &&
      (!detail.pathname.slice(detail.base.length) ||
        searchParams.has("section") ||
        searchParams.has("settings"))
    ) {
      window.history.replaceState(
        null,
        "",
        detail.href(
          selectedKey,
          selectedKey === "settings"
            ? (detail.settings ?? undefined)
            : undefined,
          true,
        ),
      );
    }
  }, [canonicalizeDefault, detail, searchParams, selectedKey]);

  function selectSection(key: Key) {
    const value = String(key);
    if (value === selectedKey) return;
    if (detail.base) {
      pushPage(detail.href(value));
      window.scrollTo(0, 0);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    if (value === defaultValue) params.delete("section");
    else params.set("section", value);
    const query = params.toString();
    // Page tabs are client-only state. Native history keeps the permalink and
    // Next navigation hooks in sync without reprocessing the metadata head,
    // which would briefly clear the browser tab title on every selection.
    pushPage(query ? `${pathname}?${query}` : pathname);
  }

  const active = tabs.find((tab) => tab.value === selectedKey);
  const groupOrder = ["Ship", "Operate", "Monitor"];
  const groupedTabs = [
    ...new Set(tabs.filter((tab) => tab.group).map((tab) => tab.group!)),
  ].sort((left, right) => {
    const leftOrder = groupOrder.indexOf(left);
    const rightOrder = groupOrder.indexOf(right);
    return (
      (leftOrder === -1 ? groupOrder.length : leftOrder) -
      (rightOrder === -1 ? groupOrder.length : rightOrder)
    );
  });
  return (
    <>
      {selectedKey !== "settings" && active && !active.contentOwnsTitle ? (
        <PageSelectionTitle
          label={active.label}
          icon={active.icon}
          keepEntityName
        />
      ) : null}
      <SecondaryItems
        title={ungroupedTitle}
        selected={selectedKey}
        onSelect={selectSection}
        items={tabs
          .filter((tab) => !tab.group && tab.value !== "settings")
          .map((tab) => ({
            id: tab.value,
            label: tab.sidebarLabel ?? tab.label,
            icon: tab.icon,
            destructive: tab.destructive,
            badge:
              tab.badge ??
              (typeof tab.indicator === "object" ? (
                tab.indicator.dot ? (
                  <span
                    role="img"
                    aria-label={tab.indicator.ariaLabel ?? "Needs attention"}
                    className="inline-block size-2 rounded-full bg-warning-soft-foreground"
                  />
                ) : (
                  tab.indicator.label
                )
              ) : (
                tab.indicator
              )),
          }))}
      />
      {groupedTabs.map((group) => (
        <SecondaryItems
          key={group}
          title={group}
          selected={selectedKey}
          onSelect={selectSection}
          items={tabs
            .filter((tab) => tab.group === group)
            .map((tab) => ({
              id: tab.value,
              label: tab.sidebarLabel ?? tab.label,
              icon: tab.icon,
              destructive: tab.destructive,
              badge:
                tab.badge ??
                (typeof tab.indicator === "object" ? (
                  tab.indicator.dot ? (
                    <span
                      role="img"
                      aria-label={tab.indicator.ariaLabel ?? "Needs attention"}
                      className="inline-block size-2 rounded-full bg-warning-soft-foreground"
                    />
                  ) : (
                    tab.indicator.label
                  )
                ) : (
                  tab.indicator
                )),
            }))}
        />
      ))}
      <DetailSettingsContext.Provider value={selectedKey === "settings"}>
        {tabs.find((tab) => tab.value === "settings")?.content}
      </DetailSettingsContext.Provider>
      {selectedKey !== "settings" ? (
        <div className="min-w-0">{active?.content}</div>
      ) : null}
    </>
  );
}

export function ActionButton<T>({
  action,
  ariaLabel,
  children,
  confirm,
  isIconOnly = false,
  isDisabled = false,
  onSuccess,
  permission,
  pendingLabel = "Working…",
  preserveLabelWhilePending = false,
  redirectOnSuccess,
  success,
  variant = "secondary",
}: {
  action: () => Promise<T>;
  ariaLabel?: string;
  children: ReactNode;
  confirm?: {
    actionLabel?: string;
    description: string;
    title: ReactNode;
  };
  isIconOnly?: boolean;
  isDisabled?: boolean;
  onSuccess?: (result: T) => void;
  permission?: Action;
  pendingLabel?: string;
  preserveLabelWhilePending?: boolean;
  redirectOnSuccess?: (result: T) => string;
  success: string;
  variant?: "danger" | "primary" | "secondary";
}) {
  const { can } = useAccess();
  const stale = useRefreshFailures().length > 0;
  const [busy, setBusy] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  if (permission && !can(permission)) return null;
  async function runAction() {
    setBusy(true);
    try {
      const result = await action();
      if (redirectOnSuccess) {
        assignPage(redirectOnSuccess(result));
        return;
      }
      toast.success(success);
      onSuccess?.(result);
      refreshApiQueries();
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const showPendingState = busy && !preserveLabelWhilePending;
  const triggerContent =
    showPendingState && isIconOnly ? (
      <Spinner aria-label={pendingLabel} size="sm" />
    ) : showPendingState ? (
      <>
        <Spinner aria-label={pendingLabel} size="sm" />
        {pendingLabel}
      </>
    ) : (
      children
    );
  const trigger = (
    <Button
      aria-label={ariaLabel}
      isDisabled={busy || isDisabled || stale}
      isIconOnly={isIconOnly}
      variant={variant}
      onPress={confirm ? () => setIsConfirming(true) : runAction}
    >
      {triggerContent}
    </Button>
  );
  if (!confirm) {
    return trigger;
  }

  return (
    <>
      {trigger}
      <AlertDialog.Backdrop
        isOpen={isConfirming}
        onOpenChange={setIsConfirming}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{confirm.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>{confirm.description}</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                isDisabled={busy || isDisabled || stale}
                variant="secondary"
                onPress={() => setIsConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                isDisabled={busy || isDisabled || stale}
                variant={variant === "danger" ? "danger" : "primary"}
                onPress={() => {
                  setIsConfirming(false);
                  void runAction();
                }}
              >
                {showPendingState ? (
                  <>
                    <Spinner aria-label={pendingLabel} size="sm" />
                    {pendingLabel}
                  </>
                ) : confirm.actionLabel ? (
                  confirm.actionLabel
                ) : (
                  children
                )}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}

export function FormCard({
  children,
  className,
  headerEnd,
  help,
  icon,
  title,
  ...props
}: Omit<ComponentProps<typeof Widget>, "children" | "title"> & {
  children: ReactNode;
  headerEnd?: ReactNode;
  help?: HeadingDocumentation | false;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <Widget {...props} className={className}>
      <Widget.Header endContent={headerEnd}>
        <Widget.Title help={help} icon={icon}>
          {title}
        </Widget.Title>
      </Widget.Header>
      <Widget.Content>{children}</Widget.Content>
    </Widget>
  );
}

export function SimpleForm({
  fields,
  onSubmit,
  successMessage = "Saved",
  submitLabel,
  errorPresentation = "inline",
}: {
  fields: Array<{
    autoComplete?: string;
    className?: string;
    defaultValue?: string;
    description?: string;
    disabled?: boolean;
    label: string;
    maxLength?: number;
    minLength?: number;
    name: string;
    placeholder?: string;
    required?: boolean;
    rows?: number;
    spellCheck?: boolean;
    type?: string;
    variant?: InputProps["variant"];
  }>;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  successMessage?: string;
  submitLabel: string;
  errorPresentation?: "inline" | "toast";
}) {
  const formId = useId();
  const draft = useUnsavedForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const formData = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      fields
        .filter((field) => !field.disabled)
        .map(({ name }) => {
          const value = formData.get(name);
          return [name, typeof value === "string" ? value : ""];
        }),
    );
    try {
      await onSubmit(values);
      draft.markSaved();
      toast.success(successMessage);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not save";
      if (errorPresentation === "toast") toast.danger(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      {...draft.formProps}
      className="content-grid max-w-xl"
      onSubmit={submit}
    >
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Couldn&apos;t save</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {fields.map((field) => (
        <Field key={field.name}>
          <FieldLabel
            htmlFor={`${formId}-${field.name}`}
            isRequired={field.required}
          >
            {field.label}
          </FieldLabel>
          {field.type === "textarea" ? (
            <Textarea
              id={`${formId}-${field.name}`}
              autoComplete={field.autoComplete}
              className={cn("w-full", field.className)}
              defaultValue={field.defaultValue}
              disabled={field.disabled}
              maxLength={field.maxLength}
              minLength={field.minLength}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              rows={field.rows ?? 6}
              spellCheck={field.spellCheck}
              variant={field.variant}
            />
          ) : field.type === "password" ? (
            <PasswordInput
              id={`${formId}-${field.name}`}
              autoComplete={field.autoComplete}
              defaultValue={field.defaultValue}
              disabled={field.disabled}
              maxLength={field.maxLength}
              minLength={field.minLength}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              variant={field.variant}
            />
          ) : (
            <Input
              id={`${formId}-${field.name}`}
              autoComplete={field.autoComplete}
              className={field.className}
              defaultValue={field.defaultValue}
              disabled={field.disabled}
              maxLength={field.maxLength}
              minLength={field.minLength}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              type={field.type}
              variant={field.variant}
            />
          )}
          {field.description ? (
            <FieldDescription>{field.description}</FieldDescription>
          ) : null}
        </Field>
      ))}
      <Button className="w-fit" isDisabled={busy} type="submit">
        <HugeiconsIcon
          aria-hidden="true"
          icon={FloppyDiskIcon}
          className="size-4 shrink-0"
        />
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

export function InlineLink({
  children,
  className,
  href,
  target,
  ...props
}: Omit<ComponentProps<typeof Link>, "children" | "className" | "href"> & {
  children: ReactNode;
  className?: string;
  href: string;
}) {
  if (target === "_blank")
    return (
      <InlineExternalLink {...props} href={href} className={className}>
        {children}
      </InlineExternalLink>
    );
  return (
    <Link
      {...props}
      className={cn(
        "focus-visible:ring-focus rounded-md underline-offset-4 pointer-fine:hover:underline focus-visible:ring-2",
        className,
      )}
      href={href}
      target={target}
    >
      {children}
    </Link>
  );
}
