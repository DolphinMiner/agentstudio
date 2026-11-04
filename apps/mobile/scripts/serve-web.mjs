#!/usr/bin/env node
// Serve the static Expo web export (web-build/) on 127.0.0.1:18300 with an
// SPA fallback to index.html. Dependency-free on purpose.
//
// Env: PORT (default 18300), HOST (default 127.0.0.1), WEB_BUILD_DIR.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.WEB_BUILD_DIR ?? join(here, "..", "web-build"));
const port = Number(process.env.PORT ?? 18300);
const host = process.env.HOST ?? "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** Map a URL path to a file inside root, or null if it escapes root. */
export function resolvePath(rootDir, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const full = normalize(join(rootDir, p));
  if (full !== rootDir && !full.startsWith(rootDir + sep)) return null;
  return full;
}

async function fileAt(path) {
  try {
    const s = await stat(path);
    if (s.isFile()) return { path, size: s.size };
    if (s.isDirectory()) return fileAt(join(path, "index.html"));
  } catch {
    // not found
  }
  return null;
}

export function createWebServer(rootDir = root) {
  return createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const target = resolvePath(rootDir, req.url ?? "/");
    if (!target) {
      res.writeHead(400).end("bad path");
      return;
    }
    let file = await fileAt(target);
    // SPA fallback: unknown paths without a file extension get index.html.
    if (!file && !extname(target)) file = await fileAt(join(rootDir, "index.html"));
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    const type = TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
    const hashed = file.path.includes(`${sep}_expo${sep}`) || file.path.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": file.size,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file.path).pipe(res);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await stat(join(root, "index.html")).catch(() => null);
  if (!s) {
    console.error(`No web build at ${root}. Run: pnpm --filter @agentstudio/mobile build:web`);
    process.exit(1);
  }
  createWebServer(root).listen(port, host, () => {
    console.log(`AgentStudio mobile web: http://${host}:${port} (serving ${root})`);
  });
}
