/**
 * Ежедневник PWA — запасной сервер синхронизации на Cloudflare Workers.
 *
 * Используйте его ТОЛЬКО если приложение размещено на хостинге без PHP
 * (например, GitHub Pages). Когда приложение лежит на ediai.ru вместе с
 * api.php — этот воркер не нужен.
 *
 * Протокол тот же, что у api.php:
 *   GET  ?action=status  → {"ok":true,...}
 *   GET  ?action=db      → JSON-данные или 404
 *   POST (тело = JSON)   → {"ok":true,...}
 * Ключ — в заголовке X-Sync-Key.
 *
 * Настройка (dash.cloudflare.com → Workers & Pages → Create Worker):
 *   1. Вставьте этот код, Save and Deploy.
 *   2. Settings → Variables and Secrets — добавьте:
 *        SYNC_KEY      = 5e254577c0cffc3536b691c9368b46ed   (Encrypt)
 *        GH_TOKEN      = токен GitHub с правом Contents: Read and write
 *                        на репозиторий данных              (Encrypt)
 *        GH_OWNER      = Edsonssss
 *        GH_REPO       = pwa-data          (приватный репозиторий с данными)
 *        GH_BRANCH     = main
 *        GH_PATH       = data/db.json
 *        ALLOW_ORIGIN  = https://ediai.ru  (адрес сайта приложения)
 *   3. URL вида https://<имя>.<аккаунт>.workers.dev вшить в сборку приложения
 *      (NEXT_PUBLIC_SYNC_URL) или указать в настройках приложения.
 */

const API_ROOT = "https://api.github.com";

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

function corsFor(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOW_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
    "Access-Control-Max-Age": "600",
    "X-Robots-Tag": "noindex, nofollow",
  };
  if (origin && (allowed.length === 0 || allowed.includes(origin))) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Vary"] = "Origin";
  }
  return h;
}

let env = null; // присваивается в fetch

function ghHeaders() {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ezhednik-sync-worker",
  };
}

function contentsUrl() {
  const path = (env.GH_PATH || "data/db.json")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const ref = encodeURIComponent(env.GH_BRANCH || "main");
  return `${API_ROOT}/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(
    env.GH_REPO
  )}/contents/${path}?ref=${ref}`;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function ghGetDb(cors) {
  const res = await fetch(contentsUrl(), { headers: ghHeaders() });
  if (res.status === 404) return json({ ok: false, error: "not_found" }, 404, cors);
  if (!res.ok) return json({ ok: false, error: `github_http_${res.status}` }, 502, cors);
  const j = await res.json();
  if (j.encoding !== "base64" || typeof j.content !== "string") {
    return json({ ok: false, error: "bad_encoding" }, 500, cors);
  }
  const text = atob(j.content.replace(/\s/g, ""));
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

async function ghPutDb(text, cors) {
  const headers = ghHeaders();
  const body = utf8ToBase64(text);
  let commit = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await fetch(contentsUrl(), { headers });
    let sha;
    if (head.status === 404) sha = undefined;
    else if (!head.ok) return json({ ok: false, error: `github_http_${head.status}` }, 502, cors);
    else sha = (await head.json()).sha;

    const put = await fetch(contentsUrl(), {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Ежедневник: синхронизация данных (${new Date().toISOString()})`,
        content: body,
        branch: env.GH_BRANCH || "main",
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.ok) {
      const j = await put.json().catch(() => null);
      commit = (j && j.commit && j.commit.sha) || "";
      return json({ ok: true, commit }, 200, cors);
    }
    if (put.status !== 409) {
      return json({ ok: false, error: `github_http_${put.status}` }, 502, cors);
    }
    // 409 — файл изменился, пробуем ещё раз со свежим sha
  }
  return json({ ok: false, error: "conflict" }, 409, cors);
}

export default {
  async fetch(request, requestEnv) {
    env = requestEnv;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsFor(request) });
    }
    const cors = corsFor(request);

    const key = request.headers.get("X-Sync-Key") || url.searchParams.get("key") || "";
    if (!env.SYNC_KEY || key !== env.SYNC_KEY) {
      return json({ ok: false, error: "bad_key" }, 403, cors);
    }
    if (!env.GH_TOKEN || !env.GH_OWNER || !env.GH_REPO) {
      return json({ ok: false, error: "not_configured" }, 500, cors);
    }

    const action = url.searchParams.get("action") || "";

    if (action === "status") {
      return json({ ok: true, app: "ezhednik", backend: "cloudflare-worker" }, 200, cors);
    }
    if (action === "db" && request.method === "GET") {
      return ghGetDb(cors);
    }
    if (action === "" && request.method === "POST") {
      const text = await request.text();
      if (!text.trim()) return json({ ok: false, error: "empty_body" }, 400, cors);
      try {
        JSON.parse(text);
      } catch {
        return json({ ok: false, error: "bad_json" }, 400, cors);
      }
      return ghPutDb(text, cors);
    }

    return json({ ok: false, error: "unknown_action" }, 404, cors);
  },
};
