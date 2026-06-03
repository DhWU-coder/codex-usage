import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

import {
  buildUsageFingerprint,
  buildUsageIndex,
  buildUsageReport,
  classifyImportDirectory,
  summarizeUsage,
  summarizeUsageIndex,
  usageIndexMetadata,
} from "./usage-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MIN_FULL_DETAIL_HEAP_BYTES = 512 * 1024 * 1024;
const DEFAULT_IMPORT_STORE_FILE = path.join(os.homedir(), ".codex-usage", "imports.json");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function requestFilters(url) {
  return {
    preset: url.searchParams.get("preset") || "all",
    bucket: url.searchParams.get("bucket") || "day",
    startDate: url.searchParams.get("startDate") || "",
    endDate: url.searchParams.get("endDate") || "",
    recentValue: url.searchParams.get("recentValue") || "",
  };
}

export function isFullDetailHeapAvailable(heapSizeLimitBytes = v8.getHeapStatistics().heap_size_limit) {
  return heapSizeLimitBytes >= MIN_FULL_DETAIL_HEAP_BYTES;
}

function configuredImportDirs(options = {}) {
  if (Array.isArray(options.importDirs)) {
    return options.importDirs;
  }
  if (typeof options.importDirs === "string") {
    return options.importDirs.split(path.delimiter).filter(Boolean);
  }
  return [];
}

function importStoreFile(options = {}) {
  return options.importStoreFile || DEFAULT_IMPORT_STORE_FILE;
}

function normalizeImportEntries(entries = []) {
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const rawPath = typeof entry === "string" ? entry : entry?.path;
    if (!rawPath) {
      continue;
    }
    const resolved = path.resolve(rawPath);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push({ path: resolved });
  }
  return normalized;
}

async function readImportEntries(options = {}) {
  try {
    const text = await readFile(importStoreFile(options), "utf8");
    const parsed = JSON.parse(text);
    return normalizeImportEntries(Array.isArray(parsed) ? parsed : parsed.imports);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeImportEntries(options, entries) {
  const filePath = importStoreFile(options);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ imports: normalizeImportEntries(entries) }, null, 2) + "\n");
}

async function describeImportEntry(importPath) {
  const classified = await classifyImportDirectory(importPath);
  if (classified.type === "unsupported") {
    return classified;
  }
  return {
    type: classified.type,
    path: classified.path,
    label:
      classified.type === "project-log"
        ? `Project ${path.basename(classified.path) || classified.path}`
        : `Imported ${path.basename(classified.path) || classified.path}`,
    ...(classified.usageLogPath ? { usageLogPath: classified.usageLogPath } : {}),
  };
}

async function listImportEntries(options = {}) {
  const storedEntries = await readImportEntries(options);
  const described = [];
  for (const entry of storedEntries) {
    described.push(await describeImportEntry(entry.path));
  }
  return described.filter((entry) => entry.type !== "unsupported");
}

async function usageOptions(options = {}) {
  const storedEntries = await readImportEntries(options);
  const importDirs = [...configuredImportDirs(options), ...storedEntries.map((entry) => entry.path)];
  return { ...options, importDirs };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) {
      throw new Error("Request body too large");
    }
  }
  return body ? JSON.parse(body) : {};
}

async function serveStatic(requestPath, response) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(normalized)}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendText(response, 404, "Not found");
  }
}

export function createUsageServer(options = {}) {
  let cache = null;

  async function loadUsageIndex({ force = false, check = true } = {}) {
    const currentUsageOptions = await usageOptions(options);
    if (!force && !check && cache) {
      return {
        fingerprint: cache.fingerprint,
        checkedAt: new Date().toISOString(),
        index: cache.index,
      };
    }

    const status = await buildUsageFingerprint(currentUsageOptions);
    if (force || !cache || cache.fingerprint !== status.fingerprint) {
      cache = {
        fingerprint: status.fingerprint,
        index: await buildUsageIndex(currentUsageOptions),
      };
    }
    return {
      ...status,
      index: cache.index,
    };
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    try {
      if (url.pathname === "/api/status") {
        const status = await buildUsageFingerprint(await usageOptions(options));
        const since = url.searchParams.get("since") || "";
        sendJson(response, 200, {
          fingerprint: status.fingerprint,
          changed: since ? status.fingerprint !== since : true,
          checkedAt: status.checkedAt,
        });
        return;
      }

      if (url.pathname === "/api/imports") {
        if (request.method === "GET") {
          sendJson(response, 200, { imports: await listImportEntries(options) });
          return;
        }

        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!body.path) {
            sendJson(response, 400, { error: "Missing import directory path." });
            return;
          }
          const entry = await describeImportEntry(body.path);
          if (entry.type === "unsupported") {
            sendJson(response, 400, { error: entry.reason, path: entry.path });
            return;
          }
          const entries = normalizeImportEntries([...(await readImportEntries(options)), entry]);
          await writeImportEntries(options, entries);
          cache = null;
          sendJson(response, 200, {
            import: entry,
            imports: await listImportEntries(options),
          });
          return;
        }

        if (request.method === "DELETE") {
          const targetPath = path.resolve(url.searchParams.get("path") || "");
          const entries = (await readImportEntries(options)).filter((entry) => entry.path !== targetPath);
          await writeImportEntries(options, entries);
          cache = null;
          sendJson(response, 200, { imports: await listImportEntries(options) });
          return;
        }

        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/api/usage") {
        const force = url.searchParams.get("force") === "1";
        const detail = url.searchParams.get("detail");
        if (detail === "full") {
          if (!isFullDetailHeapAvailable()) {
            sendJson(response, 413, {
              error:
                "Full detail report is disabled in low-memory gateway mode. Restart with codex-usage gateway --memory-mb 512, or use npm run export for a static snapshot.",
            });
            return;
          }

          const currentUsageOptions = await usageOptions(options);
          const status = await buildUsageFingerprint(currentUsageOptions);
          const report = await buildUsageReport(currentUsageOptions);
          sendJson(response, 200, {
            fingerprint: status.fingerprint,
            checkedAt: status.checkedAt,
            metadata: {
              generatedAt: report.generatedAt,
              eventCount: report.events.length,
              sessionCount: report.sessions.length,
              homeCount: report.homes.length,
              homes: report.homes,
              warnings: report.warnings,
            },
            report,
            summary: summarizeUsage(report, requestFilters(url)),
          });
          return;
        }

        const check = url.searchParams.get("skipCheck") !== "1";
        const usage = await loadUsageIndex({ force, check });
        sendJson(response, 200, {
          fingerprint: usage.fingerprint,
          checkedAt: usage.checkedAt,
          metadata: usageIndexMetadata(usage.index),
          summary: summarizeUsageIndex(usage.index, requestFilters(url)),
        });
        return;
      }

      if (url.pathname === "/api/summary") {
        const usage = await loadUsageIndex();
        sendJson(response, 200, {
          fingerprint: usage.fingerprint,
          checkedAt: usage.checkedAt,
          metadata: usageIndexMetadata(usage.index),
          summary: summarizeUsageIndex(usage.index, requestFilters(url)),
        });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3765);
  const host = process.env.HOST || "127.0.0.1";
  const server = createUsageServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Codex Usage dashboard: http://${host}:${actualPort}`);
  });
}
