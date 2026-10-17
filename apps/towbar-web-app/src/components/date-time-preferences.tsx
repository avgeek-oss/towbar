"use client";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import {
  dateFormatOptions,
  timeFormatOptions,
} from "@avgeek-oss/design-system/utilities/date-time-preferences";
import { PreferencesSettings } from "@avgeek-oss/design-system";
import type {
  DateTimePreferences,
  DateTimePreferenceOptions,
} from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery, clearApiQueryCache } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

type PreferencesResponse = {
  preferences: DateTimePreferences;
  options: DateTimePreferenceOptions;
};
export function DateTimePreferencesSettings() {
  const draft = useUnsavedForm<HTMLDivElement>();
  const query = useApiQuery<PreferencesResponse>(
    "/v1/core/profile/preferences",
  );
  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  const data = query.data;
  return (
    <div
      {...draft.formProps}
      className="content-grid min-w-0 lg:grid-cols-2 lg:items-start"
    >
      <PreferencesSettings
        key={JSON.stringify(data.preferences)}
        value={data.preferences}
        options={{
          ...data.options,
          dateFormats: dateFormatOptions,
          timeFormats: timeFormatOptions,
        }}
        onSave={async (preferences) => {
          await api.put("/v1/core/profile/preferences", preferences);
          draft.markSaved();
          clearApiQueryCache();
          window.dispatchEvent(new Event("towbar:preferences-changed"));
          try {
            localStorage.setItem(
              "towbar:preferences-revision",
              crypto.randomUUID(),
            );
          } catch {
            /* Storage can be unavailable in private browsing. */
          }
        }}
      />
    </div>
  );
}
