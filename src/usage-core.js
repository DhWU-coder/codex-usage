import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const SESSION_DIRS = ["sessions", "archived_sessions"];
const PROJECT_USAGE_DIR = ".codex-usage";
const PROJECT_USAGE_FILE = "usage.jsonl";
const PROJECT_LOG_SCHEMA_VERSION = "codex-usage.project-log.v1";
const USAGE_FIELDS = [
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
];

export function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function usageFromRaw(raw = {}) {
  return {
    total: Number(raw.total_tokens || 0),
    input: Number(raw.input_tokens || 0),
    cached: Number(raw.cached_input_tokens || 0),
    output: Number(raw.output_tokens || 0),
    reasoning: Number(raw.reasoning_output_tokens || 0),
  };
}

function addUsage(target, usage) {
  for (const field of USAGE_FIELDS) {
    target[field] += usage[field] || 0;
  }
  return target;
}

function diffUsage(current, previous) {
  const diff = emptyUsage();
  for (const field of USAGE_FIELDS) {
    diff[field] = Math.max(0, (current[field] || 0) - (previous[field] || 0));
  }
  return diff;
}

function isZeroUsage(usage) {
  return USAGE_FIELDS.every((field) => !usage[field]);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeId(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function codexHomeLooksUsable(homePath) {
  const checks = await Promise.all([
    exists(path.join(homePath, "sessions")),
    exists(path.join(homePath, "archived_sessions")),
    exists(path.join(homePath, "state_5.sqlite")),
  ]);
  return checks.some(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const candidate of paths.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function optionImportDirs(options = {}) {
  const env = options.env || process.env;
  const configured = [];
  if (Array.isArray(options.importDirs)) {
    configured.push(...options.importDirs);
  } else if (typeof options.importDirs === "string") {
    configured.push(...options.importDirs.split(path.delimiter));
  }
  if (env.CODEX_USAGE_IMPORT_DIRS) {
    configured.push(...env.CODEX_USAGE_IMPORT_DIRS.split(path.delimiter));
  }
  return uniquePaths(configured);
}

export async function classifyImportDirectory(importPath) {
  const resolved = path.resolve(importPath);
  if (await codexHomeLooksUsable(resolved)) {
    return {
      type: "codex-home",
      path: resolved,
    };
  }

  const directUsageLogPath = path.join(resolved, PROJECT_USAGE_FILE);
  if (path.basename(resolved) === PROJECT_USAGE_DIR && (await exists(directUsageLogPath))) {
    return {
      type: "project-log",
      path: path.dirname(resolved),
      usageLogPath: directUsageLogPath,
    };
  }

  const usageLogPath = path.join(resolved, PROJECT_USAGE_DIR, PROJECT_USAGE_FILE);
  if (await exists(usageLogPath)) {
    return {
      type: "project-log",
      path: resolved,
      usageLogPath,
    };
  }

  return {
    type: "unsupported",
    path: resolved,
    reason: `目录需要是 Codex home，或包含 ${PROJECT_USAGE_DIR}/${PROJECT_USAGE_FILE}`,
  };
}

function jetBrainsRoots({ homeDir, platform, env }) {
  const roots = [path.join(homeDir, "Library", "Caches", "JetBrains")];

  if (platform === "win32") {
    roots.push(
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "JetBrains") : "",
      env.APPDATA ? path.join(env.APPDATA, "JetBrains") : "",
      path.join(homeDir, "AppData", "Local", "JetBrains"),
      path.join(homeDir, "AppData", "Roaming", "JetBrains"),
    );
  }

  return uniquePaths(roots);
}

export async function discoverCodexHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || os.platform();
  const envHomes = options.extraHomes || env.CODEX_USAGE_HOMES || "";
  const homes = [];
  const seen = new Set();

  async function addHome(label, homePath, kind = "codex") {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await codexHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: normalizeId(`${kind}-${label}-${homes.length + 1}`),
      label,
      path: resolved,
      kind,
    });
  }

  await addHome("Main Codex", path.join(homeDir, ".codex"), "main");

  for (const jetbrainsRoot of jetBrainsRoots({ homeDir, platform, env })) {
    if (!(await exists(jetbrainsRoot))) {
      continue;
    }
    for (const entry of await readdir(jetbrainsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const productName = entry.name;
      await addHome(
        `JetBrains ${productName}`,
        path.join(jetbrainsRoot, productName, "aia", "codex"),
        "jetbrains",
      );
    }
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Extra ${path.basename(extraHome)}`, extraHome, "extra");
  }

  return homes;
}

export async function discoverUsageSources(options = {}) {
  const sources = await discoverCodexHomes(options);
  const seenPaths = new Set(sources.map((source) => source.path));
  const seenProjectLogs = new Set();

  for (const importDir of optionImportDirs(options)) {
    const classified = await classifyImportDirectory(importDir);
    if (classified.type === "codex-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: normalizeId(`extra-${path.basename(classified.path) || "codex"}-${sources.length + 1}`),
        label: `Imported ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "extra",
        imported: true,
      });
      continue;
    }

    if (classified.type !== "project-log") {
      continue;
    }

    if (seenProjectLogs.has(classified.usageLogPath)) {
      continue;
    }
    seenProjectLogs.add(classified.usageLogPath);
    sources.push({
      id: normalizeId(`project-log-${path.basename(classified.path) || "project"}-${sources.length + 1}`),
      label: `Project ${path.basename(classified.path) || classified.path}`,
      path: classified.path,
      kind: "project-log",
      usageLogPath: classified.usageLogPath,
      imported: true,
    });
  }

  return sources;
}

async function walkJsonlFiles(root, files = []) {
  if (!(await exists(root))) {
    return files;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".tmp" || entry.name === "node_modules") {
        continue;
      }
      await walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverSessionFiles(homePath) {
  const groups = await Promise.all(
    SESSION_DIRS.map((dir) => walkJsonlFiles(path.join(homePath, dir), [])),
  );
  return groups.flat().sort();
}

export async function buildUsageFingerprint(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const hash = createHash("sha256");
  let fileCount = 0;

  for (const home of homes) {
    hash.update(`${home.id}\t${home.label}\t${home.path}\t${home.kind || ""}\t${home.usageLogPath || ""}\n`);
    if (home.kind === "project-log" && home.usageLogPath) {
      const info = await stat(home.usageLogPath);
      fileCount += 1;
      hash.update(`${home.usageLogPath}\t${info.size}\t${info.mtimeMs}\n`);
      continue;
    }
    const files = await discoverSessionFiles(home.path);
    for (const file of files) {
      const info = await stat(file);
      fileCount += 1;
      hash.update(`${file}\t${info.size}\t${info.mtimeMs}\n`);
    }
  }

  return {
    fingerprint: hash.digest("hex"),
    fileCount,
    homeCount: homes.length,
    checkedAt: new Date().toISOString(),
  };
}

export function classifyChannel({ originator, source, homeLabel }) {
  const text = `${originator || ""} ${source || ""} ${homeLabel || ""}`.toLowerCase();
  if (text.includes("jetbrains")) {
    return "JetBrains PyCharm";
  }
  if (text.includes("codex desktop")) {
    return "Codex Desktop";
  }
  if (source === "cli" || text.includes("codex-tui") || text.includes("codex_cli")) {
    return "CLI";
  }
  if (source === "exec" || text.includes("codex_exec")) {
    return "Codex Exec";
  }
  if (source === "vscode") {
    return "Editor Integration";
  }
  return originator || source || homeLabel || "Unknown";
}

function fallbackSessionId(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base.replace(/^rollout-/, "") || filePath;
}

function readTokenUsage(payload) {
  const info = payload?.info || {};
  const cumulative = info.total_token_usage ? usageFromRaw(info.total_token_usage) : null;
  const last = info.last_token_usage ? usageFromRaw(info.last_token_usage) : null;
  return { cumulative, last };
}

export async function parseSessionFile(filePath, home) {
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
    cliVersion: "",
    modelProvider: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let finalUsage = emptyUsage();
  let tokenEventCount = 0;
  const events = [];

  // Stream JSONL rows so full-detail reports do not read large session files at once.
  for await (const row of readJsonlRows(filePath)) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      meta.cliVersion = row.payload?.cli_version || meta.cliVersion;
      meta.modelProvider = row.payload?.model_provider || meta.modelProvider;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const { cumulative, last } = readTokenUsage(row.payload);
    let increment = emptyUsage();
    if (cumulative) {
      increment = diffUsage(cumulative, previousCumulative);
      previousCumulative = cumulative;
      finalUsage = cumulative;
    } else if (last) {
      increment = last;
      addUsage(finalUsage, last);
    }

    if (isZeroUsage(increment)) {
      continue;
    }

    tokenEventCount += 1;
    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    events.push({
      id: `${meta.id}:${tokenEventCount}`,
      sessionId: meta.id,
      timestamp: row.timestamp || lastAt || firstAt,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      model,
      total: increment,
    });
  }

  if (!events.length) {
    return null;
  }

  const channel = classifyChannel({
    originator: meta.originator,
    source: meta.source,
    homeLabel: home.homeLabel || home.label,
  });

  return {
    session: {
      id: meta.id,
      filePath,
      firstAt,
      lastAt,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      model,
      cliVersion: meta.cliVersion,
      modelProvider: meta.modelProvider,
      eventCount: events.length,
      total: finalUsage,
    },
    events,
  };
}

async function* readJsonlRows(filePath) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore malformed JSONL rows from interrupted writes.
    }
  }
}

function usageFromProjectLog(raw = {}) {
  const usage = raw || {};
  const input = Number(usage.input ?? usage.input_tokens ?? 0);
  const cached = Number(usage.cached ?? usage.cached_input_tokens ?? 0);
  const output = Number(usage.output ?? usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoning ?? usage.reasoning_output_tokens ?? 0);
  const total = Number(usage.total ?? usage.total_tokens ?? input + output);
  return { total, input, cached, output, reasoning };
}

function projectLogTimestamp(row) {
  return row.timestamp || row.created_at || row.createdAt || "";
}

function projectLogSource(row) {
  return row.source || "project-log";
}

function projectLogChannel(row) {
  if (row.channel) {
    return row.channel;
  }
  return projectLogSource(row) === "codex-oauth" ? "Codex OAuth" : "Project Log";
}

function projectLogUsage(row) {
  return usageFromProjectLog(row.usage || row.token_usage || row.total_token_usage || {});
}

function projectLogSessionId(row, source, rowNumber) {
  return row.session_id || row.sessionId || row.request_id || row.requestId || `${source.id}:${rowNumber}`;
}

function isSupportedProjectLogRow(row) {
  return !row.schema_version || row.schema_version === PROJECT_LOG_SCHEMA_VERSION;
}

async function parseProjectUsageLogFile(filePath, source) {
  const sessions = new Map();
  const events = [];
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const usage = projectLogUsage(row);
    if (isZeroUsage(usage)) {
      continue;
    }

    const sessionId = projectLogSessionId(row, source, rowNumber);
    const sourceName = projectLogSource(row);
    const channel = projectLogChannel(row);
    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const model = row.model || "Unknown model";
    const event = {
      id: row.event_id || row.eventId || row.request_id || row.requestId || `${sessionId}:${events.length + 1}`,
      sessionId,
      timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      model,
      total: usage,
    };
    events.push(event);

    const session = sessions.get(sessionId) || {
      id: sessionId,
      filePath,
      firstAt: timestamp,
      lastAt: timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      model,
      cliVersion: "",
      modelProvider: "",
      eventCount: 0,
      total: emptyUsage(),
    };
    if (time < Date.parse(session.firstAt)) {
      session.firstAt = timestamp;
    }
    if (time > Date.parse(session.lastAt)) {
      session.lastAt = timestamp;
    }
    session.eventCount += 1;
    session.model = model;
    addUsage(session.total, usage);
    sessions.set(sessionId, session);
  }

  return {
    sessions: [...sessions.values()],
    events,
  };
}

function createStringInterner() {
  const values = [];
  const ids = new Map();
  return {
    values,
    intern(value) {
      const text = value || "";
      const existing = ids.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const id = values.length;
      ids.set(text, id);
      values.push(text);
      return id;
    },
  };
}

async function parseSessionFileForIndex(filePath, home, intern) {
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let tokenEventCount = 0;
  const events = [];

  for await (const row of readJsonlRows(filePath)) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const { cumulative, last } = readTokenUsage(row.payload);
    let increment = emptyUsage();
    if (cumulative) {
      increment = diffUsage(cumulative, previousCumulative);
      previousCumulative = cumulative;
    } else if (last) {
      increment = last;
    }

    if (isZeroUsage(increment)) {
      continue;
    }

    tokenEventCount += 1;
    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const timestamp = row.timestamp || lastAt || firstAt;
    events.push({
      t: Date.parse(timestamp),
      s: intern(meta.id),
      h: intern(home.homeId || home.id),
      l: intern(home.homeLabel || home.label),
      c: intern(channel),
      p: intern(meta.cwd),
      m: intern(model),
      total: increment.total,
      input: increment.input,
      cached: increment.cached,
      output: increment.output,
      reasoning: increment.reasoning,
    });
  }

  return events;
}

async function parseProjectUsageLogFileForIndex(filePath, source, intern) {
  const events = [];
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const usage = projectLogUsage(row);
    if (isZeroUsage(usage)) {
      continue;
    }

    events.push({
      t: time,
      s: intern(projectLogSessionId(row, source, rowNumber)),
      h: intern(source.id),
      l: intern(source.label),
      c: intern(projectLogChannel(row)),
      p: intern(row.cwd || row.project_root || row.projectRoot || source.path),
      m: intern(row.model || "Unknown model"),
      total: usage.total,
      input: usage.input,
      cached: usage.cached,
      output: usage.output,
      reasoning: usage.reasoning,
    });
  }

  return events;
}

export async function buildUsageReport(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const sessions = [];
  const events = [];
  const warnings = [];

  for (const home of homes) {
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        const parsed = await parseProjectUsageLogFile(home.usageLogPath, home);
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSessionFile(file, home);
        if (!parsed) {
          continue;
        }
        sessions.push(parsed.session);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  sessions.sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));

  return {
    generatedAt: new Date().toISOString(),
    homes,
    sessions,
    events,
    warnings,
  };
}

export async function buildUsageIndex(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const warnings = [];
  const events = [];
  const interner = createStringInterner();

  for (const home of homes) {
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        events.push(...(await parseProjectUsageLogFileForIndex(home.usageLogPath, home, interner.intern)));
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        events.push(...(await parseSessionFileForIndex(file, home, interner.intern)));
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  events.sort((a, b) => a.t - b.t);

  return {
    generatedAt: new Date().toISOString(),
    homes,
    warnings,
    strings: interner.values,
    events,
    sessionCount: new Set(events.map((event) => event.s)).size,
  };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date) {
  return localDateKey(date).slice(0, 7);
}

function localHourKey(date) {
  // Hour buckets stay in local time so API summaries match the browser dashboard labels.
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSingleLocalDayRange(range = {}) {
  // Single-day hourly summaries should include zero-use hours for a complete 24-hour chart.
  return Boolean(range.start && range.end && localDateKey(range.start) === localDateKey(range.end));
}

function endOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfLocalWeek(date) {
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDateStart(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

function parseDateEnd(value) {
  return value ? new Date(`${value}T23:59:59.999`) : null;
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
    start: startOfLocalDay(start),
    end: endOfLocalDay(now),
    preset: "recent",
  };
}

export function resolveDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
  );
}

function resolveDateRangeFromTimestamps(filters = {}, timestamps = []) {
  // Report and index summaries share this resolver to avoid date-range drift.
  const now = filters.now ? new Date(filters.now) : new Date();
  const preset = filters.preset || "all";
  if (preset === "today") {
    return { start: startOfLocalDay(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "week") {
    return { start: startOfLocalWeek(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfLocalDay(now),
      preset,
    };
  }
  if (preset === "custom") {
    return {
      start: parseDateStart(filters.startDate),
      end: parseDateEnd(filters.endDate),
      preset,
    };
  }
  if (preset === "recent") {
    const range = recentDateRange(filters.recentValue, now);
    if (range) {
      return range;
    }
  }

  if (!timestamps.length) {
    return { start: null, end: null, preset: "all" };
  }
  return {
    start: startOfLocalDay(new Date(Math.min(...timestamps))),
    end: endOfLocalDay(new Date(Math.max(...timestamps))),
    preset: "all",
  };
}

function bucketKey(date, bucket) {
  if (bucket === "hour") {
    return localHourKey(date);
  }
  if (bucket === "month") {
    return monthKey(date);
  }
  if (bucket === "week") {
    return localDateKey(startOfLocalWeek(date));
  }
  return localDateKey(date);
}

function groupByUsage(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.sessionId);
    addUsage(current.total, event.total);
    if (current.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
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
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function indexDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => event.t).filter(Number.isFinite),
  );
}

function addIndexedUsage(target, event) {
  for (const field of USAGE_FIELDS) {
    target[field] += event[field] || 0;
  }
  return target;
}

function groupIndexedEvents(index, events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event) || "Unknown";
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.s);
    addIndexedUsage(current.total, event);
    if (current.channelGroups) {
      const channelKey = index.strings[event.c] || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.s);
      addIndexedUsage(channel.total, event);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
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
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function emptyTimelineRow(key) {
  // Empty timeline rows preserve the same response shape as grouped hourly rows.
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
  // Only single-day hourly views are expanded; longer ranges stay compact and sampled by the chart.
  if (bucket !== "hour" || !isSingleLocalDayRange(range)) {
    return rows;
  }
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const start = startOfLocalDay(range.start);
  return Array.from({ length: 24 }, (_, hour) => {
    const bucketStart = new Date(start);
    bucketStart.setHours(hour, 0, 0, 0);
    const key = localHourKey(bucketStart);
    return rowsByKey.get(key) || emptyTimelineRow(key);
  });
}

export function usageIndexMetadata(index) {
  const homeStats = homeStatsFromIndex(index);
  return {
    generatedAt: index.generatedAt,
    eventCount: index.events.length,
    sessionCount: index.sessionCount,
    homeCount: index.homes.length,
    homes: index.homes.map((home) => ({
      ...home,
      ...(homeStats.get(home.id) || {
        status: "no-events",
        eventCount: 0,
        sessionCount: 0,
      }),
    })),
    warnings: index.warnings,
  };
}

function homeStatsFromIndex(index) {
  // Attach per-home activity counts without expanding the compact index into full events.
  const stats = new Map();
  for (const event of index.events) {
    const homeId = index.strings[event.h] || "";
    const current = stats.get(homeId) || {
      status: "active",
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.s);
    stats.set(homeId, current);
  }
  return new Map(
    [...stats.entries()].map(([homeId, stat]) => [
      homeId,
      {
        status: stat.eventCount > 0 ? "active" : "no-events",
        eventCount: stat.eventCount,
        sessionCount: stat.sessions.size,
      },
    ]),
  );
}

function previousPeriodRange(range) {
  if (!range.start || !range.end || range.preset === "all") {
    return null;
  }
  if (range.preset === "today") {
    const previousDay = addLocalDays(startOfLocalDay(range.start), -1);
    return {
      start: previousDay,
      end: endOfLocalDay(previousDay),
    };
  }
  if (range.preset === "week") {
    const previousWeekStart = addLocalDays(startOfLocalWeek(range.start), -7);
    return {
      start: previousWeekStart,
      end: endOfLocalDay(addLocalDays(previousWeekStart, 6)),
    };
  }
  if (range.preset === "month") {
    const currentMonthStart = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: endOfLocalDay(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0)),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  if (!range?.start || !range?.end) {
    return 0;
  }
  return Math.max(0, range.end.getTime() - range.start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  if (!range?.start || !range?.end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(range.end.getTime(), Math.max(range.start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - range.start.getTime() + 1);
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

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function comparisonLabel(preset) {
  return {
    today: "较昨日",
    week: "较上周",
    month: "较上月",
    custom: "较上一等长周期",
    recent: "较上一等长周期",
  }[preset] || "暂无对比";
}

function usageComparison({ range, allEvents, eventTime, eventSession, addEventUsage, currentTotals, now }) {
  // 保持调用方事件结构不变，只在这里统一计算上一周期和趋势。
  const previousRange = previousPeriodRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(range.preset),
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
    const time = eventTime(event);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addEventUsage(sum, event), emptyUsage());
  const previousSessions = new Set(previousEvents.map(eventSession));
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);

  return {
    label: comparisonLabel(range.preset),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: previousSessions.size,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

export function summarizeUsageIndex(index, filters = {}) {
  const bucket = filters.bucket || "day";
  const strings = index.strings;
  const range = indexDateRange(filters, index.events);
  const now = filters.now ? new Date(filters.now) : new Date();
  const events = index.events.filter((event) => {
    if (!Number.isFinite(event.t)) {
      return false;
    }
    if (range.start && event.t < range.start.getTime()) {
      return false;
    }
    if (range.end && event.t > range.end.getTime()) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => event.s));
  const totals = events.reduce((sum, event) => addIndexedUsage(sum, event), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents: index.events,
    eventTime: (event) => event.t,
    eventSession: (event) => event.s,
    addEventUsage: addIndexedUsage,
    currentTotals: totals,
    now,
  });
  const timeline = completeHourlyTimeline(
    groupIndexedEvents(index, events, (event) => bucketKey(new Date(event.t), bucket), { includeChannels: true }).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    range,
    bucket,
  );

  return {
    generatedAt: index.generatedAt,
    range: {
      preset: range.preset,
      start: range.start ? range.start.toISOString() : null,
      end: range.end ? range.end.toISOString() : null,
      bucket,
    },
    totals,
    comparison,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.h)).size,
    timeline,
    channels: groupIndexedEvents(index, events, (event) => strings[event.c]),
    homes: groupIndexedEvents(index, events, (event) => strings[event.l]),
    models: groupIndexedEvents(index, events, (event) => strings[event.m] || "Unknown model"),
    projects: groupIndexedEvents(index, events, (event) => strings[event.p] || "Unknown cwd"),
  };
}

export function summarizeUsage(report, filters = {}) {
  const bucket = filters.bucket || "day";
  const range = resolveDateRange(filters, report.events);
  const now = filters.now ? new Date(filters.now) : new Date();
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

  const sessionIds = new Set(events.map((event) => event.sessionId));
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents: report.events,
    eventTime: (event) => Date.parse(event.timestamp),
    eventSession: (event) => event.sessionId,
    addEventUsage: (sum, event) => addUsage(sum, event.total),
    currentTotals: totals,
    now,
  });
  const timeline = completeHourlyTimeline(
    groupByUsage(events, (event) => bucketKey(new Date(event.timestamp), bucket), { includeChannels: true }).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    range,
    bucket,
  );

  return {
    generatedAt: report.generatedAt,
    range: {
      preset: range.preset,
      start: range.start ? range.start.toISOString() : null,
      end: range.end ? range.end.toISOString() : null,
      bucket,
    },
    totals,
    comparison,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.homeId)).size,
    timeline,
    channels: groupByUsage(events, (event) => event.channel),
    homes: groupByUsage(events, (event) => event.homeLabel),
    models: groupByUsage(events, (event) => event.model || "Unknown model"),
    projects: groupByUsage(events, (event) => event.cwd || "Unknown cwd"),
  };
}
