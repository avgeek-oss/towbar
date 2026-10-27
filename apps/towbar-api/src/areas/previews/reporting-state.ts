import { and, count, desc, eq, or, sql } from "drizzle-orm";

import { previewPullRequestReports } from "@workspace/towbar-database/schema";

import { getTowbarDatabase } from "../../infrastructure/database.js";
import {
  previewReportingRecoveryDelayMs,
  previewReportingRetryAt,
} from "./reporting-policy.js";

export type PreviewReportDelivery = "comment" | "deployment";
export type PreviewSkippedApp = {
  appId: string;
  appName: string;
  reason: string;
  /** Blocked updates keep the existing Preview, so the reason is shown on it. */
  blocked?: boolean;
};

export async function recordPreviewPullRequestPlan(input: {
  branch: string;
  hasDeployments: boolean;
  latestCommitSha: string;
  pullRequestNumber: number;
  skippedApps: PreviewSkippedApp[];
  sourceId: string;
  workspaceId: string;
}) {
  const now = new Date();
  const [report] = await getTowbarDatabase()
    .insert(previewPullRequestReports)
    .values({
      branch: input.branch,
      closedAt: null,
      commentDeliveryAttempts: 0,
      commentLastAttemptedAt: null,
      commentNextAttemptAt: null,
      commentDeliveryError: null,
      commentDeliveryStatus: "pending",
      deploymentDeliveryError: null,
      deploymentDeliveryStatus: input.hasDeployments ? "pending" : "published",
      deploymentPublishedAt: input.hasDeployments ? null : now,
      latestCommitSha: input.latestCommitSha,
      pullRequestNumber: input.pullRequestNumber,
      skippedApps: input.skippedApps,
      sourceId: input.sourceId,
      updatedAt: now,
      workspaceId: input.workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        previewPullRequestReports.sourceId,
        previewPullRequestReports.pullRequestNumber,
      ],
      set: {
        branch: input.branch,
        closedAt: null,
        commentLastAttemptedAt: null,
        commentDeliveryStatus: "pending",
        latestCommitSha: input.latestCommitSha,
        skippedApps: input.skippedApps,
        updatedAt: now,
      },
    })
    .returning({ id: previewPullRequestReports.id });
  return report;
}

export async function closePreviewPullRequestReport(input: {
  pullRequestNumber: number;
  sourceId: string;
}) {
  const now = new Date();
  await getTowbarDatabase()
    .update(previewPullRequestReports)
    .set({ closedAt: now, updatedAt: now })
    .where(reportIdentity(input));
}

export async function markPreviewReportDeliveryAttempt(
  input: { pullRequestNumber: number; sourceId: string },
  delivery: PreviewReportDelivery,
) {
  const now = new Date();
  const [attempt] = await getTowbarDatabase()
    .update(previewPullRequestReports)
    .set(
      delivery === "comment"
        ? {
            commentDeliveryError: null,
            commentDeliveryStatus: "pending",
            commentLastAttemptedAt: now,
            commentDeliveryAttempts: sql`${previewPullRequestReports.commentDeliveryAttempts} + 1`,
            commentNextAttemptAt: new Date(
              now.getTime() + previewReportingRecoveryDelayMs,
            ),
            updatedAt: now,
          }
        : {
            deploymentDeliveryError: null,
            deploymentDeliveryStatus: "pending",
            deploymentLastAttemptedAt: now,
            deploymentDeliveryAttempts: sql`${previewPullRequestReports.deploymentDeliveryAttempts} + 1`,
            deploymentNextAttemptAt: new Date(
              now.getTime() + previewReportingRecoveryDelayMs,
            ),
            updatedAt: now,
          },
    )
    .where(reportIdentity(input))
    .returning({
      attempts:
        delivery === "comment"
          ? previewPullRequestReports.commentDeliveryAttempts
          : previewPullRequestReports.deploymentDeliveryAttempts,
    });
  return { at: now, attempts: attempt?.attempts ?? 1 };
}

export async function markPreviewReportDeliverySucceeded(
  input: { pullRequestNumber: number; sourceId: string },
  delivery: PreviewReportDelivery,
  attemptedAt?: { at: Date; attempts: number },
) {
  const now = new Date();
  await getTowbarDatabase()
    .update(previewPullRequestReports)
    .set(
      delivery === "comment"
        ? {
            commentDeliveryAttempts: 0,
            commentNextAttemptAt: null,
            commentDeliveryError: null,
            commentDeliveryStatus: "published",
            commentPublishedAt: now,
            updatedAt: now,
          }
        : {
            deploymentDeliveryAttempts: 0,
            deploymentNextAttemptAt: null,
            deploymentDeliveryError: null,
            deploymentDeliveryStatus: "published",
            deploymentPublishedAt: now,
            updatedAt: now,
          },
    )
    .where(
      and(
        reportIdentity(input),
        attemptedAt
          ? eq(
              delivery === "comment"
                ? previewPullRequestReports.commentDeliveryAttempts
                : previewPullRequestReports.deploymentDeliveryAttempts,
              attemptedAt.attempts,
            )
          : undefined,
        attemptedAt
          ? eq(
              delivery === "comment"
                ? previewPullRequestReports.commentLastAttemptedAt
                : previewPullRequestReports.deploymentLastAttemptedAt,
              attemptedAt.at,
            )
          : undefined,
      ),
    );
}

export async function markPreviewReportDeliveryFailed(
  input: { pullRequestNumber: number; sourceId: string },
  delivery: PreviewReportDelivery,
  error: unknown,
  attemptedAt?: { at: Date; attempts: number },
) {
  const now = new Date();
  const message = previewReportingErrorMessage(error);
  const [report] = await getTowbarDatabase()
    .select({
      attempts:
        delivery === "comment"
          ? previewPullRequestReports.commentDeliveryAttempts
          : previewPullRequestReports.deploymentDeliveryAttempts,
    })
    .from(previewPullRequestReports)
    .where(reportIdentity(input))
    .limit(1);
  const nextAttemptAt = previewReportingRetryAt(
    error,
    report?.attempts ?? 1,
    now,
  );
  await getTowbarDatabase()
    .update(previewPullRequestReports)
    .set(
      delivery === "comment"
        ? {
            commentNextAttemptAt: nextAttemptAt,
            commentDeliveryError: message,
            commentDeliveryStatus: "failed",
            updatedAt: now,
          }
        : {
            deploymentNextAttemptAt: nextAttemptAt,
            deploymentDeliveryError: message,
            deploymentDeliveryStatus: "failed",
            updatedAt: now,
          },
    )
    .where(
      and(
        reportIdentity(input),
        attemptedAt
          ? eq(
              delivery === "comment"
                ? previewPullRequestReports.commentDeliveryAttempts
                : previewPullRequestReports.deploymentDeliveryAttempts,
              attemptedAt.attempts,
            )
          : undefined,
        attemptedAt
          ? eq(
              delivery === "comment"
                ? previewPullRequestReports.commentLastAttemptedAt
                : previewPullRequestReports.deploymentLastAttemptedAt,
              attemptedAt.at,
            )
          : undefined,
      ),
    );
  return message;
}

export async function getPreviewReportingHealth(workspaceId: string) {
  const database = getTowbarDatabase();
  const failureFilter = and(
    eq(previewPullRequestReports.workspaceId, workspaceId),
    or(
      eq(previewPullRequestReports.commentDeliveryStatus, "failed"),
      eq(previewPullRequestReports.deploymentDeliveryStatus, "failed"),
    ),
  );
  const [[summary], failures] = await Promise.all([
    database
      .select({ failedCount: count() })
      .from(previewPullRequestReports)
      .where(failureFilter),
    database
      .select({
        commentDeliveryError: previewPullRequestReports.commentDeliveryError,
        deploymentDeliveryError:
          previewPullRequestReports.deploymentDeliveryError,
        pullRequestNumber: previewPullRequestReports.pullRequestNumber,
        sourceId: previewPullRequestReports.sourceId,
        updatedAt: previewPullRequestReports.updatedAt,
      })
      .from(previewPullRequestReports)
      .where(failureFilter)
      .orderBy(desc(previewPullRequestReports.updatedAt))
      .limit(1),
  ]);
  const latest = failures[0];
  return {
    failedCount: summary?.failedCount ?? 0,
    lastError:
      latest?.commentDeliveryError ?? latest?.deploymentDeliveryError ?? null,
    lastFailedAt: latest?.updatedAt ?? null,
  };
}

export function previewReportingErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "GitHub request failed";
  return message
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/(token|secret|password)=([^&\s]+)/giu, "$1=[redacted]")
    .slice(0, 1_000);
}

export function reportIdentity(input: {
  pullRequestNumber: number;
  sourceId: string;
}) {
  return and(
    eq(previewPullRequestReports.sourceId, input.sourceId),
    eq(previewPullRequestReports.pullRequestNumber, input.pullRequestNumber),
  );
}
