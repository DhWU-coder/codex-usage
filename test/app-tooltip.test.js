import assert from "node:assert/strict";
import test from "node:test";

import { formatUsageTooltip } from "../public/app.js";

test("formatUsageTooltip renders token details for a usage row", () => {
  const html = formatUsageTooltip({
    name: "2026-05-26",
    count: 3,
    sessions: 2,
    total: {
      total: 1234567,
      input: 1000000,
      cached: 250000,
      output: 234567,
      reasoning: 34567,
    },
  });

  assert.match(html, /2026-05-26/);
  assert.match(html, /总 tokens/);
  assert.match(html, /1,234,567/);
  assert.match(html, /输入/);
  assert.match(html, /1,000,000/);
  assert.match(html, /缓存输入/);
  assert.match(html, /250,000/);
  assert.match(html, /输出/);
  assert.match(html, /234,567/);
  assert.match(html, /推理输出/);
  assert.match(html, /34,567/);
  assert.match(html, /事件/);
  assert.match(html, /3/);
  assert.match(html, /会话/);
  assert.match(html, /2/);
});

test("formatUsageTooltip renders timeline channel breakdowns", () => {
  const html = formatUsageTooltip({
    name: "2026-05-26",
    count: 3,
    sessions: 2,
    total: { total: 300, input: 250, cached: 50, output: 50, reasoning: 5 },
    channels: [
      { name: "JetBrains PyCharm", total: { total: 200 } },
      { name: "Codex Desktop", total: { total: 100 } },
    ],
  });

  assert.match(html, /渠道/);
  assert.match(html, /JetBrains PyCharm/);
  assert.match(html, /200/);
  assert.match(html, /Codex Desktop/);
  assert.match(html, /100/);
});
