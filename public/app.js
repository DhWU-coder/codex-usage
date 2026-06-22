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
  projectQuery: "",
  modelQuery: "",
  projectsExpanded: false,
  modelsExpanded: false,
  datePickerField: "",
  datePickerViews: {
    start: null,
    end: null,
  },
};

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const THEME_STORAGE_KEY = "codexUsageTheme";
const RANKED_LIST_LIMIT = 25;
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

// Normalize optional row labels before rendering or building accessible names.
function usageRowName(row) {
  return row?.name || row?.key || "未知";
}

// Keep keyboard/screen-reader labels aligned with the visual token value.
function usageRowAriaLabel(row) {
  return `${usageRowName(row)}：${formatTokens(usageValue(row?.total, "total"))} tokens`;
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

function positionUsageTooltip(anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const offset = 14;
  const margin = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const rect = anchor?.getBoundingClientRect?.();
  const anchorX = Number.isFinite(anchor?.clientX) ? anchor.clientX : rect?.left || margin;
  const anchorY = Number.isFinite(anchor?.clientY) ? anchor.clientY : rect?.bottom || margin;
  let left = anchorX + offset;
  let top = anchorY + offset;
  if (left + width + margin > window.innerWidth) {
    left = anchorX - width - offset;
  }
  if (top + height + margin > window.innerHeight) {
    top = anchorY - height - offset;
  }
  tooltip.style.left = `${Math.max(margin, left)}px`;
  tooltip.style.top = `${Math.max(margin, top)}px`;
}

function showUsageTooltip(row, anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  tooltip.innerHTML = formatUsageTooltip(row);
  tooltip.hidden = false;
  positionUsageTooltip(anchor);
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

const datePickerWeekdays = ["一", "二", "三", "四", "五", "六", "日"];

function parseLocalDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function normalizeDateInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const date = parseLocalDate(trimmed);
  return date ? dateKey(date) : null;
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function datePickerMonthModel(viewDate = new Date(), selectedValue = "") {
  const selectedDate = parseLocalDate(selectedValue);
  const visibleMonth = monthStart(viewDate instanceof Date ? viewDate : new Date(viewDate));
  const mondayOffset = (visibleMonth.getDay() + 6) % 7;
  const firstCell = addDays(visibleMonth, -mondayOffset);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(firstCell, index);
    const value = dateKey(date);
    return {
      date: value,
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === visibleMonth.getMonth(),
      selected: selectedDate ? value === dateKey(selectedDate) : false,
    };
  });
  return {
    year: visibleMonth.getFullYear(),
    month: visibleMonth.getMonth() + 1,
    weekdays: datePickerWeekdays,
    cells,
  };
}

export function renderDatePickerHtml({ field = "start", viewDate = new Date(), selectedValue = "" } = {}) {
  const model = datePickerMonthModel(viewDate, selectedValue);
  const escapedField = escapeHtml(field);
  return `
    <div class="date-picker-heading">
      <button class="date-picker-nav" type="button" data-date-picker-action="prev" data-date-picker-field="${escapedField}" aria-label="上个月">‹</button>
      <div class="date-picker-title">${model.year}年${String(model.month).padStart(2, "0")}月</div>
      <button class="date-picker-nav" type="button" data-date-picker-action="next" data-date-picker-field="${escapedField}" aria-label="下个月">›</button>
    </div>
    <div class="date-picker-grid">
      ${model.weekdays.map((weekday) => `<div class="date-picker-weekday">${weekday}</div>`).join("")}
      ${model.cells
        .map((cell) => {
          const classes = ["date-picker-day"];
          if (!cell.inCurrentMonth) {
            classes.push("outside-month");
          }
          if (cell.selected) {
            classes.push("selected");
          }
          return `<button type="button" data-date="${cell.date}" data-date-picker-field="${escapedField}" class="${classes.join(" ")}">${cell.day}</button>`;
        })
        .join("")}
    </div>
  `;
}

function hourKey(date) {
  // Hour buckets use local wall-clock time to match the existing day/week/month grouping.
  const hour = String(date.getHours()).padStart(2, "0");
  return `${dateKey(date)} ${hour}:00`;
}

function hourBoundaryKey(date) {
  // Range labels use hour boundaries, so a day ending at 23:59:59.999 displays as next-day 00:00.
  return hourKey(date);
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

function isSingleLocalDayRange(range = {}) {
  // The hourly chart only fills 24 buckets when the selected range resolves to one local calendar day.
  const start = asDate(range.start);
  const end = asDate(range.end);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return false;
  }
  return dateKey(start) === dateKey(end);
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

export function normalizeRecentValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (/^[1-9]\d*$/.test(normalized)) {
    return `${normalized}天`;
  }
  return normalized;
}

function parseRecentValue(value) {
  const normalized = normalizeRecentValue(value);
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

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function bucketKey(timestamp, bucket) {
  const date = new Date(timestamp);
  if (bucket === "hour") {
    return hourKey(date);
  }
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

function emptyTimelineRow(key) {
  // Empty rows let single-day hourly charts show zero-use hours without special render code.
  return {
    key,
    name: key,
    count: 0,
    sessions: 0,
    total: emptyUsage(),
    channels: [],
  };
}

function completeHourlyTimeline(rows, range, bucket) {
  // Single-day hourly charts should span the whole day, not only hours that have usage.
  if (bucket !== "hour" || !isSingleLocalDayRange(range)) {
    return rows;
  }
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const start = startOfDay(asDate(range.start));
  return Array.from({ length: 24 }, (_, hour) => {
    const bucketStart = new Date(start);
    bucketStart.setHours(hour, 0, 0, 0);
    const key = hourKey(bucketStart);
    return rowsByKey.get(key) || emptyTimelineRow(key);
  });
}

function previousPeriodRange(range) {
  if (!range.start || !range.end || state.preset === "all") {
    return null;
  }
  if (state.preset === "today") {
    const previousDay = addDays(startOfDay(asDate(range.start)), -1);
    return {
      start: previousDay,
      end: endOfDay(previousDay),
    };
  }
  if (state.preset === "week") {
    const previousWeekStart = addDays(startOfWeek(asDate(range.start)), -7);
    return {
      start: previousWeekStart,
      end: endOfDay(addDays(previousWeekStart, 6)),
    };
  }
  if (state.preset === "month") {
    const currentMonthStart = new Date(asDate(range.start).getFullYear(), asDate(range.start).getMonth(), 1);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: endOfDay(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0)),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  if (!start || !end) {
    return 0;
  }
  return Math.max(0, end.getTime() - start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  if (!start || !end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(end.getTime(), Math.max(start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function comparisonLabel() {
  return {
    today: "较昨日",
    week: "较上周",
    month: "较上月",
    custom: "较上一等长周期",
    recent: "较上一等长周期",
  }[state.preset] || "暂无对比";
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function summarizeComparison(allEvents, range, currentTotals) {
  // 静态导出没有 API 可用，因此在浏览器端复用同一套趋势口径。
  const previousRange = previousPeriodRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const previousEvents = allEvents.filter((event) => {
    const time = Date.parse(event.timestamp);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const now = state.now ? new Date(state.now) : new Date();
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);
  return {
    label: comparisonLabel(),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: new Set(previousEvents.map((event) => event.sessionId)).size,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
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
  const timeline = completeHourlyTimeline(
    groupEvents(events, (event) => bucketKey(event.timestamp, state.bucket), { includeChannels: true }).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    range,
    state.bucket,
  );
  const channels = groupEvents(events, (event) => event.channel).sort((a, b) => b.total.total - a.total.total);
  const projects = groupEvents(events, (event) => event.cwd || "Unknown cwd").sort((a, b) => b.total.total - a.total.total);
  const models = groupEvents(events, (event) => event.model || "Unknown model").sort((a, b) => b.total.total - a.total.total);
  return {
    range,
    totals,
    comparison: summarizeComparison(report.events, range, totals),
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

export function defaultBucketForRange(preset = "all", recentValue = "") {
  // One-day views are hourly by default; broader ranges reset to daily charts.
  return preset === "today" || (preset === "recent" && normalizeRecentValue(recentValue) === "1天") ? "hour" : "day";
}

export function nextPresetState(currentState = {}, preset = "all") {
  // Preset switches intentionally reset granularity to the default for that range.
  return {
    preset,
    bucket: defaultBucketForRange(preset, currentState.recentValue),
  };
}

export function nextRecentState(currentState = {}, value = "") {
  const recentValue = normalizeRecentValue(value);
  // Recent range edits reset granularity based on whether the selected span is one day.
  return {
    preset: "recent",
    recentValue,
    bucket: defaultBucketForRange("recent", recentValue),
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

export function rangeLabel(summary) {
  const start = summary.range.start ? dateKey(asDate(summary.range.start)) : "开始";
  const end = summary.range.end ? dateKey(asDate(summary.range.end)) : "现在";
  const bucket = { hour: "按小时", day: "按天", week: "按周", month: "按月" }[state.bucket];
  if (state.bucket === "hour" && summary.range.start && summary.range.end) {
    const startDate = asDate(summary.range.start);
    const endDate = asDate(summary.range.end);
    const exclusiveEnd = new Date(endDate.getTime() + 1);
    return `${hourBoundaryKey(startDate)} 至 ${hourBoundaryKey(exclusiveEnd)} · ${bucket}`;
  }
  return `${start} 至 ${end} · ${bucket}`;
}

export function renderBarListHtml(rows, colorMap = null) {
  // Build escaped HTML in one place so all bar-list render paths stay safe.
  if (!rows.length) {
    return `<div class="empty">没有匹配的用量记录</div>`;
  }
  const max = rows[0].total.total || 1;
  return rows
    .map((row) => {
      const width = Math.max(2, (row.total.total / max) * 100);
      const color = colorMap?.get(row.name);
      const fillStyle = `width: ${width}%;${color ? ` background: ${color};` : ""}`;
      const name = escapeHtml(usageRowName(row));
      const ariaLabel = escapeHtml(usageRowAriaLabel(row));
      return `
        <div class="bar-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <div class="bar-label">
            <span class="bar-name" title="${name}">${name}</span>
            <span class="bar-value">${formatTokens(row.total.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="${fillStyle}"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderBarList(container, rows, colorMap = null) {
  container.innerHTML = renderBarListHtml(rows, colorMap);
  bindUsageRows(container, ".bar-row", rows);
}

export function renderCompactListHtml(rows) {
  // Compact rows are focusable so keyboard users can reach the same tooltip details.
  if (!rows.length) {
    return `<div class="empty">没有匹配的用量记录</div>`;
  }
  return rows
    .map(
      (row) => {
        const name = escapeHtml(usageRowName(row));
        const ariaLabel = escapeHtml(usageRowAriaLabel(row));
        return `
        <div class="compact-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <div class="compact-label">
            <span class="compact-name" title="${name}">${name}</span>
            <span class="compact-value">${formatTokens(row.total.total)}</span>
          </div>
        </div>
      `;
      },
    )
    .join("");
}

function renderCompactList(container, rows) {
  container.innerHTML = renderCompactListHtml(rows);
  bindUsageRows(container, ".compact-row", rows);
}

export function renderTimelineDetailsHtml(rows) {
  // The timeline detail list mirrors the canvas for mobile and keyboard access.
  if (!rows.length) {
    return `<div class="empty">没有匹配的用量记录</div>`;
  }
  return rows
    .map((row) => {
      const name = escapeHtml(usageRowName(row));
      const ariaLabel = escapeHtml(usageRowAriaLabel(row));
      return `
        <div class="timeline-detail-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <span class="timeline-detail-name">${name}</span>
          <span class="timeline-detail-value">${formatTokens(row.total.total)}</span>
        </div>
      `;
    })
    .join("");
}

function renderTimelineDetails(container, rows) {
  container.innerHTML = renderTimelineDetailsHtml(rows);
  bindUsageRows(container, ".timeline-detail-row", rows);
}

function hourlyAxisLabel(key, singleDay) {
  // Hourly labels stay compact so a 24-hour day can show every tick without long date text.
  const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!match) {
    return String(key || "");
  }
  return singleDay ? match[4] : `${match[2]}-${match[3]} ${match[4]}`;
}

export function timelineAxisLabels(rows, options = {}) {
  // Build label positions separately from drawing so hour sampling stays testable.
  if (!rows.length) {
    return [];
  }
  const singleHourlyDay = options.bucket === "hour" && isSingleLocalDayRange(options.range);
  if (singleHourlyDay) {
    return rows.map((row, index) => ({
      index,
      label: hourlyAxisLabel(row.key, true),
    }));
  }

  const fallbackMaxLabels = Math.max(2, Math.floor((options.chartWidth || 960) / 120));
  const maxLabels = Math.max(1, options.maxLabels || fallbackMaxLabels);
  const labelCount = Math.min(rows.length, maxLabels);
  return Array.from({ length: labelCount }, (_, position) => {
    const index = Math.round((position * (rows.length - 1)) / Math.max(1, labelCount - 1));
    const row = rows[index];
    return {
      index,
      label: options.bucket === "hour" ? hourlyAxisLabel(row.key, false) : row.key,
    };
  });
}

export function filterRankedRows(rows, { query = "", expanded = false, limit = RANKED_LIST_LIMIT } = {}) {
  // Search intentionally scans the full sorted list even when the default view is capped.
  const normalized = String(query || "").trim().toLowerCase();
  const filtered = normalized
    ? rows.filter((row) => usageRowName(row).toLowerCase().includes(normalized))
    : rows;
  return normalized || expanded ? filtered : filtered.slice(0, limit);
}

function formatDelta(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokens(value)}`;
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "无基准";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}%`;
}

function comparisonClass(value) {
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

export function renderComparisonHtml(comparison) {
  if (!comparison) {
    return "";
  }
  if (!comparison.previousRange) {
    return `
      <article class="comparison-item flat">
        <span>趋势变化</span>
        <strong>暂无对比</strong>
        <small>选择今日、本周、本月或最近范围查看</small>
      </article>
    `;
  }
  return `
    <article class="comparison-item ${comparisonClass(comparison.totalDelta)}">
      <span>${escapeHtml(comparison.label)}</span>
      <strong>${formatDelta(comparison.totalDelta)}</strong>
      <small>${formatPercent(comparison.percentChange)}</small>
    </article>
    <article class="comparison-item ${comparisonClass(comparison.averageDelta)}">
      <span>平均趋势变化</span>
      <strong>${formatDelta(comparison.averageDelta)}</strong>
      <small>${formatPercent(comparison.averagePercentChange)}</small>
    </article>
    <article class="comparison-item">
      <span>上一周期 tokens</span>
      <strong>${formatTokens(comparison.previousTotals.total)}</strong>
      <small>${formatTokens(comparison.previousSessionCount)} 个会话</small>
    </article>
  `;
}

function renderComparison(summary) {
  const container = $("#comparisonSummary");
  if (!container) {
    return;
  }
  container.innerHTML = renderComparisonHtml(summary.comparison);
}

function updateRankedListControls(kind, rows) {
  const query = kind === "project" ? state.projectQuery : state.modelQuery;
  const expanded = kind === "project" ? state.projectsExpanded : state.modelsExpanded;
  const button = $(`#${kind}Toggle`);
  if (!button) {
    return;
  }
  const hasQuery = Boolean(String(query || "").trim());
  button.hidden = hasQuery || rows.length <= RANKED_LIST_LIMIT;
  button.textContent = expanded ? "收起" : "展开";
  button.setAttribute("aria-expanded", String(expanded));
}

export function drawTimeline(canvas, rows, channelRows = [], channelColors = new Map(), range = null) {
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
  const slotWidth = chartWidth / Math.max(rows.length, 1);
  const gap = Math.min(10, slotWidth * 0.18);
  const barWidth = Math.max(0.5, slotWidth - gap);
  const bars = [];

  rows.forEach((row, index) => {
    const value = row.total.total;
    const barHeight = value ? Math.max(2, (value / max) * chartHeight) : 0;
    const slotX = padding.left + index * slotWidth;
    const x = slotX + Math.max(0, (slotWidth - barWidth) / 2);
    const segments = timelineChannelSegments(row, channelRows);
    let y = padding.top + chartHeight;
    if (value && !segments.length) {
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
      x: slotX,
      y: padding.top,
      width: slotWidth,
      height: chartHeight,
      row,
    });
  });
  timelineBars.set(canvas, bars);

  context.fillStyle = chartText;
  context.font = "12px system-ui";
  context.fillText(formatCompact(max), 8, padding.top + 8);
  context.fillText("0", 34, padding.top + chartHeight);

  const labels = timelineAxisLabels(rows, { bucket: state.bucket, range, chartWidth });
  for (const label of labels) {
    const index = label.index;
    const x = padding.left + index * slotWidth;
    context.save();
    context.translate(x, padding.top + chartHeight + 18);
    context.rotate(-Math.PI / 8);
    context.fillText(label.label, 0, 0);
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
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      return;
    }
    showUsageTooltip(tooltipRows.get(target), target);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.closest?.("[data-usage-tooltip]")) {
      hideUsageTooltip();
    }
  });
}

function homeStatusLabel(home) {
  // Convert machine-friendly scan states into compact dashboard labels.
  if (home.type === "unsupported" || home.status === "unsupported") {
    return "不可用";
  }
  if (home.status === "active" && home.eventCount > 0) {
    return "有用量记录";
  }
  if (home.status === "no-events") {
    return "无用量记录";
  }
  return "可扫描";
}

function homeRowsFromMetadata(metadata) {
  // Preserve unsupported stored imports so users can remove or fix them.
  const homes = [...(metadata.homes || [])];
  const seen = new Set(homes.map((home) => home.path));
  for (const entry of metadata.imports || []) {
    if (seen.has(entry.path)) {
      continue;
    }
    homes.push({
      ...entry,
      label: entry.label || entry.path,
      kind: entry.type,
      imported: true,
      status: entry.type === "unsupported" ? "unsupported" : "active",
      eventCount: 0,
      sessionCount: 0,
    });
  }
  return homes;
}

export function renderHomesHtml(homes, { canModify = false } = {}) {
  // Render paths and labels as escaped text because they may come from imported logs.
  if (!homes.length) {
    return `<div class="empty">没有发现 Codex 目录</div>`;
  }
  return homes
    .map((home) => {
      const label = escapeHtml(home.label);
      const kind = escapeHtml(home.kind || home.type || "");
      const status = escapeHtml(homeStatusLabel(home));
      const pathText = escapeHtml(home.path);
      const reason = home.reason ? `<div class="home-reason">${escapeHtml(home.reason)}</div>` : "";
      const counts = `${formatTokens(home.eventCount || 0)} 条事件 · ${formatTokens(home.sessionCount || 0)} 个会话`;
      const removeButton =
        canModify && home.imported
          ? `<button class="home-remove" type="button" data-import-action="remove" data-import-path="${pathText}" aria-label="移除 ${label}">移除</button>`
          : "";
      return `
        <div class="home-row">
          <div class="home-label">
            <strong>${label}</strong>
            <span class="home-kind">${kind}</span>
          </div>
          <div class="home-meta">
            <span class="home-status">${status}</span>
            <span>${counts}</span>
            ${removeButton}
          </div>
          <div class="home-path" title="${pathText}">${pathText}</div>
          ${reason}
        </div>
      `;
    })
    .join("");
}

function renderHomes(homes, options = {}) {
  const container = $("#homeList");
  container.innerHTML = renderHomesHtml(homes, options);
}

function metadataFromReport(report) {
  const homeStats = new Map();
  for (const event of report.events) {
    const current = homeStats.get(event.homeId) || {
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.sessionId);
    homeStats.set(event.homeId, current);
  }
  return {
    generatedAt: report.generatedAt,
    eventCount: report.events.length,
    sessionCount: report.sessions.length,
    homes: report.homes.map((home) => {
      const stats = homeStats.get(home.id) || { eventCount: 0, sessions: new Set() };
      return {
        ...home,
        status: stats.eventCount > 0 ? "active" : "no-events",
        eventCount: stats.eventCount,
        sessionCount: stats.sessions.size,
      };
    }),
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
  renderComparison(summary);
  $("#rangeLabel").textContent = rangeLabel(summary);
  const channelColors = getChannelColors(summary.channels);
  const projectRows = filterRankedRows(summary.projects, {
    query: state.projectQuery,
    expanded: state.projectsExpanded,
  });
  const modelRows = filterRankedRows(summary.models, {
    query: state.modelQuery,
    expanded: state.modelsExpanded,
  });
  renderBarList($("#channelList"), summary.channels, channelColors);
  renderCompactList($("#projectList"), projectRows);
  renderCompactList($("#modelList"), modelRows);
  updateRankedListControls("project", summary.projects);
  updateRankedListControls("model", summary.models);
  renderHomes(homeRowsFromMetadata(metadata), { canModify: !isStaticSnapshot() });
  drawTimeline($("#timelineChart"), summary.timeline, summary.channels, channelColors, summary.range);
  renderTimelineDetails($("#timelineDetails"), summary.timeline);
}

function clockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setAutoRefreshStatus(message) {
  $("#autoRefreshStatus").textContent = message;
}

function setImportControlsDisabled(disabled) {
  for (const selector of ["#importButton", "#addImportButton", "#pickImportDirectoryButton"]) {
    const button = $(selector);
    if (!button) {
      continue;
    }
    button.disabled = disabled;
    button.title = disabled ? "静态快照不能导入目录" : "";
  }
}

async function pickImportDirectory() {
  if (isStaticSnapshot()) {
    setImportMessage("静态快照不能选择目录，请启动本地服务或手动输入路径。", true);
    return;
  }

  const pickButton = $("#pickImportDirectoryButton");
  pickButton.disabled = true;
  setImportMessage("正在打开文件夹选择器...");
  try {
    const response = await fetch("/api/pick-directory", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `API ${response.status}`);
    }
    if (data.path) {
      $("#importPath").value = data.path;
      setImportMessage("已选择目录，可继续导入。");
    } else {
      setImportMessage("没有选择目录。");
    }
  } catch (error) {
    setImportMessage(`选择失败：${error.message}，也可以手动输入路径。`, true);
  } finally {
    pickButton.disabled = false;
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

async function removeImportDirectory(importPath) {
  // Removing an import mutates local service state, so static snapshots refuse it.
  if (isStaticSnapshot()) {
    setAutoRefreshStatus("静态快照不能移除导入目录，请启动本地服务后再操作");
    return;
  }
  setAutoRefreshStatus("正在移除导入目录...");
  const response = await fetch(`/api/imports?path=${encodeURIComponent(importPath)}`, {
    method: "DELETE",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `API ${response.status}`);
  }
  setAutoRefreshStatus("已移除导入目录，正在刷新...");
  await loadUsage({ force: true });
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
  for (const option of document.querySelectorAll("[data-recent-option]")) {
    option.setAttribute("aria-selected", String(option.dataset.recentOption === state.recentValue));
  }
}

function updateBucketSelect() {
  // Keep the native select in sync when presets adjust bucket state programmatically.
  const bucketSelect = $("#bucketSelect");
  if (bucketSelect && bucketSelect.value !== state.bucket) {
    bucketSelect.value = state.bucket;
  }
}

function dateFieldKey(field) {
  return field === "end" ? "endDate" : "startDate";
}

function dateInputForField(field) {
  return field === "end" ? $("#endDate") : $("#startDate");
}

function datePickerForField(field) {
  return field === "end" ? $("#endDatePicker") : $("#startDatePicker");
}

function datePickerButtonForField(field) {
  return document.querySelector(`[data-date-picker-button="${field}"]`);
}

function datePickerViewDate(field) {
  const selected = parseLocalDate(state[dateFieldKey(field)]);
  if (selected) {
    return selected;
  }
  if (state.datePickerViews[field]) {
    return state.datePickerViews[field];
  }
  return new Date();
}

function renderDatePicker(field) {
  const picker = datePickerForField(field);
  if (!picker) {
    return;
  }
  picker.innerHTML = renderDatePickerHtml({
    field,
    viewDate: datePickerViewDate(field),
    selectedValue: state[dateFieldKey(field)],
  });
}

function closeDatePickers() {
  state.datePickerField = "";
  for (const field of ["start", "end"]) {
    const picker = datePickerForField(field);
    const button = datePickerButtonForField(field);
    if (picker) {
      picker.hidden = true;
    }
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
  }
}

function setDatePickerOpen(field, open) {
  if (!open) {
    closeDatePickers();
    return;
  }
  closeDatePickers();
  state.datePickerField = field;
  state.datePickerViews[field] = datePickerViewDate(field);
  renderDatePicker(field);
  const picker = datePickerForField(field);
  const button = datePickerButtonForField(field);
  if (picker) {
    picker.hidden = false;
  }
  if (button) {
    button.setAttribute("aria-expanded", "true");
  }
}

function applyDateValue(field, value) {
  const key = dateFieldKey(field);
  state[key] = value;
  const input = dateInputForField(field);
  if (input) {
    input.value = value;
  }
  state.preset = "custom";
  updatePresetButtons();
  refreshViewForFilters();
}

function applyTypedDateValue(field, value) {
  const normalized = normalizeDateInput(value);
  if (normalized === null) {
    return;
  }
  applyDateValue(field, normalized);
}

function selectDatePickerDate(field, value) {
  const date = parseLocalDate(value);
  if (!date) {
    return;
  }
  state.datePickerViews[field] = monthStart(date);
  applyDateValue(field, dateKey(date));
  closeDatePickers();
}

function shiftDatePickerMonth(field, offset) {
  const current = datePickerViewDate(field);
  state.datePickerViews[field] = new Date(current.getFullYear(), current.getMonth() + offset, 1);
  renderDatePicker(field);
}

function setRecentMenuOpen(open) {
  const menu = $("#recentRangeMenu");
  const input = $("#recentValue");
  const button = $("#recentMenuButton");
  const segment = document.querySelector(".recent-segment");
  if (!menu || !input || !button || !segment) {
    return;
  }
  menu.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-expanded", String(open));
  segment.classList.toggle("menu-open", open);
}

function activateRecentValue(value) {
  const next = nextRecentState(state, value);
  state.recentValue = next.recentValue;
  state.preset = next.preset;
  state.bucket = next.bucket;
  updateBucketSelect();
  updatePresetButtons();
  updateRecentControls();
  setRecentMenuOpen(false);
  refreshViewForFilters();
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

function updateRankedQuery(kind, value) {
  // Query changes are purely local and should not trigger a server rescan.
  if (kind === "project") {
    state.projectQuery = value;
  } else {
    state.modelQuery = value;
  }
  render();
}

function toggleRankedExpansion(kind) {
  if (kind === "project") {
    state.projectsExpanded = !state.projectsExpanded;
  } else {
    state.modelsExpanded = !state.modelsExpanded;
  }
  render();
}

function bootDashboard() {
  setupUsageTooltip();

  $("#presetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) {
      return;
    }
    const next = nextPresetState(state, button.dataset.preset);
    state.preset = next.preset;
    state.bucket = next.bucket;
    updateBucketSelect();
    updatePresetButtons();
    updateRecentControls();
    refreshViewForFilters();
  });

  $("#bucketSelect").addEventListener("change", (event) => {
    state.bucket = event.target.value;
    refreshViewForFilters();
  });

  for (const field of ["start", "end"]) {
    const input = dateInputForField(field);
    const button = datePickerButtonForField(field);
    const picker = datePickerForField(field);
    input.addEventListener("change", (event) => {
      applyTypedDateValue(field, event.target.value);
    });
    input.addEventListener("focus", () => setDatePickerOpen(field, true));
    input.addEventListener("click", () => setDatePickerOpen(field, true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDatePickers();
      }
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setDatePickerOpen(field, state.datePickerField !== field);
      input.focus();
    });
    picker.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-date-picker-action]");
      if (nav) {
        event.stopPropagation();
        shiftDatePickerMonth(field, nav.dataset.datePickerAction === "next" ? 1 : -1);
        return;
      }
      const day = event.target.closest("[data-date]");
      if (!day) {
        return;
      }
      event.stopPropagation();
      selectDatePickerDate(field, day.dataset.date);
    });
  }

  $("#recentValue").addEventListener("change", (event) => {
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("focus", () => {
    state.preset = "recent";
    updatePresetButtons();
    setRecentMenuOpen(true);
  });

  $("#recentMenuButton").addEventListener("click", (event) => {
    event.stopPropagation();
    state.preset = "recent";
    updatePresetButtons();
    const shouldOpen = $("#recentRangeMenu").hidden;
    $("#recentValue").focus();
    setRecentMenuOpen(shouldOpen);
  });

  $("#recentRangeMenu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-recent-option]");
    if (!option) {
      return;
    }
    event.stopPropagation();
    activateRecentValue(option.dataset.recentOption);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".recent-segment")) {
      setRecentMenuOpen(false);
    }
    if (!event.target.closest(".date-input-wrap")) {
      closeDatePickers();
    }
  });

  $("#refreshButton").addEventListener("click", () => loadUsage({ force: true }));
  $("#importButton").addEventListener("click", openImportDialog);
  $("#addImportButton").addEventListener("click", openImportDialog);
  $("#projectSearch").addEventListener("input", (event) => updateRankedQuery("project", event.target.value));
  $("#modelSearch").addEventListener("input", (event) => updateRankedQuery("model", event.target.value));
  $("#projectToggle").addEventListener("click", () => toggleRankedExpansion("project"));
  $("#modelToggle").addEventListener("click", () => toggleRankedExpansion("model"));
  $("#homeList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-import-action='remove']");
    if (!button) {
      return;
    }
    button.disabled = true;
    removeImportDirectory(button.dataset.importPath).catch((error) => {
      button.disabled = false;
      setAutoRefreshStatus(`移除失败：${error.message}`);
    });
  });
  $("#importForm").addEventListener("submit", submitImportDirectory);
  $("#pickImportDirectoryButton").addEventListener("click", pickImportDirectory);
  $("#cancelImportButton").addEventListener("click", closeImportDialog);
  $("#closeImportDialogButton").addEventListener("click", closeImportDialog);
  $("#importDialog").addEventListener("click", (event) => {
    if (event.target.id === "importDialog") {
      closeImportDialog();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setRecentMenuOpen(false);
    }
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
  updateBucketSelect();
  setImportControlsDisabled(isStaticSnapshot());
  loadUsage().then(startAutoRefresh);
}

if (typeof document !== "undefined") {
  bootDashboard();
}
