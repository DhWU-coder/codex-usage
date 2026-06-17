import assert from "node:assert/strict";
import test from "node:test";

import {
  filterRankedRows,
  renderBarListHtml,
  renderCompactListHtml,
  renderHomesHtml,
  renderTimelineDetailsHtml,
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
