import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageServer } from "../src/server.js";

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
    const json = await api.json();

    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex Usage/);
    assert.equal(api.status, 200);
    assert.equal(json.summary.totals.total, 123);
    assert.equal(json.metadata.eventCount, 1);
    assert.equal(json.metadata.sessionCount, 1);
    assert.equal(json.report, undefined);

    const detailed = await fetch(`${baseUrl}/api/usage?detail=full`).then((response) => response.json());
    assert.equal(detailed.report.events[0].channel, "CLI");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
