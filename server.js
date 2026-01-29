const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const port = process.env.PORT || 3000;
const publicRoot = path.join(__dirname, "public");

const targets = new Map();

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const serveStatic = (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsedUrl.pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const filePath = path.join(publicRoot, pathname);
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(content);
  });
};

const fetchWithTimeout = async (url, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
};

const diffLines = (before, after) => {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const rows = beforeLines.length;
  const cols = afterLines.length;
  const dp = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));

  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff = [];
  let i = rows;
  let j = cols;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      diff.unshift({ type: "context", text: beforeLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: "added", text: afterLines[j - 1] });
      j -= 1;
    } else if (i > 0) {
      diff.unshift({ type: "removed", text: beforeLines[i - 1] });
      i -= 1;
    }
  }

  return diff;
};

const summarizeDiff = (diff) => {
  let added = 0;
  let removed = 0;

  diff.forEach((entry) => {
    if (entry.type === "added") {
      added += 1;
    }
    if (entry.type === "removed") {
      removed += 1;
    }
  });

  return { added, removed };
};

const buildTargetResponse = (target) => ({
  id: target.id,
  url: target.url,
  lastCheckedAt: target.lastCheckedAt,
  lastChangedAt: target.lastChangedAt,
  status: target.status
});

const handler = async (req, res) => {
  if (req.url.startsWith("/api/targets")) {
    if (req.method === "GET" && req.url === "/api/targets") {
      const list = Array.from(targets.values()).map(buildTargetResponse);
      sendJson(res, 200, { targets: list });
      return;
    }

    if (req.method === "POST" && req.url === "/api/targets") {
      try {
        const body = await readRequestBody(req);
        const { url } = JSON.parse(body || "{}");
        if (!url) {
          sendJson(res, 400, { error: "URL is required" });
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(url);
        } catch (error) {
          sendJson(res, 400, { error: "Invalid URL" });
          return;
        }

        if (!parsedUrl.protocol.startsWith("http")) {
          sendJson(res, 400, { error: "Only http/https URLs are supported" });
          return;
        }

        const id = crypto.randomUUID();
        const target = {
          id,
          url: parsedUrl.toString(),
          history: [],
          lastCheckedAt: null,
          lastChangedAt: null,
          status: "pending"
        };

        targets.set(id, target);

        try {
          const content = await fetchWithTimeout(target.url);
          const now = new Date().toISOString();
          target.history.push({
            id: crypto.randomUUID(),
            timestamp: now,
            content,
            diff: [],
            summary: { added: 0, removed: 0 }
          });
          target.lastCheckedAt = now;
          target.status = "ok";
        } catch (error) {
          target.status = `error: ${error.message}`;
        }

        sendJson(res, 201, buildTargetResponse(target));
        return;
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
    }

    const checkMatch = req.url.match(/^\/api\/targets\/([^/]+)\/check$/);
    if (checkMatch && req.method === "POST") {
      const target = targets.get(checkMatch[1]);
      if (!target) {
        sendJson(res, 404, { error: "Target not found" });
        return;
      }

      try {
        const content = await fetchWithTimeout(target.url);
        const now = new Date().toISOString();
        target.lastCheckedAt = now;
        target.status = "ok";

        const previous = target.history[target.history.length - 1];
        if (!previous || previous.content !== content) {
          const diff = previous ? diffLines(previous.content, content) : [];
          const summary = summarizeDiff(diff);
          target.history.push({
            id: crypto.randomUUID(),
            timestamp: now,
            content,
            diff,
            summary
          });
          target.lastChangedAt = now;
        }
      } catch (error) {
        target.status = `error: ${error.message}`;
      }

      sendJson(res, 200, buildTargetResponse(target));
      return;
    }

    const historyMatch = req.url.match(/^\/api\/targets\/([^/]+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const target = targets.get(historyMatch[1]);
      if (!target) {
        sendJson(res, 404, { error: "Target not found" });
        return;
      }

      const history = target.history.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        diff: entry.diff,
        summary: entry.summary
      }));

      sendJson(res, 200, { history });
      return;
    }

    sendJson(res, 404, { error: "Endpoint not found" });
    return;
  }

  serveStatic(req, res);
};

http.createServer(handler).listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
