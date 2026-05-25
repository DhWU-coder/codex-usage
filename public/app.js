const state = {
  report: null,
  metadata: null,
  summary: null,
  fingerprint: "",
  preset: "all",
  bucket: "day",
  startDate: "",
  endDate: "",
  autoRefreshTimer: null,
  theme: "light",
};

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const THEME_STORAGE_KEY = "codexUsageTheme";
const formatter = new Intl.NumberFormat("en-US");
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const $ = (selector) => document.querySelector(selector);

function preferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButtons() {
  for (const button of document.querySelectorAll("[data-theme-option]")) {
    button.classList.toggle("active", button.dataset.themeOption === state.theme);
    button.setAttribute("aria-pressed", String(button.dataset.themeOption === state.theme));
  }
}

function setTheme(theme, { persist = true } = {}) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }
  updateThemeButtons();
  render();
}

function isStaticSnapshot() {
  return Boolean(window.__CODEX_USAGE_REPORT__);
}

function usageValue(usage, field = "total") {
  return usage?.[field] || 0;
}

function formatTokens(value) {
  return formatter.format(Math.round(value || 0));
}

function formatCompact(value) {
  return compactFormatter.format(Math.round(value || 0));
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function asDate(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function bucketKey(timestamp, bucket) {
  const date = new Date(timestamp);
  if (bucket === "month") {
    return dateKey(date).slice(0, 7);
  }
  if (bucket === "week") {
    return dateKey(startOfWeek(date));
  }
  return dateKey(date);
}

function getRange(events) {
  const now = new Date();
  if (state.preset === "today") {
    return { start: startOfDay(now), end: endOfDay(now) };
  }
  if (state.preset === "week") {
    return { start: startOfWeek(now), end: endOfDay(now) };
  }
  if (state.preset === "month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: endOfDay(now) };
  }
  if (state.preset === "custom") {
    return {
      start: state.startDate ? new Date(`${state.startDate}T00:00:00`) : null,
      end: state.endDate ? new Date(`${state.endDate}T23:59:59.999`) : null,
    };
  }
  const dates = events.map((event) => new Date(event.timestamp)).filter((date) => !Number.isNaN(date.getTime()));
  return {
    start: dates.length ? startOfDay(new Date(Math.min(...dates))) : null,
    end: dates.length ? endOfDay(new Date(Math.max(...dates))) : null,
  };
}

function addUsage(target, usage) {
  for (const field of ["total", "input", "cached", "output", "reasoning"]) {
    target[field] += usageValue(usage, field);
  }
  return target;
}

function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function groupEvents(events, keyFn) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const group = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
    };
    group.count += 1;
    group.sessions.add(event.sessionId);
    addUsage(group.total, event.total);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sessions: group.sessions.size,
  }));
}

function summarize(report) {
  const range = getRange(report.events);
  const events = report.events.filter((event) => {
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const timeline = groupEvents(events, (event) => bucketKey(event.timestamp, state.bucket)).sort((a, b) => a.key.localeCompare(b.key));
  const channels = groupEvents(events, (event) => event.channel).sort((a, b) => b.total.total - a.total.total);
  const projects = groupEvents(events, (event) => event.cwd || "Unknown cwd").sort((a, b) => b.total.total - a.total.total).slice(0, 25);
  const models = groupEvents(events, (event) => event.model || "Unknown model").sort((a, b) => b.total.total - a.total.total);
  return {
    range,
    totals,
    timeline,
    channels,
    projects,
    models,
    sessionCount: new Set(events.map((event) => event.sessionId)).size,
    eventCount: events.length,
  };
}

function setMetric(id, value) {
  $(id).textContent = formatTokens(value);
  $(id).title = formatTokens(value);
}

function renderMetrics(summary) {
  setMetric("#totalTokens", summary.totals.total);
  setMetric("#inputTokens", summary.totals.input);
  setMetric("#cachedTokens", summary.totals.cached);
  setMetric("#outputTokens", summary.totals.output);
  setMetric("#reasoningTokens", summary.totals.reasoning);
  setMetric("#sessionCount", summary.sessionCount);
}

function rangeLabel(summary) {
  const start = summary.range.start ? dateKey(asDate(summary.range.start)) : "开始";
  const end = summary.range.end ? dateKey(asDate(summary.range.end)) : "现在";
  const bucket = { day: "按天", week: "按周", month: "按月" }[state.bucket];
  return `${start} 至 ${end} · ${bucket}`;
}

function renderBarList(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty">没有匹配的用量记录</div>`;
    return;
  }
  const max = rows[0].total.total || 1;
  container.innerHTML = rows
    .map((row) => {
      const width = Math.max(2, (row.total.total / max) * 100);
      return `
        <div class="bar-row">
          <div class="bar-label">
            <span class="bar-name" title="${row.name}">${row.name}</span>
            <span class="bar-value">${formatTokens(row.total.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width: ${width}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderCompactList(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty">没有匹配的用量记录</div>`;
    return;
  }
  container.innerHTML = rows
    .map(
      (row) => `
        <div class="compact-row">
          <div class="compact-label">
            <span class="compact-name" title="${row.name}">${row.name}</span>
            <span class="compact-value">${formatTokens(row.total.total)}</span>
          </div>
        </div>
      `,
    )
    .join("");
}

function drawTimeline(canvas, rows) {
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const styles = getComputedStyle(document.documentElement);
  const chartLine = styles.getPropertyValue("--chart-line").trim() || "#d9e0e6";
  const chartText = styles.getPropertyValue("--chart-text").trim() || "#607080";
  const blue = styles.getPropertyValue("--blue").trim() || "#2364aa";
  const green = styles.getPropertyValue("--green").trim() || "#2f855a";
  const width = canvas.clientWidth * ratio;
  const height = canvas.clientHeight * ratio;
  canvas.width = width;
  canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.scale(ratio, ratio);

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const padding = { top: 18, right: 18, bottom: 42, left: 58 };
  const chartWidth = cssWidth - padding.left - padding.right;
  const chartHeight = cssHeight - padding.top - padding.bottom;

  context.strokeStyle = chartLine;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + chartHeight);
  context.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  context.stroke();

  if (!rows.length) {
    context.fillStyle = chartText;
    context.font = "13px system-ui";
    context.fillText("没有匹配的用量记录", padding.left + 12, padding.top + 28);
    return;
  }

  const max = Math.max(...rows.map((row) => row.total.total), 1);
  const gap = Math.min(10, chartWidth / Math.max(rows.length, 1) * 0.18);
  const barWidth = Math.max(4, (chartWidth - gap * (rows.length - 1)) / rows.length);

  rows.forEach((row, index) => {
    const value = row.total.total;
    const barHeight = Math.max(2, (value / max) * chartHeight);
    const x = padding.left + index * (barWidth + gap);
    const y = padding.top + chartHeight - barHeight;
    context.fillStyle = index % 2 === 0 ? blue : green;
    context.fillRect(x, y, barWidth, barHeight);
  });

  context.fillStyle = chartText;
  context.font = "12px system-ui";
  context.fillText(formatCompact(max), 8, padding.top + 8);
  context.fillText("0", 34, padding.top + chartHeight);

  const labelCount = Math.min(rows.length, 8);
  for (let i = 0; i < labelCount; i += 1) {
    const index = Math.round((i * (rows.length - 1)) / Math.max(1, labelCount - 1));
    const row = rows[index];
    const x = padding.left + index * (barWidth + gap);
    context.save();
    context.translate(x, padding.top + chartHeight + 18);
    context.rotate(-Math.PI / 8);
    context.fillText(row.key, 0, 0);
    context.restore();
  }
}

function renderHomes(homes) {
  const container = $("#homeList");
  if (!homes.length) {
    container.innerHTML = `<div class="empty">没有发现 Codex 目录</div>`;
    return;
  }
  container.innerHTML = homes
    .map(
      (home) => `
        <div class="home-row">
          <div class="home-label">
            <strong>${home.label}</strong>
            <span class="home-kind">${home.kind}</span>
          </div>
          <div class="home-path" title="${home.path}">${home.path}</div>
        </div>
      `,
    )
    .join("");
}

function metadataFromReport(report) {
  return {
    generatedAt: report.generatedAt,
    eventCount: report.events.length,
    sessionCount: report.sessions.length,
    homes: report.homes,
    warnings: report.warnings || [],
  };
}

function currentSummary() {
  if (state.report) {
    return summarize(state.report);
  }
  return state.summary;
}

function currentMetadata() {
  if (state.report) {
    return metadataFromReport(state.report);
  }
  return state.metadata;
}

function render() {
  const summary = currentSummary();
  const metadata = currentMetadata();
  if (!summary || !metadata) {
    return;
  }
  renderMetrics(summary);
  $("#rangeLabel").textContent = rangeLabel(summary);
  renderBarList($("#channelList"), summary.channels);
  renderCompactList($("#projectList"), summary.projects);
  renderCompactList($("#modelList"), summary.models);
  renderHomes(metadata.homes || []);
  drawTimeline($("#timelineChart"), summary.timeline);
}

function clockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setAutoRefreshStatus(message) {
  $("#autoRefreshStatus").textContent = message;
}

function autoRefreshReadyMessage(checkedAt = new Date()) {
  return `自动刷新 开 · 每 60 秒 · 上次检查 ${clockTime(new Date(checkedAt))}`;
}

function updatePresetButtons() {
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  }
}

function usageQuery({ force = false, skipCheck = false } = {}) {
  const params = new URLSearchParams({
    preset: state.preset,
    bucket: state.bucket,
  });
  if (state.preset === "custom") {
    if (state.startDate) {
      params.set("startDate", state.startDate);
    }
    if (state.endDate) {
      params.set("endDate", state.endDate);
    }
  }
  if (force) {
    params.set("force", "1");
  }
  if (skipCheck) {
    params.set("skipCheck", "1");
  }
  return `?${params.toString()}`;
}

async function loadUsage({ force = false, skipCheck = false } = {}) {
  $("#refreshButton").disabled = true;
  const embeddedReport = window.__CODEX_USAGE_REPORT__;
  $("#subtitle").textContent = embeddedReport ? "正在载入静态用量快照..." : "正在扫描本机 Codex 用量...";
  try {
    if (embeddedReport) {
      state.report = embeddedReport;
      state.metadata = metadataFromReport(embeddedReport);
      state.summary = null;
      state.fingerprint = "static";
      setAutoRefreshStatus("静态快照 · 自动刷新关闭 · 运行 npm run export 后会生成新快照");
    } else {
      const response = await fetch(`/api/usage${usageQuery({ force, skipCheck })}`);
      if (!response.ok) {
        throw new Error(`API ${response.status}`);
      }
      const data = await response.json();
      state.report = null;
      state.metadata = data.metadata;
      state.summary = data.summary;
      state.fingerprint = data.fingerprint || "";
      setAutoRefreshStatus(autoRefreshReadyMessage(data.checkedAt));
    }
    const metadata = currentMetadata();
    const generated = new Date(metadata.generatedAt).toLocaleString();
    $("#subtitle").textContent = `${formatTokens(metadata.eventCount)} 条 token 事件 · ${formatTokens(metadata.sessionCount)} 个会话 · ${generated}`;
    render();
  } catch (error) {
    $("#subtitle").textContent = `加载失败：${error.message}`;
  } finally {
    $("#refreshButton").disabled = false;
  }
}

async function checkForUpdates() {
  if (isStaticSnapshot() || document.hidden || !state.fingerprint) {
    return;
  }

  try {
    setAutoRefreshStatus("自动刷新 开 · 每 60 秒 · 正在检查...");
    const response = await fetch(`/api/status?since=${encodeURIComponent(state.fingerprint)}`);
    if (!response.ok) {
      throw new Error(`API ${response.status}`);
    }
    const status = await response.json();
    if (status.changed) {
      setAutoRefreshStatus("检测到更新，正在刷新...");
      await loadUsage({ force: true });
      return;
    }
    setAutoRefreshStatus(autoRefreshReadyMessage(status.checkedAt));
  } catch (error) {
    setAutoRefreshStatus(`自动刷新失败：${error.message} · 下次继续尝试`);
  }
}

function startAutoRefresh() {
  if (isStaticSnapshot() || state.autoRefreshTimer || document.hidden) {
    return;
  }
  state.autoRefreshTimer = window.setInterval(checkForUpdates, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function refreshViewForFilters() {
  if (isStaticSnapshot()) {
    render();
    return;
  }
  void loadUsage({ skipCheck: true });
}

$("#presetButtons").addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset]");
  if (!button) {
    return;
  }
  state.preset = button.dataset.preset;
  updatePresetButtons();
  refreshViewForFilters();
});

$("#bucketSelect").addEventListener("change", (event) => {
  state.bucket = event.target.value;
  refreshViewForFilters();
});

$("#startDate").addEventListener("change", (event) => {
  state.startDate = event.target.value;
  state.preset = "custom";
  updatePresetButtons();
  refreshViewForFilters();
});

$("#endDate").addEventListener("change", (event) => {
  state.endDate = event.target.value;
  state.preset = "custom";
  updatePresetButtons();
  refreshViewForFilters();
});

$("#refreshButton").addEventListener("click", () => loadUsage({ force: true }));
$("#themeToggle").addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-option]");
  if (!button) {
    return;
  }
  setTheme(button.dataset.themeOption);
});
window.addEventListener("resize", render);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAutoRefresh();
    return;
  }
  startAutoRefresh();
  checkForUpdates();
});

setTheme(preferredTheme(), { persist: false });
loadUsage().then(startAutoRefresh);
