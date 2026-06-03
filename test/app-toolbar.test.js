import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("toolbar keeps all before recent and uses one fillable recent dropdown", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('data-preset="recent"'));
  assert.doesNotMatch(html, /id="recentPresetSelect"/);
  assert.match(html, /<input[^>]+id="recentValue"[^>]+list="recentRangeOptions"/);
  assert.match(html, /<datalist id="recentRangeOptions">/);

  for (const value of ["1天", "1周", "1个月", "3个月", "半年", "一年"]) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
});
