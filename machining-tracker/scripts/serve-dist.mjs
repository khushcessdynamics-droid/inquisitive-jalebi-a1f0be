#!/usr/bin/env node
// Serves a production build the way Cloudflare Pages does, for testing before deployment:
// applies the rules in _headers matched on the REQUEST path (path patterns with "*"), serves /index.html for unknown paths
// (Pages' single-page application mode when there is no top-level 404.html) and serves files with the right content types.
// Usage: node scripts/serve-dist.mjs <dist folder> <port>
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "apps/web/dist");
const port = Number(process.argv[3] ?? 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(":");
      current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules.map((r) => ({ ...r, re: new RegExp(`^${r.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`) }));
}
const rules = existsSync(join(root, "_headers")) ? parseHeaders(readFileSync(join(root, "_headers"), "utf8")) : [];

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(root) || path === "/_headers" || path === "/_redirects") {
    res.writeHead(400).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (existsSync(join(file, "index.html"))) file = join(file, "index.html");
    else file = join(root, "index.html"); // single-page app: the router handles the path
  }
  // Pages' default for HTML without a rule; _headers rules (matched on the request path, in file order) override it
  const headers = { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate" };
  for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.headers) headers[k] = v;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`Serving ${root} on http://127.0.0.1:${port}`));
