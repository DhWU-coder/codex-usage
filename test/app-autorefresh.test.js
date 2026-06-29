import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function sourceBetween(source, startFunction, endFunction) {
  const startIndex = source.indexOf(`function ${startFunction}`);
  const endIndex = source.indexOf(`function ${endFunction}`, startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

test("auto refresh keeps checking while the page is hidden", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const checkSource = sourceBetween(source, "checkForUpdates", "startAutoRefresh");
  const startSource = sourceBetween(source, "startAutoRefresh", "refreshViewForFilters");
  const visibilitySource = source.slice(
    source.indexOf('document.addEventListener("visibilitychange"'),
    source.indexOf("setTheme(preferredTheme()", source.indexOf('document.addEventListener("visibilitychange"')),
  );

  assert.doesNotMatch(checkSource, /document\.hidden/);
  assert.doesNotMatch(startSource, /document\.hidden/);
  assert.doesNotMatch(visibilitySource, /stopAutoRefresh/);
  assert.match(visibilitySource, /checkForUpdates\(\)/);
});
