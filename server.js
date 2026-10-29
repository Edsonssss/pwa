/* Задачи — PWA + синхронизация. Единый сервер без зависимостей:
   отдаёт статику PWA и JSON API аккаунтов (/api/*) с того же origin.

   Запуск:  node server.js [порт]      (по умолчанию 8080, слушает 0.0.0.0)
   Данные:  каталог data/ (JSON-файлы), задаётся через DATA_DIR.
   В бою ставится за TLS-терминирующий прокси (хостинг даёт HTTPS из коробки).

   Модель синхронизации: last-write-wins по updatedAt на каждую задачу,
   удаления — надгробиями (deleted:true), тянем изменения через ?since=<ms>. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const VERSION = '1.3.0';
/* Разрешённые origin для кросс-доменного API (статика на Pages/Netlify, сервер отдельно):
   ALLOWED_ORIGINS="https://user.github.io,https://app.netlify.app"  (или "*" — любой).
   Пусто = только тот же origin, с которого отдан сайт. */
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------------- хранилище ---------------- */
fs.mkdirSync(path.join(DATA_DIR, 'tasks'), { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const DB = {
  usersFile: path.join(DATA_DIR, 'users.json'),
  tokensFile: path.join(DATA_DIR, 'tokens.json'),
  users: null,
  tokens: null,
  load() {
    this.users = readJSON(this.usersFile, {});
    this.tokens = readJSON(this.tokensFile, {});
    const now = Date.now();
    let dirty = false;
    for (const [t, v] of Object.entries(this.tokens)) if (!v || v.expires < now) { delete this.tokens[t]; dirty = true; }
    if (dirty) writeJSON(this.tokensFile, this.tokens);
  },
  saveUsers() { writeJSON(this.usersFile, this.users); },
  saveTokens() { writeJSON(this.tokensFile, this.tokens); },
  tasksFile(uid) { return path.join(DATA_DIR, 'tasks', uid + '.json'); },
  loadTasks(uid) {
    const raw = readJSON(this.tasksFile(uid), { tasks: [] });
    return Array.isArray(raw.tasks) ? raw.tasks : [];
  },
  saveTasks(uid, tasks) { writeJSON(this.tasksFile(uid), { tasks }); },
};
DB.load();

/* ---------------- примитивы безопасности ---------------- */
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = rate.get(ip);
  if (!rec || rec.reset < now) { rate.set(ip, { count: 1, reset: now + 60000 }); return false; }
  rec.count += 1;
  return rec.count > 30; // 30 попыток входа/регистрации в минуту с адреса
}

function issueToken(userId) {
  const token = newToken();
  DB.tokens[token] = { userId, expires: Date.now() + TOKEN_TTL_MS };
  DB.saveTokens();
  return token;
}
const userById = (id) => Object.values(DB.users).find((u) => u.id === id) || null;
function authUser(req) {
  const m = /Bearer\s+([\w.-]+)/.exec(req.headers.authorization || '');
  if (!m) return null;
  const rec = DB.tokens[m[1]];
  if (!rec || rec.expires < Date.now()) return null;
  const user = userById(rec.userId);
  return user ? { token: m[1], user } : null;
}

/* ---------------- валидация задачи (зеркалит клиент) ---------------- */
function sanitizeTask(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id || typeof t.title !== 'string') return null;
  return {
    id: t.id.slice(0, 64),
    title: t.title.slice(0, 140),
    note: typeof t.note === 'string' ? t.note.slice(0, 500) : '',
    due: typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
    prio: [0, 1, 2].includes(t.prio) ? t.prio : 0,
    done: !!t.done,
    deleted: !!t.deleted,
    createdAt: Number(t.createdAt) || Date.now(),
    completedAt: Number(t.completedAt) || null,
    updatedAt: Number(t.updatedAt) || Date.now(),
  };
}

/* ---------------- API ---------------- */
function send(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

/* CORS: только явно разрешённые origin (echo + Vary), иначе заголовков нет вовсе. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.length) return false;
  if (!(ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

async function handleAPI(req, res, url) {
  const ip = req.socket.remoteAddress || '?';
  const route = url.pathname;

  // публичная проверка доступности: по ней клиент отличает «нет API на этом
  // хостинге» от «нет сети» и показывает внятную ошибку вместо общей фразы
  if (route === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, name: 'pwa-tasks', version: VERSION, time: Date.now() });
  }

  if (route === '/api/register' || route === '/api/login') {
    if (rateLimited(ip)) return send(res, 429, { error: 'Слишком много попыток, подождите минуту' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Некорректный JSON' }); }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Некорректный e-mail' });
    if (password.length < 8) return send(res, 400, { error: 'Пароль минимум 8 символов' });

    if (route === '/api/register') {
      if (DB.users[email]) return send(res, 409, { error: 'Такой аккаунт уже есть' });
      const salt = newSalt();
      DB.users[email] = { id: crypto.randomUUID(), email, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
      DB.saveUsers();
      return send(res, 201, { token: issueToken(DB.users[email].id), user: { id: DB.users[email].id, email } });
    }
    const u = DB.users[email];
    if (!u || !safeEqual(u.hash, hashPassword(password, u.salt))) return send(res, 401, { error: 'Неверный e-mail или пароль' });
    return send(res, 200, { token: issueToken(u.id), user: { id: u.id, email: u.email } });
  }

  // дальше — только авторизованные
  const auth = authUser(req);
  if (!auth) return send(res, 401, { error: 'Нужен вход' });
  const uid = auth.user.id;

  if (route === '/api/me' && req.method === 'GET') {
    return send(res, 200, { user: { id: uid, email: auth.user.email } });
  }
  if (route === '/api/logout' && req.method === 'POST') {
    delete DB.tokens[auth.token];
    DB.saveTokens();
    return send(res, 200, { ok: true });
  }
  if (route === '/api/tasks' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const tasks = DB.loadTasks(uid).filter((t) => t.updatedAt > since);
    return send(res, 200, { serverNow: Date.now(), tasks });
  }
  if (route === '/api/tasks' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Некорректный JSON' }); }
    const since = Number(body.since || 0);
    const incoming = Array.isArray(body.tasks) ? body.tasks.map(sanitizeTask).filter(Boolean) : [];
    if (incoming.length > 5000) return send(res, 413, { error: 'Слишком много задач за раз' });

    const server = DB.loadTasks(uid);
    const byId = new Map(server.map((t) => [t.id, t]));
    for (const t of incoming) {
      const cur = byId.get(t.id);
      if (!cur || t.updatedAt > cur.updatedAt) byId.set(t.id, t); // last-write-wins
    }
    // чистим старые надгробия
    const now = Date.now();
    const merged = [...byId.values()].filter((t) => !(t.deleted && now - t.updatedAt > TOMBSTONE_TTL_MS));
    DB.saveTasks(uid, merged);
    return send(res, 200, { serverNow: now, tasks: merged.filter((t) => t.updatedAt > since) });
  }
  return send(res, 404, { error: 'not found' });
}

/* ---------------- статика ---------------- */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // connect-src: свой origin + разрешённые адреса API (кросс-доменный режим)
  "connect-src 'self'" + ALLOWED_ORIGINS.filter((o) => o !== '*').map((o) => ' ' + o).join(''),
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function serveStatic(req, res, urlPath) {
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  if (urlPath.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === 'data')) {
    res.writeHead(404).end('404');
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.basename(file) === 'sw.js' ? 'no-cache' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }  // preflight
    handleAPI(req, res, url).catch(() => send(res, 500, { error: 'Внутренняя ошибка' }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('405'); return; }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PWA + API v${VERSION}: http://localhost:${PORT}/  (данные: ${DATA_DIR})`);
  if (ALLOWED_ORIGINS.length) console.log(`CORS разрешён для: ${ALLOWED_ORIGINS.join(', ')}`);
});
