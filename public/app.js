const state = {
  report: null,
  metadata: null,
  summary: null,
  fingerprint: "",
  preset: "all",
  bucket: "day",
  startDate: "",
  endDate: "",
  recentValue: "1个月",
  now: null,
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
const tooltipRows = new WeakMap();
const timelineBars = new WeakMap();

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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character];
  });
}

export function formatUsageTooltip(row) {
  const total = row?.total || emptyUsage();
  const details = [
    ["总 tokens", usageValue(total, "total")],
    ["输入", usageValue(total, "input")],
    ["缓存输入", usageValue(total, "cached")],
    ["输出", usageValue(total, "output")],
    ["推理输出", usageValue(total, "reasoning")],
    ["事件", row?.count || 0],
    ["会话", row?.sessions || 0],
  ];
  const channels = row?.channels || [];
  return `
    <div class="usage-tooltip-title">${escapeHtml(row?.name || row?.key || "未知")}</div>
    <div class="usage-tooltip-grid">
      ${details
        .map(
          ([label, value]) => `
            <span class="usage-tooltip-label">${label}</span>
            <span class="usage-tooltip-value">${formatTokens(value)}</span>
          `,
        )
        .join("")}
    </div>
    ${
      channels.length
        ? `
          <div class="usage-tooltip-subtitle">渠道</div>
          <div class="usage-tooltip-grid">
            ${channels
              .map(
                (channel) => `
                  <span class="usage-tooltip-label">${escapeHtml(channel.name)}</span>
                  <span class="usage-tooltip-value">${formatTokens(usageValue(channel.total, "total"))}</span>
                `,
              )
              .join("")}
          </div>
        `
        : ""
    }
  `;
}

function usageTooltip() {
  return $("#usageTooltip");
}

function hideUsageTooltip() {
  const tooltip = usageTooltip();
  if (tooltip) {
    tooltip.hidden = true;
  }
}

function positionUsageTooltip(event) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const offset = 14;
  const margin = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = event.clientX + offset;
  let top = event.clientY + offset;
  if (left + width + margin > window.innerWidth) {
    left = event.clientX - width - offset;
  }
  if (top + height + margin > window.innerHeight) {
    top = event.clientY - height - offset;
  }
  tooltip.style.left = `${Math.max(margin, left)}px`;
  tooltip.style.top = `${Math.max(margin, top)}px`;
}

function showUsageTooltip(row, event) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  tooltip.innerHTML = formatUsageTooltip(row);
  tooltip.hidden = false;
  positionUsageTooltip(event);
}

function bindUsageRows(container, selector, rows) {
  container.querySelectorAll(selector).forEach((element, index) => {
    tooltipRows.set(element, rows[index]);
  });
}

function getChannelColors(rows) {
  const styles = getComputedStyle(document.documentElement);
  const palette = [
    styles.getPropertyValue("--blue").trim() || "#2364aa",
    styles.getPropertyValue("--green").trim() || "#2f855a",
    styles.getPropertyValue("--gold").trim() || "#b7791f",
    styles.getPropertyValue("--red").trim() || "#c05621",
    styles.getPropertyValue("--muted").trim() || "#607080",
  ];
  return new Map(rows.map((row, index) => [row.name, palette[index % palette.length]]));
}

export function timelineChannelSegments(row, channelRows = []) {
  const rowChannels = new Map((row?.channels || []).map((channel) => [channel.name, channel]));
  const ordered = [];
  for (const channel of channelRows) {
    const match = rowChannels.get(channel.name);
    if (match) {
      ordered.push(match);
      rowChannels.delete(channel.name);
    }
  }
  ordered.push(...rowChannels.values());
  return ordered;
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

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function parseRecentValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now) {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  const start = parsed.days
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - parsed.days)
    : subtractMonthsClamped(now, parsed.months);
  return {
    start: startOfDay(start),
    end: endOfDay(now),
  };
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
  const now = state.now ? new Date(state.now) : new Date();
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
  if (state.preset === "recent") {
    const range = recentDateRange(state.recentValue, now);
    if (range) {
      return range;
    }
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

function groupEvents(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const group = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    group.count += 1;
    group.sessions.add(event.sessionId);
    addUsage(group.total, event.total);
    if (group.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = group.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      group.channelGroups.set(channelKey, channel);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    name: group.name,
    count: group.count,
    sessions: group.sessions.size,
    total: group.total,
    ...(group.channelGroups
      ? {
          channels: [...group.channelGroups.values()]
            .map((channel) => ({
              key: channel.key,
              name: channel.name,
              count: channel.count,
              sessions: channel.sessions.size,
              total: channel.total,
            }))
            .sort((a, b) => b.total.total - a.total.total),
        }
      : {}),
  }));
}

export function summarize(report) {
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
  const timeline = groupEvents(events, (event) => bucketKey(event.timestamp, state.bucket), { includeChannels: true }).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
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

export function setSummaryFilters(filters = {}) {
  for (const key of ["preset", "bucket", "startDate", "endDate", "recentValue"]) {
    if (Object.hasOwn(filters, key)) {
      state[key] = filters[key] || "";
    }
  }
  if (Object.hasOwn(filters, "now")) {
    state.now = filters.now || null;
  }
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

function renderBarList(container, rows, colorMap = null) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty">没有匹配的用量记录</div>`;
    return;
  }
  const max = rows[0].total.total || 1;
  container.innerHTML = rows
    .map((row) => {
      const width = Math.max(2, (row.total.total / max) * 100);
      const color = colorMap?.get(row.name);
      const fillStyle = `width: ${width}%;${color ? ` background: ${color};` : ""}`;
      return `
        <div class="bar-row" data-usage-tooltip="true">
          <div class="bar-label">
            <span class="bar-name" title="${row.name}">${row.name}</span>
            <span class="bar-value">${formatTokens(row.total.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="${fillStyle}"></div></div>
        </div>
      `;
    })
    .join("");
  bindUsageRows(container, ".bar-row", rows);
}

function renderCompactList(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty">没有匹配的用量记录</div>`;
    return;
  }
  container.innerHTML = rows
    .map(
      (row) => `
        <div class="compact-row" data-usage-tooltip="true">
          <div class="compact-label">
            <span class="compact-name" title="${row.name}">${row.name}</span>
            <span class="compact-value">${formatTokens(row.total.total)}</span>
          </div>
        </div>
      `,
    )
    .join("");
  bindUsageRows(container, ".compact-row", rows);
}

function drawTimeline(canvas, rows, channelRows = [], channelColors = new Map()) {
  const context = canvas.getContext("2d");
  canvas.dataset.usageTooltip = "true";
  timelineBars.set(canvas, []);
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
  const bars = [];

  rows.forEach((row, index) => {
    const value = row.total.total;
    const barHeight = Math.max(2, (value / max) * chartHeight);
    const x = padding.left + index * (barWidth + gap);
    const segments = timelineChannelSegments(row, channelRows);
    let y = padding.top + chartHeight;
    if (!segments.length || !value) {
      context.fillStyle = blue;
      context.fillRect(x, y - barHeight, barWidth, barHeight);
    }
    for (const segment of segments) {
      const segmentValue = usageValue(segment.total, "total");
      if (!segmentValue) {
        continue;
      }
      const segmentHeight = (segmentValue / value) * barHeight;
      y -= segmentHeight;
      context.fillStyle = channelColors.get(segment.name) || green;
      context.fillRect(x, y, barWidth, Math.max(0.5, segmentHeight));
    }
    bars.push({
      x: x - gap / 2,
      y: padding.top,
      width: barWidth + gap,
      height: chartHeight,
      row,
    });
  });
  timelineBars.set(canvas, bars);

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

function timelineRowAt(canvas, event) {
  const bars = timelineBars.get(canvas) || [];
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = bars.find((bar) => x >= bar.x && x <= bar.x + bar.width && y >= bar.y && y <= bar.y + bar.height);
  return hit?.row || null;
}

function setupUsageTooltip() {
  const timelineChart = $("#timelineChart");
  timelineChart.addEventListener("pointermove", (event) => {
    const row = timelineRowAt(timelineChart, event);
    if (row) {
      showUsageTooltip(row, event);
      return;
    }
    hideUsageTooltip();
  });
  timelineChart.addEventListener("pointerleave", hideUsageTooltip);

  document.addEventListener("pointermove", (event) => {
    if (event.target === timelineChart) {
      return;
    }
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      hideUsageTooltip();
      return;
    }
    showUsageTooltip(tooltipRows.get(target), event);
  });
  document.addEventListener("pointerleave", hideUsageTooltip);
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
  hideUsageTooltip();
  renderMetrics(summary);
  $("#rangeLabel").textContent = rangeLabel(summary);
  const channelColors = getChannelColors(summary.channels);
  renderBarList($("#channelList"), summary.channels, channelColors);
  renderCompactList($("#projectList"), summary.projects);
  renderCompactList($("#modelList"), summary.models);
  renderHomes(metadata.homes || []);
  drawTimeline($("#timelineChart"), summary.timeline, summary.channels, channelColors);
}

function clockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setAutoRefreshStatus(message) {
  $("#autoRefreshStatus").textContent = message;
}

function setImportControlsDisabled(disabled) {
  for (const selector of ["#importButton", "#addImportButton"]) {
    const button = $(selector);
    if (!button) {
      continue;
    }
    button.disabled = disabled;
    button.title = disabled ? "静态快照不能导入目录" : "";
  }
}

function setImportMessage(message, isError = false) {
  const element = $("#importMessage");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function openImportDialog() {
  if (isStaticSnapshot()) {
    setAutoRefreshStatus("静态快照不能导入目录，请启动本地服务后再导入");
    return;
  }
  const dialog = $("#importDialog");
  dialog.hidden = false;
  $("#importPath").value = "";
  setImportMessage("");
  window.requestAnimationFrame(() => $("#importPath").focus());
}

function closeImportDialog() {
  $("#importDialog").hidden = true;
  setImportMessage("");
}

async function submitImportDirectory(event) {
  event.preventDefault();
  const importPath = $("#importPath").value.trim();
  if (!importPath) {
    setImportMessage("请输入目录路径。", true);
    return;
  }

  const submitButton = $("#submitImportButton");
  submitButton.disabled = true;
  setImportMessage("正在识别目录...");
  try {
    const response = await fetch("/api/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: importPath }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `API ${response.status}`);
    }
    closeImportDialog();
    setAutoRefreshStatus(`已导入 ${data.import.label}，正在刷新...`);
    await loadUsage({ force: true });
  } catch (error) {
    setImportMessage(`导入失败：${error.message}`, true);
  } finally {
    submitButton.disabled = false;
  }
}

function autoRefreshReadyMessage(checkedAt = new Date()) {
  return `自动刷新 开 · 每 60 秒 · 上次检查 ${clockTime(new Date(checkedAt))}`;
}

function updatePresetButtons() {
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  }
}

function updateRecentControls() {
  const recentValue = $("#recentValue");
  if (recentValue && recentValue.value !== state.recentValue) {
    recentValue.value = state.recentValue;
  }
  const recentPresetSelect = $("#recentPresetSelect");
  if (!recentPresetSelect) {
    return;
  }
  const hasOption = [...recentPresetSelect.options].some((option) => option.value === state.recentValue);
  recentPresetSelect.value = hasOption ? state.recentValue : "";
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
  if (state.preset === "recent" && state.recentValue) {
    params.set("recentValue", state.recentValue);
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

function bootDashboard() {
  setupUsageTooltip();

  $("#presetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) {
      return;
    }
    state.preset = button.dataset.preset;
    updatePresetButtons();
    updateRecentControls();
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

  $("#recentValue").addEventListener("change", (event) => {
    state.recentValue = event.target.value.trim();
    state.preset = "recent";
    updatePresetButtons();
    updateRecentControls();
    refreshViewForFilters();
  });

  $("#recentPresetSelect").addEventListener("change", (event) => {
    state.recentValue = event.target.value;
    state.preset = "recent";
    updatePresetButtons();
    updateRecentControls();
    refreshViewForFilters();
  });

  $("#refreshButton").addEventListener("click", () => loadUsage({ force: true }));
  $("#importButton").addEventListener("click", openImportDialog);
  $("#addImportButton").addEventListener("click", openImportDialog);
  $("#importForm").addEventListener("submit", submitImportDirectory);
  $("#cancelImportButton").addEventListener("click", closeImportDialog);
  $("#closeImportDialogButton").addEventListener("click", closeImportDialog);
  $("#importDialog").addEventListener("click", (event) => {
    if (event.target.id === "importDialog") {
      closeImportDialog();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#importDialog").hidden) {
      closeImportDialog();
    }
  });
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
  updateRecentControls();
  setImportControlsDisabled(isStaticSnapshot());
  loadUsage().then(startAutoRefresh);
}

if (typeof document !== "undefined") {
  bootDashboard();
}
