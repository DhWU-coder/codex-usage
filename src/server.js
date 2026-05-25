import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

import {
  buildUsageFingerprint,
  buildUsageIndex,
  buildUsageReport,
  summarizeUsage,
  summarizeUsageIndex,
  usageIndexMetadata,
} from "./usage-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MIN_FULL_DETAIL_HEAP_BYTES = 256 * 1024 * 1024;

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
  };
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
    if (!force && !check && cache) {
      return {
        fingerprint: cache.fingerprint,
        checkedAt: new Date().toISOString(),
        index: cache.index,
      };
    }

    const status = await buildUsageFingerprint(options);
    if (force || !cache || cache.fingerprint !== status.fingerprint) {
      cache = {
        fingerprint: status.fingerprint,
        index: await buildUsageIndex(options),
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
        const status = await buildUsageFingerprint(options);
        const since = url.searchParams.get("since") || "";
        sendJson(response, 200, {
          fingerprint: status.fingerprint,
          changed: since ? status.fingerprint !== since : true,
          checkedAt: status.checkedAt,
        });
        return;
      }

      if (url.pathname === "/api/usage") {
        const force = url.searchParams.get("force") === "1";
        const detail = url.searchParams.get("detail");
        if (detail === "full") {
          if (v8.getHeapStatistics().heap_size_limit < MIN_FULL_DETAIL_HEAP_BYTES) {
            sendJson(response, 413, {
              error:
                "Full detail report is disabled in low-memory gateway mode. Restart with codex-usage gateway --memory-mb 512, or use npm run export for a static snapshot.",
            });
            return;
          }

          const status = await buildUsageFingerprint(options);
          const report = await buildUsageReport(options);
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
