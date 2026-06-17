import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRecentValue, setSummaryFilters, summarize, timelineChannelSegments } from "../public/app.js";

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

test("summarize filters recent natural month ranges", () => {
  setSummaryFilters({
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-05-02T12:00:00",
          sessionId: "old",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-05-03T00:00:00",
          sessionId: "boundary",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-03T12:00:00",
          sessionId: "current",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 500);
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("summarize includes previous-period comparison totals", () => {
  setSummaryFilters({
    preset: "today",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-02T09:00:00",
          sessionId: "previous",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-03T09:00:00",
          sessionId: "current",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.comparison.previousTotals.total, 100);
    assert.equal(summary.comparison.totalDelta, 200);
    assert.equal(summary.comparison.percentChange, 200);
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("normalizeRecentValue defaults bare numbers to days", () => {
  assert.equal(normalizeRecentValue("7"), "7天");
  assert.equal(normalizeRecentValue(" 14 "), "14天");
  assert.equal(normalizeRecentValue("1个月"), "1个月");
  assert.equal(normalizeRecentValue("半年"), "半年");
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
