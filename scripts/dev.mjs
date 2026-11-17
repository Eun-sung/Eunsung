// 로컬 확인용 서버: Worker 핸들러를 Node에서 그대로 실행한다. (KV는 메모리로 대체)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../src/worker.js";

const store = new Map();
const env = {
  KV: {
    get: async (k, type) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null),
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  },
  APP_PIN: process.env.APP_PIN || "1234",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  KIS_APP_KEY: process.env.KIS_APP_KEY,
  KIS_APP_SECRET: process.env.KIS_APP_SECRET,
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
const root = new URL("../public/", import.meta.url).pathname;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await worker.fetch(
        new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }),
        env,
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(await r.text());
    }
    try {
      const file = join(root, normalize(url.pathname === "/" ? "/index.html" : url.pathname));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  })
  .listen(8787, () => console.log("http://localhost:8787"));
