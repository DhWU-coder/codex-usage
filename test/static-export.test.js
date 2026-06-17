import assert from "node:assert/strict";
import test from "node:test";

import { renderStaticDashboardHtml } from "../src/static-export.js";

test("renderStaticDashboardHtml embeds usage data and app assets", () => {
  const html = renderStaticDashboardHtml({
    generatedAt: "2026-05-25T00:00:00.000Z",
    homes: [{ label: "Main Codex", path: "/tmp/.codex", kind: "main" }],
    sessions: [],
    events: [
      {
        timestamp: "2026-05-25T00:00:00.000Z",
        sessionId: "s1",
        channel: "CLI",
        cwd: "/work",
        model: "gpt-5.5",
        total: { total: 10, input: 8, cached: 1, output: 2, reasoning: 0 },
      },
    ],
    warnings: [],
  });

  assert.match(html, /Codex Usage/);
  assert.match(html, /window.__CODEX_USAGE_REPORT__/);
  assert.match(html, /CLI/);
  assert.match(html, /timelineChart/);
  assert.match(html, /id="usageTooltip"/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /themeToggle/);
  assert.match(html, /data-theme-option="dark"/);
  assert.match(html, /id="importButton"/);
  assert.match(html, /id="addImportButton"/);
  assert.match(html, /id="importDialog"/);
  assert.match(html, /id="importPath"/);
  assert.match(html, /id="pickImportDirectoryButton"/);
  assert.match(html, /id="comparisonSummary"/);
  assert.match(html, /id="projectSearch"/);
  assert.match(html, /id="modelSearch"/);
  assert.match(html, /id="timelineDetails"/);
});
