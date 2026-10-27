import assert from "node:assert/strict";
import test from "node:test";

import {
  combinePreviewPullRequestCommentEntries,
  previewPullRequestCommentMarker,
  renderPreviewPullRequestComment,
} from "./pr-comment.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const marker = previewPullRequestCommentMarker({
  pullRequestNumber: 42,
  sourceId,
});

void test("uses one stable hidden marker for a Source and pull request", () => {
  assert.equal(
    marker,
    "<!-- towbar:preview-status:11111111-1111-4111-8111-111111111111:42 -->",
  );
});

void test("renders all app previews in one status table", () => {
  const body = renderPreviewPullRequestComment({
    appBaseUrl: "https://app.towbar.dev",
    entries: [
      {
        appName: "Admin | Console",
        deploymentId: "31111111-1111-4111-8111-111111111111",
        deploymentState: "building",
        environmentStatus: "building",
        hostname: "admin-pr-42.preview.example.com",
      },
      {
        appName: "Docs",
        deploymentId: null,
        deploymentState: null,
        environmentStatus: null,
        hostname: null,
        skippedReason: "no matching changes",
      },
      {
        appName: "Website",
        deploymentId: "41111111-1111-4111-8111-111111111111",
        deploymentState: "succeeded",
        environmentStatus: "healthy",
        hostname: "website-pr-42.preview.example.com",
      },
    ],
    marker,
    sourceId,
  });
  assert.match(body, /Admin \\| Console \| 🟡 Building/u);
  assert.match(body, /Website \| 🟢 Ready/u);
  assert.match(body, /Docs \| ⚪ Skipped — no matching changes/u);
  assert.match(
    body,
    /\[Open preview\]\(https:\/\/website-pr-42\.preview\.example\.com\)/u,
  );
  assert.equal(body.match(/## Towbar previews/gu)?.length, 1);
});

void test("shows cleanup and failure states without exposing error details", () => {
  const body = renderPreviewPullRequestComment({
    appBaseUrl: "https://app.towbar.dev",
    entries: [
      {
        appName: "API",
        deploymentId: null,
        deploymentState: null,
        environmentStatus: "deleted",
        hostname: "api-pr-42.preview.example.com",
      },
      {
        appName: "Worker",
        deploymentId: null,
        deploymentState: "failed",
        environmentStatus: "failed",
        hostname: "worker-pr-42.preview.example.com",
      },
    ],
    marker,
    sourceId,
  });
  assert.match(body, /API \| ⚪ Cleaned up/u);
  assert.match(body, /Worker \| 🔴 Failed/u);
});

void test("shows cleanup before replacing a deleted environment with skipped", () => {
  const skipped = [
    {
      appId: "app-1",
      appName: "Website",
      reason: "no matching changes",
    },
  ];
  const deleting = combinePreviewPullRequestCommentEntries(
    [
      {
        appId: "app-1",
        appName: "Website",
        deploymentId: null,
        deploymentState: null,
        environmentStatus: "deleting",
        hostname: "website-pr-42.preview.example.com",
      },
    ],
    skipped,
  );
  assert.equal(deleting.length, 1);
  assert.equal(deleting[0]?.environmentStatus, "deleting");

  const deleted = combinePreviewPullRequestCommentEntries(
    [
      {
        appId: "app-1",
        appName: "Website",
        deploymentId: null,
        deploymentState: null,
        environmentStatus: "deleted",
        hostname: "website-pr-42.preview.example.com",
      },
    ],
    skipped,
  );
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.skippedReason, "no matching changes");
});

void test("explains a blocked update on a retained Preview without losing its link", () => {
  const reason =
    "Required secrets missing in preview:production (build): NPM_TOKEN";
  const environment = {
    appId: "app-1",
    appName: "Website",
    deploymentId: "41111111-1111-4111-8111-111111111111",
    deploymentState: "succeeded" as const,
    environmentStatus: "healthy" as const,
    hostname: "website-pr-42.preview.example.com",
  };
  const entries = combinePreviewPullRequestCommentEntries(
    [environment],
    [{ appId: "app-1", appName: "Website", reason, blocked: true }],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.environmentStatus, "healthy");
  assert.equal(entries[0]?.skippedReason, reason);

  const body = renderPreviewPullRequestComment({
    appBaseUrl: "https://app.towbar.dev",
    entries,
    marker,
    sourceId,
  });
  assert.match(
    body,
    /Website \| 🟢 Ready · update skipped — Required secrets missing/u,
  );
  assert.match(
    body,
    /\[Open preview\]\(https:\/\/website-pr-42\.preview\.example\.com\)/u,
  );

  const unchanged = combinePreviewPullRequestCommentEntries(
    [environment],
    [{ appId: "app-1", appName: "Website", reason: "no matching changes" }],
  );
  assert.equal(unchanged[0]?.skippedReason, undefined);
});
