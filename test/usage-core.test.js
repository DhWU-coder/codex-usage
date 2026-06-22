import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildUsageIndex,
  buildUsageReport,
  buildUsageFingerprint,
  classifyImportDirectory,
  discoverCodexHomes,
  discoverUsageSources,
  parseSessionFile,
  summarizeUsage,
  summarizeUsageIndex,
  usageIndexMetadata,
} from "../src/usage-core.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function tokenRow(timestamp, total, input = total - 10, cached = 0, output = 10) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 2,
        },
        last_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 2,
        },
      },
    },
  };
}

function usageEvent(timestamp, total) {
  return {
    timestamp,
    sessionId: `session-${total}`,
    channel: "CLI",
    homeId: "main-codex",
    homeLabel: "Main Codex",
    cwd: "/work/project",
    model: "gpt-5.5",
    total: { total, input: total, cached: 0, output: 0, reasoning: 0 },
  };
}

function indexedUsageEvent(timestamp, total) {
  return {
    t: new Date(timestamp).getTime(),
    s: total,
    h: 0,
    c: 1,
    l: 2,
    m: 3,
    p: 4,
    total,
    input: total,
    cached: 0,
    output: 0,
    reasoning: 0,
  };
}

function usageIndex(events) {
  return {
    generatedAt: "2026-06-03T00:00:00.000Z",
    homes: [],
    warnings: [],
    strings: ["main-codex", "CLI", "Main Codex", "gpt-5.5", "/work/project"],
    events: events.map((event) => indexedUsageEvent(event.timestamp, event.total.total)),
    sessionCount: events.length,
  };
}

test("parseSessionFile derives incremental token events from cumulative totals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  const file = path.join(root, "rollout.jsonl");
  await writeFile(
    file,
    jsonl([
      {
        timestamp: "2026-05-01T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-1",
          source: "vscode",
          originator: "JetBrains.PyCharm",
          cwd: "/work/project",
          cli_version: "1.0.0",
        },
      },
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      tokenRow("2026-05-01T01:01:00.000Z", 100, 80, 40, 20),
      tokenRow("2026-05-01T01:02:00.000Z", 160, 120, 70, 40),
    ]),
  );

  const parsed = await parseSessionFile(file, {
    homeId: "jetbrains-pycharm",
    homeLabel: "JetBrains PyCharm",
    homePath: root,
  });

  assert.equal(parsed.session.total.total, 160);
  assert.equal(parsed.events.length, 2);
  assert.deepEqual(
    parsed.events.map((event) => event.total.total),
    [100, 60],
  );
  assert.equal(parsed.session.channel, "JetBrains PyCharm");
});

test("discoverCodexHomes finds main Codex and JetBrains homes", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-home-"));
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });
  await mkdir(path.join(fakeHome, "Library", "Caches", "JetBrains", "PyCharm2026.1", "aia", "codex", "sessions"), {
    recursive: true,
  });

  const homes = await discoverCodexHomes({ homeDir: fakeHome });

  assert.deepEqual(
    homes.map((home) => home.label),
    ["Main Codex", "JetBrains PyCharm2026.1"],
  );
});

test("discoverCodexHomes finds Windows JetBrains homes from app data directories", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-win-home-"));
  const localAppData = path.join(fakeHome, "AppData", "Local");
  const roamingAppData = path.join(fakeHome, "AppData", "Roaming");
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });
  await mkdir(path.join(localAppData, "JetBrains", "PyCharm2026.1", "aia", "codex", "sessions"), {
    recursive: true,
  });
  await mkdir(path.join(roamingAppData, "JetBrains", "IntelliJIdea2026.1", "aia", "codex", "sessions"), {
    recursive: true,
  });

  const homes = await discoverCodexHomes({
    homeDir: fakeHome,
    platform: "win32",
    env: {
      LOCALAPPDATA: localAppData,
      APPDATA: roamingAppData,
    },
  });

  assert.deepEqual(
    homes.map((home) => home.label),
    ["Main Codex", "JetBrains PyCharm2026.1", "JetBrains IntelliJIdea2026.1"],
  );
});

test("discoverCodexHomes ignores missing extra homes", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-missing-"));
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });

  const homes = await discoverCodexHomes({
    homeDir: fakeHome,
    extraHomes: path.join(fakeHome, "does-not-exist"),
  });

  assert.deepEqual(
    homes.map((home) => home.label),
    ["Main Codex"],
  );
});

test("classifyImportDirectory detects project usage logs and Codex homes", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-import-kind-"));
  const projectRoot = path.join(fakeHome, "oauth-project");
  const codexHome = path.join(fakeHome, "extra-codex");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(path.join(projectRoot, ".codex-usage", "usage.jsonl"), "");
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });

  const project = await classifyImportDirectory(projectRoot);
  const home = await classifyImportDirectory(codexHome);

  assert.equal(project.type, "project-log");
  assert.equal(project.path, projectRoot);
  assert.equal(project.usageLogPath, path.join(projectRoot, ".codex-usage", "usage.jsonl"));
  assert.equal(home.type, "codex-home");
  assert.equal(home.path, codexHome);
});

test("summarizeUsage filters recent natural month ranges", () => {
  const events = [
    usageEvent("2026-05-02T12:00:00", 100),
    usageEvent("2026-05-03T00:00:00", 200),
    usageEvent("2026-06-03T12:00:00", 300),
  ];
  const report = { generatedAt: "2026-06-03T00:00:00.000Z", events };
  const filters = {
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };

  const summary = summarizeUsage(report, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.totals.total, 500);
  assert.equal(indexedSummary.totals.total, 500);
});

test("summarizeUsage includes previous-period comparison totals", () => {
  const events = [
    usageEvent("2026-06-02T09:00:00", 100),
    usageEvent("2026-06-03T09:00:00", 300),
  ];
  const filters = {
    preset: "today",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };

  const summary = summarizeUsage({ generatedAt: "", events }, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.comparison.previousTotals.total, 100);
  assert.equal(summary.comparison.totalDelta, 200);
  assert.equal(summary.comparison.percentChange, 200);
  assert.equal(summary.comparison.averageBaselineTotal, 50);
  assert.equal(summary.comparison.averageDelta, 250);
  assert.equal(summary.comparison.averagePercentChange, 500);
  assert.equal(indexedSummary.comparison.previousTotals.total, 100);
  assert.equal(indexedSummary.comparison.totalDelta, 200);
  assert.equal(indexedSummary.comparison.percentChange, 200);
  assert.equal(indexedSummary.comparison.averageBaselineTotal, 50);
  assert.equal(indexedSummary.comparison.averageDelta, 250);
  assert.equal(indexedSummary.comparison.averagePercentChange, 500);
});

test("summarizeUsage compares week preset with the full previous natural week", () => {
  const events = [
    usageEvent("2026-06-15T09:00:00", 500),
    usageEvent("2026-06-21T09:00:00", 200),
    usageEvent("2026-06-22T09:00:00", 300),
  ];
  const filters = {
    preset: "week",
    bucket: "day",
    now: "2026-06-22T12:00:00",
  };

  const summary = summarizeUsage({ generatedAt: "", events }, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.totals.total, 300);
  assert.equal(summary.comparison.previousTotals.total, 700);
  assert.equal(summary.comparison.totalDelta, -400);
  assert.equal(summary.comparison.percentChange, -57.14);
  assert.equal(summary.comparison.averageBaselineTotal, 50);
  assert.equal(summary.comparison.averageDelta, 250);
  assert.equal(summary.comparison.averagePercentChange, 500);
  assert.equal(indexedSummary.comparison.previousTotals.total, 700);
  assert.equal(indexedSummary.comparison.averageBaselineTotal, 50);
  assert.equal(indexedSummary.comparison.averageDelta, 250);
});

test("summarizeUsage filters recent half-year and manual day ranges", () => {
  const halfYearEvents = [
    usageEvent("2025-12-02T12:00:00", 100),
    usageEvent("2025-12-03T00:00:00", 200),
    usageEvent("2026-06-03T12:00:00", 300),
  ];
  const manualDayEvents = [
    usageEvent("2026-05-19T12:00:00", 10),
    usageEvent("2026-05-20T00:00:00", 20),
    usageEvent("2026-06-03T12:00:00", 30),
  ];

  const halfYearFilters = {
    preset: "recent",
    recentValue: "半年",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };
  const manualDayFilters = {
    preset: "recent",
    recentValue: "14天",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };

  assert.equal(summarizeUsage({ generatedAt: "", events: halfYearEvents }, halfYearFilters).totals.total, 500);
  assert.equal(summarizeUsageIndex(usageIndex(halfYearEvents), halfYearFilters).totals.total, 500);
  assert.equal(summarizeUsage({ generatedAt: "", events: manualDayEvents }, manualDayFilters).totals.total, 50);
  assert.equal(summarizeUsageIndex(usageIndex(manualDayEvents), manualDayFilters).totals.total, 50);
});

test("buildUsageReport and summarizeUsage include imported project usage logs", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-project-log-"));
  const projectRoot = path.join(fakeHome, "openai_codex");
  const usageDir = path.join(projectRoot, ".codex-usage");
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });
  await mkdir(usageDir, { recursive: true });
  await writeFile(
    path.join(usageDir, "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T10:00:00.000Z",
        source: "codex-oauth",
        channel: "Codex OAuth",
        project_root: projectRoot,
        cwd: projectRoot,
        session_id: "oauth-session-1",
        request_id: "request-1",
        model: "gpt-5.5",
        usage: { total: 120, input: 90, cached: 30, output: 30, reasoning: 8 },
      },
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T11:00:00.000Z",
        source: "codex-oauth",
        project_root: projectRoot,
        session_id: "oauth-session-1",
        model: "gpt-5.5",
        usage: { total: 80, input: 60, cached: 20, output: 20, reasoning: 4 },
      },
    ]),
  );

  const sources = await discoverUsageSources({ homeDir: fakeHome, importDirs: [projectRoot] });
  const report = await buildUsageReport({ homeDir: fakeHome, importDirs: [projectRoot] });
  const index = await buildUsageIndex({ homeDir: fakeHome, importDirs: [projectRoot] });
  const summary = summarizeUsage(report, { preset: "all", bucket: "day" });
  const indexedSummary = summarizeUsageIndex(index, { preset: "all", bucket: "day" });
  const fingerprint = await buildUsageFingerprint({ homeDir: fakeHome, importDirs: [projectRoot] });

  assert.deepEqual(
    sources.map((source) => [source.kind, source.label, source.path]),
    [
      ["main", "Main Codex", path.join(fakeHome, ".codex")],
      ["project-log", "Project openai_codex", projectRoot],
    ],
  );
  assert.equal(report.events.length, 2);
  assert.equal(report.sessions.length, 1);
  assert.equal(summary.totals.total, 200);
  assert.equal(indexedSummary.totals.total, summary.totals.total);
  assert.deepEqual(summary.channels.map((channel) => [channel.name, channel.total.total]), [["Codex OAuth", 200]]);
  assert.deepEqual(summary.projects.map((project) => [project.name, project.total.total]), [[projectRoot, 200]]);
  assert.equal(fingerprint.fileCount, 1);
});

test("buildUsageFingerprint changes when session files change", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-fingerprint-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "fingerprint-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      tokenRow("2026-05-01T02:01:00.000Z", 100, 80, 20, 20),
    ]),
  );

  const first = await buildUsageFingerprint({ homeDir: fakeHome });
  await appendFile(sessionFile, JSON.stringify(tokenRow("2026-05-01T02:02:00.000Z", 140, 110, 30, 30)) + "\n");
  const second = await buildUsageFingerprint({ homeDir: fakeHome });

  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.fileCount, 1);
});

test("buildUsageReport and summarizeUsage aggregate totals by channel and period", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-report-"));
  const mainSessions = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const jetbrainsSessions = path.join(fakeHome, "Library", "Caches", "JetBrains", "PyCharm2026.1", "aia", "codex", "sessions", "2026", "05", "08");
  await mkdir(mainSessions, { recursive: true });
  await mkdir(jetbrainsSessions, { recursive: true });

  await writeFile(
    path.join(mainSessions, "desktop.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "desktop-1", source: "vscode", originator: "Codex Desktop", cwd: "/work/a" },
      },
      tokenRow("2026-05-01T02:01:00.000Z", 200, 170, 50, 30),
    ]),
  );
  await writeFile(
    path.join(mainSessions, "cli.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-01T03:00:00.000Z",
        type: "session_meta",
        payload: { id: "cli-1", source: "cli", originator: "codex-tui", cwd: "/work/c" },
      },
      tokenRow("2026-05-01T03:01:00.000Z", 100, 80, 20, 20),
    ]),
  );
  await writeFile(
    path.join(jetbrainsSessions, "jetbrains.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-08T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "jetbrains-1", source: "vscode", originator: "JetBrains.PyCharm", cwd: "/work/b" },
      },
      tokenRow("2026-05-08T02:01:00.000Z", 300, 260, 100, 40),
    ]),
  );

  const report = await buildUsageReport({ homeDir: fakeHome });
  const index = await buildUsageIndex({ homeDir: fakeHome });
  const all = summarizeUsage(report, { preset: "all", bucket: "week" });
  const indexedAll = summarizeUsageIndex(index, { preset: "all", bucket: "week" });
  const custom = summarizeUsage(report, {
    preset: "custom",
    startDate: "2026-05-07",
    endDate: "2026-05-08",
    bucket: "day",
  });
  const indexedCustom = summarizeUsageIndex(index, {
    preset: "custom",
    startDate: "2026-05-07",
    endDate: "2026-05-08",
    bucket: "day",
  });

  assert.equal(all.totals.total, 600);
  assert.equal(usageIndexMetadata(index).eventCount, 3);
  assert.equal(indexedAll.totals.total, all.totals.total);
  assert.deepEqual(
    indexedAll.channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["JetBrains PyCharm", 300],
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.deepEqual(
    all.channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["JetBrains PyCharm", 300],
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.deepEqual(
    all.timeline.find((row) => row.key === "2026-04-27").channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.deepEqual(
    indexedAll.timeline.find((row) => row.key === "2026-04-27").channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.equal(custom.totals.total, 300);
  assert.equal(indexedCustom.totals.total, custom.totals.total);
  assert.equal(custom.timeline[0].key, "2026-05-08");
  assert.equal(indexedCustom.timeline[0].key, "2026-05-08");
});

test("summarizeUsage and summarizeUsageIndex fill a single local day with 24 hourly rows", () => {
  // Report and index summaries must both expose empty local-hour buckets for single-day charts.
  const events = [
    usageEvent("2026-05-26T01:15:00", 100),
    usageEvent("2026-05-26T01:45:00", 200),
    usageEvent("2026-05-26T02:05:00", 300),
  ];
  const report = { generatedAt: "2026-05-26T00:00:00", events };
  const index = usageIndex(events);
  const summary = summarizeUsage(report, { preset: "all", bucket: "hour" });
  const indexedSummary = summarizeUsageIndex(index, { preset: "all", bucket: "hour" });

  assert.deepEqual(
    [summary.timeline[0], summary.timeline[1], summary.timeline[2], summary.timeline[23]].map((row) => [
      row.key,
      row.total.total,
    ]),
    [
      ["2026-05-26 00:00", 0],
      ["2026-05-26 01:00", 300],
      ["2026-05-26 02:00", 300],
      ["2026-05-26 23:00", 0],
    ],
  );
  assert.equal(summary.timeline.length, 24);
  assert.deepEqual(indexedSummary.timeline, summary.timeline);
});
