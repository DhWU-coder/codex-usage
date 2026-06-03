import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("toolbar embeds the fillable recent dropdown inside the range segments", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('data-preset="recent"'));
  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('id="recentValue"'));
  assert.ok(html.indexOf('id="recentValue"') < html.indexOf('data-preset="custom"'));
  assert.match(html, /<span class="recent-segment-label">最近<\/span>/);
  assert.doesNotMatch(html, /<button[^>]+data-preset="recent"[^>]*>最近<\/button>/);
  assert.doesNotMatch(html, /class="control-group recent-range"/);
  assert.doesNotMatch(html, /id="recentPresetSelect"/);
  assert.doesNotMatch(html, /<datalist/);
  assert.doesNotMatch(html, /list="recentRangeOptions"/);
  assert.match(html, /<input[^>]+id="recentValue"/);
  assert.match(html, /id="recentRangeMenu"/);
  assert.match(html, /id="recentMenuButton"/);
  assert.match(css, /\.segmented\s+\.recent-segment\s+\.recent-segment-label\s*{[^}]*color:\s*inherit;/s);
  assert.match(css, /\.segmented\s+\.recent-segment\s*{[^}]*gap:\s*10px;/s);
  assert.match(css, /\.segmented\s+\.recent-segment\s*{[^}]*padding:\s*0 10px 0 14px;/s);
  assert.match(css, /\.recent-combobox\s*{[^}]*border:\s*1px solid var\(--line\);/s);
  assert.match(css, /\.recent-combobox\s*{[^}]*height:\s*26px;/s);
  assert.match(css, /\.recent-combobox\s*{[^}]*position:\s*relative;/s);
  assert.match(css, /\.recent-segment-input\s*{[^}]*border:\s*0;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button\s*{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button\s*{[^}]*border:\s*0;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button\s*{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button:hover\s*{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.recent-range-menu\s*{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.recent-range-menu\s+button\[aria-selected="true"\]\s*{/);

  for (const value of ["1天", "1周", "1个月", "2个月", "3个月", "半年", "一年"]) {
    assert.match(html, new RegExp(`data-recent-option="${value}"`));
  }
  assert.match(html, /data-recent-option="1个月"[^>]+aria-selected="true"/);
});
