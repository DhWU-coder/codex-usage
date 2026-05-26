import assert from "node:assert/strict";
import test from "node:test";

import { summarize, timelineChannelSegments } from "../public/app.js";

test("summarize includes channel breakdowns for timeline buckets", () => {
  const summary = summarize({
    events: [
      {
        timestamp: "2026-05-26T01:00:00.000Z",
        sessionId: "desktop-1",
        channel: "Codex Desktop",
        total: { total: 200, input: 170, cached: 50, output: 30, reasoning: 5 },
      },
      {
        timestamp: "2026-05-26T02:00:00.000Z",
        sessionId: "cli-1",
        channel: "CLI",
        total: { total: 100, input: 80, cached: 20, output: 20, reasoning: 2 },
      },
    ],
  });

  assert.deepEqual(
    summary.timeline[0].channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
});

test("timelineChannelSegments follows global channel order", () => {
  const segments = timelineChannelSegments(
    {
      channels: [
        { name: "CLI", total: { total: 100 } },
        { name: "Codex Desktop", total: { total: 200 } },
      ],
    },
    [{ name: "Codex Desktop" }, { name: "CLI" }],
  );

  assert.deepEqual(
    segments.map((segment) => segment.name),
    ["Codex Desktop", "CLI"],
  );
});
