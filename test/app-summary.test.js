import assert from "node:assert/strict";
import test from "node:test";

import {
  nextPresetState,
  nextRecentState,
  normalizeRecentValue,
  rangeLabel,
  setSummaryFilters,
  summarize,
  timelineChannelSegments,
} from "../public/app.js";

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

test("summarize fills a single local day with 24 hourly timeline rows", () => {
  // Single-day hourly views need empty rows so the chart spans midnight through 24:00.
  setSummaryFilters({
    preset: "all",
    bucket: "hour",
    now: null,
    startDate: "",
    endDate: "",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-05-26T01:15:00",
          sessionId: "first",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-05-26T01:45:00",
          sessionId: "second",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-05-26T02:05:00",
          sessionId: "third",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

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
    assert.equal(rangeLabel(summary), "2026-05-26 00:00 至 2026-05-27 00:00 · 按小时");
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

test("today preset defaults the next dashboard bucket to hour", () => {
  // Range presets reset to their default granularity so stale manual bucket choices do not leak.
  assert.deepEqual(nextPresetState({ bucket: "month" }, "today"), { preset: "today", bucket: "hour" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "week"), { preset: "week", bucket: "day" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "month"), { preset: "month", bucket: "day" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "all"), { preset: "all", bucket: "day" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "custom"), { preset: "custom", bucket: "day" });
});

test("recent one-day range defaults to hour and longer recent ranges default to day", () => {
  // Recent values use the normalized text so manual "1" behaves the same as selecting "1天".
  assert.deepEqual(nextRecentState({ bucket: "day" }, "1天"), {
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
  });
  assert.deepEqual(nextRecentState({ bucket: "day" }, "1"), {
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
  });
  assert.deepEqual(nextRecentState({ bucket: "hour" }, "1周"), {
    preset: "recent",
    recentValue: "1周",
    bucket: "day",
  });
  assert.deepEqual(nextRecentState({ bucket: "hour" }, "1个月"), {
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
  });
});

test("summarize filters recent natural-day month ranges", () => {
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
        {
          timestamp: "2026-06-03T23:59:59",
          sessionId: "same-day-late",
          channel: "CLI",
          total: { total: 400, input: 400, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-04T00:00:00",
          sessionId: "next-day",
          channel: "CLI",
          total: { total: 500, input: 500, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 900);
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

test("summarize fills recent two-day hourly ranges on natural-day boundaries", () => {
  setSummaryFilters({
    preset: "recent",
    recentValue: "2天",
    bucket: "hour",
    now: "2026-06-23T10:45:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-21T23:59:59",
          sessionId: "old",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-22T00:00:00",
          sessionId: "start",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-23T23:59:59",
          sessionId: "end",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-24T00:00:00",
          sessionId: "next-day",
          channel: "CLI",
          total: { total: 400, input: 400, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 500);
    assert.equal(summary.timeline[0].key, "2026-06-22 00:00");
    assert.equal(summary.timeline.at(-1).key, "2026-06-23 23:00");
    assert.equal(summary.timeline.length, 48);
    assert.equal(rangeLabel(summary), "2026-06-22 00:00 至 2026-06-24 00:00 · 按小时");
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

test("summarize uses rolling recent day ranges", () => {
  setSummaryFilters({
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
    now: "2026-06-23T10:45:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-22T10:44:59",
          sessionId: "old",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-22T10:45:00",
          sessionId: "start",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-23T10:45:00",
          sessionId: "end",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-23T10:45:01",
          sessionId: "future",
          channel: "CLI",
          total: { total: 400, input: 400, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 500);
    assert.equal(summary.timeline[0].key, "2026-06-22 10:00");
    assert.equal(summary.timeline.at(-1).key, "2026-06-23 10:00");
    assert.equal(summary.timeline.length, 25);
    assert.equal(rangeLabel(summary), "2026-06-22 10:45 至 2026-06-23 10:45 · 按小时");
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
    assert.equal(summary.comparison.averageBaselineTotal, 50);
    assert.equal(summary.comparison.averageDelta, 250);
    assert.equal(summary.comparison.averagePercentChange, 500);
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

test("summarize compares week preset with the full previous natural week", () => {
  setSummaryFilters({
    preset: "week",
    bucket: "day",
    now: "2026-06-22T12:00:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-15T09:00:00",
          sessionId: "previous-a",
          channel: "CLI",
          total: { total: 500, input: 500, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-21T09:00:00",
          sessionId: "previous-b",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-22T09:00:00",
          sessionId: "current",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 300);
    assert.equal(summary.comparison.previousTotals.total, 700);
    assert.equal(summary.comparison.totalDelta, -400);
    assert.equal(summary.comparison.percentChange, -57.14);
    assert.equal(summary.comparison.averageBaselineTotal, 50);
    assert.equal(summary.comparison.averageDelta, 250);
    assert.equal(summary.comparison.averagePercentChange, 500);
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
