import assert from "node:assert/strict";
import test from "node:test";

import {
  datePickerMonthModel,
  drawTimeline,
  filterRankedRows,
  renderBarListHtml,
  renderCompactListHtml,
  renderComparisonHtml,
  renderDatePickerHtml,
  renderHomesHtml,
  renderTimelineDetailsHtml,
  timelineAxisLabels,
} from "../public/app.js";

test("render helpers escape usage row names before inserting HTML", () => {
  const rows = [
    {
      name: '<img src=x onerror="alert(1)">',
      total: { total: 42, input: 40, cached: 0, output: 2, reasoning: 0 },
    },
  ];

  const barHtml = renderBarListHtml(rows);
  const compactHtml = renderCompactListHtml(rows);

  assert.doesNotMatch(barHtml, /<img/i);
  assert.doesNotMatch(compactHtml, /<img/i);
  assert.match(barHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(compactHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("renderHomesHtml shows escaped statuses and removable imported directories", () => {
  const html = renderHomesHtml(
    [
      {
        label: "Project <unsafe>",
        kind: "project-log",
        path: "/tmp/project&one",
        imported: true,
        status: "active",
        eventCount: 3,
      },
    ],
    { canModify: true },
  );

  assert.doesNotMatch(html, /Project <unsafe>/);
  assert.match(html, /Project &lt;unsafe&gt;/);
  assert.match(html, /\/tmp\/project&amp;one/);
  assert.match(html, /data-import-action="remove"/);
  assert.match(html, /有用量记录/);
});

test("filterRankedRows limits by default, expands, and searches all rows", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    name: index === 29 ? "Needle Project" : `Project ${index + 1}`,
    total: { total: 100 - index },
  }));

  assert.equal(filterRankedRows(rows, { query: "", expanded: false, limit: 25 }).length, 25);
  assert.equal(filterRankedRows(rows, { query: "", expanded: true, limit: 25 }).length, 30);
  assert.deepEqual(
    filterRankedRows(rows, { query: "needle", expanded: false, limit: 25 }).map((row) => row.name),
    ["Needle Project"],
  );
});

test("rendered timeline details are keyboard focusable usage rows", () => {
  const html = renderTimelineDetailsHtml([
    {
      key: "2026-06-03",
      name: "2026-06-03",
      sessions: 2,
      count: 3,
      total: { total: 300, input: 250, cached: 50, output: 50, reasoning: 5 },
    },
  ]);

  assert.match(html, /class="timeline-detail-row"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /data-usage-tooltip="true"/);
  assert.match(html, /aria-label="2026-06-03：300 tokens"/);
});

test("renderComparisonHtml renders trend, average trend, and previous totals", () => {
  const html = renderComparisonHtml({
    label: "较上周",
    previousRange: {
      start: "2026-06-15T00:00:00.000Z",
      end: "2026-06-21T23:59:59.999Z",
    },
    previousTotals: { total: 700, input: 700, cached: 0, output: 0, reasoning: 0 },
    previousSessionCount: 2,
    totalDelta: -400,
    percentChange: -57.14,
    averageBaselineTotal: 50,
    averageDelta: 250,
    averagePercentChange: 500,
  });

  assert.match(html, /较上周/);
  assert.match(html, /平均趋势变化/);
  assert.match(html, /上一周期 tokens/);
  assert.match(html, /-400/);
  assert.match(html, /\+250/);
  assert.match(html, /700/);
  assert.match(html, /2 个会话/);
});

test("datePickerMonthModel starts weeks on Monday and keeps outside-month days selectable", () => {
  const model = datePickerMonthModel(new Date("2026-07-15T12:00:00"), "2026-06-30");

  assert.deepEqual(model.weekdays, ["一", "二", "三", "四", "五", "六", "日"]);
  assert.deepEqual(
    model.cells.slice(0, 7).map((cell) => [cell.date, cell.inCurrentMonth]),
    [
      ["2026-06-29", false],
      ["2026-06-30", false],
      ["2026-07-01", true],
      ["2026-07-02", true],
      ["2026-07-03", true],
      ["2026-07-04", true],
      ["2026-07-05", true],
    ],
  );
  assert.equal(model.cells[1].selected, true);
});

test("renderDatePickerHtml marks outside-month dates as dim but selectable buttons", () => {
  const html = renderDatePickerHtml({
    field: "start",
    viewDate: new Date("2026-07-15T12:00:00"),
    selectedValue: "2026-06-30",
  });

  assert.match(html, /<div class="date-picker-weekday">一<\/div>/);
  assert.match(html, /data-date="2026-06-29"[^>]*class="date-picker-day outside-month"/);
  assert.match(html, /data-date="2026-06-30"[^>]*class="date-picker-day outside-month selected"/);
  assert.match(html, /data-date="2026-07-01"[^>]*class="date-picker-day"/);
  assert.match(html, /type="button"[^>]*data-date="2026-06-29"/);
});

test("timelineAxisLabels shows all 24 labels for a single hourly day", () => {
  // Single-day hourly charts should label every hour from midnight through the last hour.
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    key: `2026-06-18 ${String(hour).padStart(2, "0")}:00`,
  }));

  assert.deepEqual(
    timelineAxisLabels(rows, {
      bucket: "hour",
      range: {
        start: "2026-06-18T00:00:00",
        end: "2026-06-18T23:59:59.999",
      },
      maxLabels: 8,
    }).map((label) => label.label),
    Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
  );
});

test("timelineAxisLabels samples hourly labels outside a single day", () => {
  // Multi-day hourly charts keep labels evenly distributed instead of drawing every hour.
  const rows = Array.from({ length: 48 }, (_, index) => {
    const day = index < 24 ? "18" : "19";
    const hour = String(index % 24).padStart(2, "0");
    return { key: `2026-06-${day} ${hour}:00` };
  });
  const labels = timelineAxisLabels(rows, {
    bucket: "hour",
    range: {
      start: "2026-06-18T00:00:00",
      end: "2026-06-19T23:59:59.999",
    },
    maxLabels: 8,
  });

  assert.equal(labels.length, 8);
  assert.deepEqual(
    labels.map((label) => label.index),
    [0, 7, 13, 20, 27, 34, 40, 47],
  );
  assert.deepEqual(
    [labels[0].label, labels.at(-1).label],
    ["06-18 00:00", "06-19 23:00"],
  );
});

test("drawTimeline does not draw visible bars for zero-token rows", () => {
  // Empty hourly buckets should keep hit areas and labels without painting 2px fake bars.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, [
      {
        key: "2026-06-18 00:00",
        total: { total: 0 },
        channels: [],
      },
    ]);

    assert.equal(calls.filter(([name]) => name === "fillRect").length, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("drawTimeline keeps dense hourly bars inside the chart width", () => {
  // Dense all-time hourly charts must shrink visual bars instead of pushing later bars off-canvas.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 1200,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  const rows = Array.from({ length: 700 }, (_, index) => ({
    key: `2026-06-${String(Math.floor(index / 24) + 1).padStart(2, "0")} ${String(index % 24).padStart(2, "0")}:00`,
    total: { total: index === 699 ? 100 : 1 },
    channels: [],
  }));
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, rows);

    const visibleBars = calls.filter(([name]) => name === "fillRect");
    const lastBar = visibleBars.at(-1);
    assert.ok(lastBar[1] + lastBar[3] <= 1200 - 18);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});
