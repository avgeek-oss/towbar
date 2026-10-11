import {
  verifyAnonymousTrend,
  verifyDimensionFilters,
} from "./dimension-filter-test-support.js";
import { verifyPageEngagement } from "./engagement-test-support.js";
import {
  verifyAnalyticsDeploymentMarkers,
  verifyAnalyticsProxyConfiguration,
} from "./deployment-test-support.js";
import { verifyAnalyticsCities } from "./city-test-support.js";
import { verifyFilterOptionsResponse } from "./filter-options-test-support.js";
import { verifyReportRanges } from "./short-ranges-test-support.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  analyticsCellSchema,
  monitoringSampleSchema,
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  analyticsSamples,
  apps,
  integrationInstallations,
  monitoringAgents,
  servers,
  sources,
  workspaces,
} from "@workspace/towbar-database/schema";
import { testInstanceLinks } from "../sources/instance-test-helper.js";
const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "analytics ingestion, reports, isolation, replay and retention",
  { skip: !databaseUrl },
  async () => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { ingestMonitoringSample } = await import("../monitoring/ingest.js");
    const service = await import("./service.js");
    const {
      getAnalyticsReport,
      getAnalyticsFilterOptions,
      maintainAnalytics,
      getAnalyticsConfiguration,
    } = service;
    const db = getTowbarDatabase(),
      workspaceId = randomUUID(),
      serverId = randomUUID(),
      generation = randomUUID(),
      appId = randomUUID(),
      sourceId = randomUUID();
    const config = normalizeDeploymentManifest({
      version: 2,
      apps: [
        {
          id: "web",
          name: "Web",
          server: "192.0.2.200",
          dockerfile: "Dockerfile",
          container: { port: 3000 },
          domains: { primary: "example.com" },
          analytics: {
            enabled: true,
            pageviews: true,
            visitorIdentity: true,
            retentionDays: 7,
            excludePaths: ["/private"],
          },
        },
      ],
    }).apps[0]!;
    try {
      await db
        .insert(workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: "Analytics test" });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: "192.0.2.200",
        config: normalizeServerConfiguration({
          ip: "192.0.2.200",
          ssh: { username: "deploy" },
        }),
        configDigest: "test",
      });
      await db.insert(monitoringAgents).values({
        serverId,
        generation,
        desiredState: "enabled",
        status: "online",
        tokenHash: "a".repeat(64),
      });
      const [installation] = await db
        .insert(integrationInstallations)
        .values({
          provider: "github",
          workspaceId,
          externalId: randomUUID(),
          principalName: "test",
          principalType: "Organization",
        })
        .returning();
      await db.insert(sources).values({
        id: sourceId,
        workspaceId,
        integrationInstallationId: installation!.id,
        repositoryOwner: "test",
        repositoryName: "analytics",
      });
      await db.insert(apps).values({
        ...(await testInstanceLinks(sourceId, "web")),
        id: appId,
        workspaceId,
        sourceId,
        serverId,
        manifestId: "web",
        name: "Web",
        config,
        configDigest: "test",
        sourceRevision: "abcdef0",
      });
      const cell = analyticsCellSchema.parse({
        appId,
        kind: "request",
        path: "/docs",
        referrer: "",
        method: "GET",
        status: 503,
        country: "",
        browser: "",
        device: "",
        visitor: "",
        session: "",
        count: 2,
        bytes: 100,
        durationMs: 20,
        histogram: [2, 0, 0, 0, 0, 0, 0, 0],
      });
      const body = monitoringSampleSchema.parse({
        id: randomBytes(16).toString("hex"),
        collectedAt: new Date(Date.now() - 1000).toISOString(),
        version: "1.1.0",
        collectionDurationMs: 5,
        collectionErrors: 0,
        droppedSamples: 0,
        entities: [{ id: "host", metrics: { cpuPercent: 10 } }],
        analytics: [
          cell,
          { ...cell, appId: randomUUID() },
          { ...cell, path: "/private/account" },
        ],
      });
      const result = await Promise.all([
        ingestMonitoringSample(serverId, generation, body),
        ingestMonitoringSample(serverId, generation, body),
      ]);
      assert.equal(result.filter((r) => r.replayed).length, 1);
      const rows = await db
        .select()
        .from(analyticsSamples)
        .where(eq(analyticsSamples.appId, appId));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.cells.length, 1);
      const report = await getAnalyticsReport({
        appId,
        workspaceId,
        days: 7,
        kind: "request",
      });
      await verifyAnalyticsDeploymentMarkers({
        appId,
        workspaceId,
        serverId,
        sourceId,
        config,
      });
      await verifyReportRanges({ appId, workspaceId, report, service });
      await db.insert(analyticsSamples).values({
        serverId,
        appId,
        sampleId: "e".repeat(32),
        collectedAt: new Date(Date.now() - 36 * 3600000),
        cells: [
          {
            ...cell,
            count: 4,
            status: 200,
            durationMs: 80,
            histogram: [0, 4, 0, 0, 0, 0, 0, 0],
          },
        ],
      });
      const compared = await getAnalyticsReport({
        appId,
        workspaceId,
        days: 1,
        kind: "request",
      });
      assert.equal(compared.total, 2);
      assert.equal(compared.comparison?.total, 4);
      assert.equal(compared.comparison.errors, 0);
      assert.equal(compared.comparison.meanMs, 20);
      assert.equal(compared.comparison.end, compared.start);
      assert.equal(
        Date.parse(compared.end) - Date.parse(compared.start),
        Date.parse(compared.comparison.end) -
          Date.parse(compared.comparison.start),
      );
      assert.equal(compared.trend.length, 24);
      assert.equal(compared.comparison.trend.length, 24);
      assert.equal(
        compared.trend.reduce((sum, point) => sum + point.count, 0),
        2,
      );
      assert.equal(
        compared.comparison.trend.reduce((sum, point) => sum + point.count, 0),
        4,
      );
      assert.equal(
        compared.dimensions.status?.[0]?.value,
        "503",
        "tables only include the current period",
      );
      await assert.rejects(
        getAnalyticsReport({
          appId,
          workspaceId: randomUUID(),
          days: 7,
          kind: "request",
        }),
      );
      const page = analyticsCellSchema.parse({
        ...cell,
        kind: "pageview",
        status: 0,
        bytes: 0,
        durationMs: 0,
        histogram: Array(8).fill(0),
        visitor: "b".repeat(64),
        session: "c".repeat(64),
        country: "IN",
        browser: "Safari",
        device: "Desktop",
      });
      await ingestMonitoringSample(serverId, generation, {
        ...body,
        id: randomBytes(16).toString("hex"),
        analytics: [page],
      });
      const visits = await getAnalyticsReport({
        appId,
        workspaceId,
        days: 7,
        kind: "pageview",
      });
      assert.equal(visits.total, 2);
      assert.equal(
        visits.averageTimeMs,
        null,
        "old pageviews do not invent viewing time",
      );
      assert.equal(visits.bounceRate, null, "ongoing visits are not bounces");
      assert.equal(visits.visitors, 1);
      assert.equal(visits.sessions, 1);
      async function verifyPathFilters() {
        // Both measures share the same predicates across every report section.
        for (const kind of ["request", "pageview"] as const) {
          const base = kind === "request" ? cell : page;
          for (const [hours, multiplier] of [
            [1, 1],
            [36, 2],
          ] as const) {
            await db.insert(analyticsSamples).values({
              serverId,
              appId,
              sampleId: randomBytes(16).toString("hex"),
              collectedAt: new Date(Date.now() - hours * 3600000),
              cells: [
                "/filter",
                "/filter/api",
                "/filtering",
                "/literal_%/x",
                "/literalAB/x",
                "/current-only",
              ]
                .filter((path) => hours === 1 || path !== "/current-only")
                .map((path, index) => ({
                  ...base,
                  path,
                  count: (index + 1) * multiplier,
                  bytes: kind === "request" ? (index + 1) * multiplier * 10 : 0,
                  durationMs:
                    kind === "request" ? (index + 1) * multiplier * 5 : 0,
                  histogram: [
                    kind === "request" ? (index + 1) * multiplier : 0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                  ],
                })),
            });
          }
          const cases = [
            {
              filters: [
                { field: "path", operator: "equals", value: "/filter" },
              ],
              total: 1,
              paths: ["/filter"],
            },
            {
              filters: [
                { field: "path", operator: "startsWith", value: "/filter" },
              ],
              total: 6,
              paths: ["/filter", "/filter/api", "/filtering"],
            },
            {
              filters: [
                { field: "path", operator: "startsWith", value: "/filter/" },
                { field: "path", operator: "equals", value: "/filter/api" },
              ],
              total: 2,
              paths: ["/filter/api"],
            },
            {
              filters: [
                { field: "path", operator: "startsWith", value: "/literal_%" },
              ],
              total: 4,
              paths: ["/literal_%/x"],
            },
            {
              filters: [
                { field: "path", operator: "equals", value: "/' OR true --" },
              ],
              total: 0,
              paths: [],
            },
            {
              filters: [
                { field: "path", operator: "equals", value: "/filter" },
                { field: "path", operator: "equals", value: "/filter/api" },
              ],
              total: 0,
              paths: [],
            },
          ] satisfies {
            filters: import("@workspace/towbar-core").AnalyticsFilter[];
            total: number;
            paths: string[];
          }[];
          for (const { filters, total, paths } of cases) {
            const filtered = await getAnalyticsReport({
              appId,
              workspaceId,
              days: 1,
              kind,
              filters,
            });
            assert.deepEqual(filtered.filters, filters);
            assert.equal(filtered.total, total);
            assert.equal(
              filtered.trend.reduce((sum, point) => sum + point.count, 0),
              total,
            );
            assert.deepEqual(
              filtered.dimensions.path?.map((row) => row.value).sort(),
              paths.sort(),
            );
            for (const rows of Object.values(filtered.dimensions))
              assert.equal(
                rows.reduce((sum, row) => sum + row.count, 0),
                total,
              );
            assert.equal(filtered.bytes, kind === "request" ? total * 10 : 0);
            assert.equal(filtered.errors, kind === "request" ? total : 0);
            assert.equal(
              filtered.histogram.reduce((sum, n) => sum + n, 0),
              kind === "request" ? total : 0,
            );
            assert.equal(
              filtered.visitors,
              kind === "pageview" ? Number(total > 0) : null,
            );
            assert.equal(
              filtered.sessions,
              kind === "pageview" ? Number(total > 0) : null,
            );
            if (total) {
              assert.equal(filtered.comparison?.total, total * 2);
              assert.equal(
                filtered.comparison?.trend.reduce(
                  (sum, point) => sum + point.count,
                  0,
                ),
                total * 2,
              );
              assert.equal(
                filtered.comparison?.errors,
                kind === "request" ? total * 2 : 0,
              );
              assert.equal(filtered.meanMs, kind === "request" ? 5 : null);
            } else assert.equal(filtered.comparison, null);
          }
          const noPriorMatch = await getAnalyticsReport({
            appId,
            workspaceId,
            days: 1,
            kind,
            filters: [
              { field: "path", operator: "equals", value: "/current-only" },
            ],
          });
          assert.equal(noPriorMatch.total, 6);
          assert.equal(noPriorMatch.comparison, null);
        }
      }
      await verifyPathFilters();
      await db.insert(analyticsSamples).values({
        serverId,
        appId,
        sampleId: randomBytes(16).toString("hex"),
        collectedAt: new Date(),
        cells: [
          {
            ...page,
            path: "/referrer-test",
            referrer: "example.com",
            country: "US",
            browser: "Chrome",
            count: 1,
          },
        ],
      });
      const optionInput = {
        appId,
        workspaceId,
        days: 1,
        kind: "pageview" as const,
      };
      await verifyFilterOptionsResponse({ appId, workspaceId });
      assert.deepEqual(
        await getAnalyticsFilterOptions({
          ...optionInput,
          field: "referrer",
          search: "EXAMPLE",
        }),
        ["example.com"],
      );
      assert.deepEqual(
        await getAnalyticsFilterOptions({
          ...optionInput,
          field: "country",
          search: "US",
        }),
        ["US"],
      );
      assert.deepEqual(
        await getAnalyticsFilterOptions({
          ...optionInput,
          field: "browser",
          search: "Chrome",
        }),
        ["Chrome"],
      );
      assert.deepEqual(
        await getAnalyticsFilterOptions({
          ...optionInput,
          field: "referrer",
          search: "unknown",
        }),
        ["Unknown"],
      );
      await assert.rejects(
        getAnalyticsFilterOptions({
          ...optionInput,
          workspaceId: randomUUID(),
          field: "referrer",
          search: "",
        }),
      );
      for (const filters of [
        [
          {
            field: "referrer" as const,
            operator: "in" as const,
            value: ["example.com"],
          },
        ],
        [
          {
            field: "country" as const,
            operator: "in" as const,
            value: ["US", "IN"],
          },
          {
            field: "browser" as const,
            operator: "in" as const,
            value: ["Chrome"],
          },
        ],
      ]) {
        const filtered = await getAnalyticsReport({ ...optionInput, filters });
        assert.equal(filtered.total, 1);
        assert.deepEqual(
          filtered.dimensions.path?.map((row) => row.value),
          ["/referrer-test"],
        );
      }
      await assert.rejects(
        getAnalyticsReport({
          ...optionInput,
          kind: "request",
          filters: [{ field: "browser", operator: "in", value: ["Chrome"] }],
        }),
      );
      await verifyPageEngagement({ appId, workspaceId, serverId });
      await verifyAnalyticsCities({ db, serverId, appId, workspaceId, page });
      await verifyDimensionFilters({ db, serverId, appId, workspaceId });
      await db
        .update(apps)
        .set({
          config: {
            ...config,
            analytics: { ...config.analytics!, visitorIdentity: false },
          },
        })
        .where(eq(apps.id, appId));
      const withoutIdentity = {
        ...body,
        id: randomBytes(16).toString("hex"),
        analytics: [page],
      };
      await ingestMonitoringSample(serverId, generation, withoutIdentity);
      const [anonymous] = await db
        .select()
        .from(analyticsSamples)
        .where(eq(analyticsSamples.sampleId, withoutIdentity.id));
      assert.equal(anonymous?.cells[0]?.visitor, "");
      await verifyAnonymousTrend({ appId, workspaceId });
      await db.insert(analyticsSamples).values({
        serverId,
        appId,
        sampleId: "f".repeat(32),
        collectedAt: new Date(Date.now() - 8 * 86400000),
        cells: [cell],
      });
      await maintainAnalytics();
      assert.equal(
        (
          await db
            .select()
            .from(analyticsSamples)
            .where(eq(analyticsSamples.sampleId, "f".repeat(32)))
        ).length,
        0,
      );
      await verifyAnalyticsProxyConfiguration({ appId, serverId, config });
      assert.notEqual(
        (await getAnalyticsConfiguration(serverId)).refresh,
        "initial",
      );
      await db
        .update(apps)
        .set({ config: { ...config, analytics: undefined } })
        .where(eq(apps.id, appId));
      const disabled = { ...body, id: randomBytes(16).toString("hex") };
      await ingestMonitoringSample(serverId, generation, disabled);
      assert.equal(
        (
          await db
            .select()
            .from(analyticsSamples)
            .where(eq(analyticsSamples.sampleId, disabled.id))
        ).length,
        0,
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await closeDatabase();
    }
  },
);
