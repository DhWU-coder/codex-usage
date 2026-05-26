import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildUsageIndex,
  buildUsageReport,
  buildUsageFingerprint,
  discoverCodexHomes,
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
