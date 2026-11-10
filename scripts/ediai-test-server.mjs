/**
 * Тестовый сервер для E2E-проверки сборки Ежедневника на ediai.ru/pwa.
 * Раздаёт статику из указанной папки и эмулирует протокол api.php.
 * Запуск: node scripts/ediai-test-server.mjs <корень> <порт>
 */
import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || "/home/z/my-project/download/ediai-pwa");
const PORT = Number(process.argv[3] || 8090);
const KEY = "5e254577c0cffc3536b691c9368b46ed";
const STORAGE = path.join(ROOT, "pwa", "storage", "db.json");
const PUSH_SUBS = path.join(ROOT, "pwa", "storage", "push-subscriptions.json");
// VAPID-ключи для локального теста push (та же пара, что в deploy/api.php)
const VAPID_PUBLIC = "BAWVggx3TiOGr6UxJIqhOpoMgpA_lFOt7lLlsBI3vthuqhCIXtjnmrY8Dh17bqjvtVbi6GspUxc4LSyGsyNDgkw";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function jsonOut(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  console.log(new Date().toISOString(), req.method, p);

  /* ---------- эмуляция api.php (тот же протокол, что в deploy/api.php) ---------- */
  if (p === "/pwa/api.php") {
    const key = req.headers["x-sync-key"] || url.searchParams.get("key") || "";
    if (key !== KEY) return jsonOut(res, 403, { ok: false, error: "bad_key" });
    const action = url.searchParams.get("action") || "";
    if (action === "status") {
      return jsonOut(res, 200, {
        ok: true,
        app: "ezhednik",
        php: "8.2-mock",
        push: true,
        time: new Date().toISOString(),
      });
    }
    if (action === "push" && req.method === "GET") {
      return jsonOut(res, 200, { ok: true, publicKey: VAPID_PUBLIC });
    }
    if (action === "subscribe" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const sub = JSON.parse(body);
          if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
            return jsonOut(res, 400, { ok: false, error: "bad_subscription" });
          }
          const subs = await readFile(PUSH_SUBS, "utf8")
            .then((t) => JSON.parse(t))
            .catch(() => ({}));
          subs[sub.endpoint] = {
            endpoint: sub.endpoint,
            keys: sub.keys,
            userId: sub.userId ?? "",
            userName: sub.userName ?? "",
            tzOffsetMin: Number.isFinite(sub.tzOffsetMin) ? sub.tzOffsetMin : 0,
            updatedAt: new Date().toISOString(),
          };
          await mkdir(path.dirname(PUSH_SUBS), { recursive: true });
          await writeFile(PUSH_SUBS, JSON.stringify(subs, null, 2));
          return jsonOut(res, 200, { ok: true, subscriptions: Object.keys(subs).length });
        } catch {
          return jsonOut(res, 400, { ok: false, error: "bad_json" });
        }
      });
      return;
    }
    if (action === "unsubscribe" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { endpoint } = JSON.parse(body);
          const subs = await readFile(PUSH_SUBS, "utf8")
            .then((t) => JSON.parse(t))
            .catch(() => ({}));
          delete subs[endpoint];
          await mkdir(path.dirname(PUSH_SUBS), { recursive: true });
          await writeFile(PUSH_SUBS, JSON.stringify(subs, null, 2));
          return jsonOut(res, 200, { ok: true });
        } catch {
          return jsonOut(res, 400, { ok: false, error: "bad_json" });
        }
      });
      return;
    }
    if (action === "db" && req.method === "GET") {
      try {
        const raw = await readFile(STORAGE, "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(raw);
      } catch {
        return jsonOut(res, 404, { ok: false, error: "not_found" });
      }
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          JSON.parse(body);
          if (body.length > 2097152) return jsonOut(res, 413, { ok: false, error: "too_large" });
          await mkdir(path.dirname(STORAGE), { recursive: true });
          await writeFile(STORAGE, body);
          return jsonOut(res, 200, { ok: true, bytes: Buffer.byteLength(body) });
        } catch {
          return jsonOut(res, 400, { ok: false, error: "bad_json" });
        }
      });
      return;
    }
    return jsonOut(res, 404, { ok: false, error: "unknown_action" });
  }

  /* ---------------------------------- статика ---------------------------------- */
  try {
    let rel = path.normalize(decodeURIComponent(p)).replace(/^([/\\])+/, "");
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) throw new Error("traversal");
    const st = await stat(file);
    if (st.isDirectory()) file = path.join(file, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    return res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`test server ready: http://127.0.0.1:${PORT}/pwa/`);
});
