import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("toolbar embeds the fillable recent dropdown inside the range segments", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('data-preset="recent"'));
  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('id="recentValue"'));
  assert.ok(html.indexOf('id="recentValue"') < html.indexOf('data-preset="custom"'));
  assert.doesNotMatch(html, /<button[^>]+data-preset="recent"[^>]*>最近<\/button>/);
  assert.doesNotMatch(html, /recent-range/);
  assert.doesNotMatch(html, /id="recentPresetSelect"/);
  assert.match(html, /<input[^>]+id="recentValue"[^>]+list="recentRangeOptions"/);
  assert.match(html, /<datalist id="recentRangeOptions">/);

  for (const value of ["1天", "1周", "1个月", "3个月", "半年", "一年"]) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
});
