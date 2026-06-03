import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageServer, isFullDetailHeapAvailable } from "../src/server.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function makeFixtureHome() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-server-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "server-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      {
        timestamp: "2026-05-01T02:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 123,
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 23,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ]),
  );
  return { homeDir: fakeHome, sessionFile };
}

test("server serves the dashboard and usage API", async () => {
  const { homeDir } = await makeFixtureHome();
  const server = createUsageServer({ homeDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const page = await fetch(`${baseUrl}/`);
    const api = await fetch(`${baseUrl}/api/usage`);
    const recent = await fetch(`${baseUrl}/api/usage?preset=recent&recentValue=${encodeURIComponent("14天")}`);
    const json = await api.json();
    const recentJson = await recent.json();

    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex Usage/);
    assert.equal(api.status, 200);
    assert.equal(json.summary.totals.total, 123);
    assert.equal(recent.status, 200);
    assert.equal(recentJson.summary.range.preset, "recent");
    assert.equal(recentJson.summary.totals.total, 0);
    assert.equal(json.metadata.eventCount, 1);
    assert.equal(json.metadata.sessionCount, 1);
    assert.equal(json.report, undefined);

    const detailed = await fetch(`${baseUrl}/api/usage?detail=full`).then((response) => response.json());
    assert.equal(detailed.report.events[0].channel, "CLI");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server keeps full detail reports behind the documented 512MB heap budget", () => {
  assert.equal(isFullDetailHeapAvailable(511 * 1024 * 1024), false);
  assert.equal(isFullDetailHeapAvailable(512 * 1024 * 1024), true);
});

test("server reports status changes and refreshes cached usage reports", async () => {
  const { homeDir, sessionFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const firstUsage = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const unchanged = await fetch(`${baseUrl}/api/status?since=${firstUsage.fingerprint}`).then((response) => response.json());

    assert.equal(firstUsage.summary.totals.total, 123);
    assert.match(firstUsage.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(unchanged.changed, false);

    await appendFile(
      sessionFile,
      JSON.stringify({
        timestamp: "2026-05-01T02:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 200,
              input_tokens: 160,
              cached_input_tokens: 30,
              output_tokens: 40,
              reasoning_output_tokens: 7,
            },
          },
        },
      }) + "\n",
    );

    const changed = await fetch(`${baseUrl}/api/status?since=${firstUsage.fingerprint}`).then((response) => response.json());
    const refreshed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const forced = await fetch(`${baseUrl}/api/usage?force=1`).then((response) => response.json());

    assert.equal(changed.changed, true);
    assert.notEqual(changed.fingerprint, firstUsage.fingerprint);
    assert.equal(refreshed.summary.totals.total, 200);
    assert.equal(forced.summary.totals.total, 200);
    assert.equal(forced.fingerprint, refreshed.fingerprint);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server imports project usage log directories and refreshes usage data", async () => {
  const { homeDir } = await makeFixtureHome();
  const projectRoot = path.join(homeDir, "openai_codex");
  const importStoreFile = path.join(homeDir, ".codex-usage", "imports.json");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T12:00:00.000Z",
        source: "codex-oauth",
        channel: "Codex OAuth",
        project_root: projectRoot,
        cwd: projectRoot,
        session_id: "oauth-session",
        model: "gpt-5.5",
        usage: { total: 77, input: 50, cached: 10, output: 27, reasoning: 6 },
      },
    ]),
  );

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const before = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectRoot }),
    }).then((response) => response.json());
    const imports = await fetch(`${baseUrl}/api/imports`).then((response) => response.json());
    const after = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(before.summary.totals.total, 123);
    assert.equal(imported.import.type, "project-log");
    assert.equal(imported.import.path, projectRoot);
    assert.deepEqual(imports.imports.map((entry) => entry.path), [projectRoot]);
    assert.equal(after.summary.totals.total, 200);
    assert.deepEqual(
      after.summary.channels.map((channel) => [channel.name, channel.total.total]),
      [
        ["CLI", 123],
        ["Codex OAuth", 77],
      ],
    );
    assert.equal(after.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
