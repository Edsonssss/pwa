/* Интеграционный тест API синхронизации (без зависимостей).
   Запуск: npm run test:api   (или: node tools/test/api.mjs)
   Поднимает server.js на свободном порту с временным DATA_DIR и проверяет:
   регистрацию/вход/выход, изоляцию данных между пользователями,
   last-write-wins, надгробия удалений, since-выборку, статику с CSP. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8123 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-api-'));

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
  env: { ...process.env, DATA_DIR: DATA, ALLOWED_ORIGINS: 'https://allowed.example.org' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const base = `http://127.0.0.1:${PORT}`;
const api = (p, opts = {}, token) => fetch(base + p, {
  ...opts,
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers || {}),
  },
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base + '/api/me'); if (r.status === 401 || r.status === 200) return; } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('сервер не поднялся: ' + logs);
}

try {
  await waitForServer();

  console.log('\nДоступность и CORS');
  const health = await api('/api/health');
  ok('health публичный: 200 + ok:true + версия', health.status === 200 && health.body.ok === true && /^\d+\.\d+/.test(health.body.version || ''), JSON.stringify(health.body));
  const pre = await fetch(base + '/api/tasks', {
    method: 'OPTIONS',
    headers: { Origin: 'https://allowed.example.org', 'Access-Control-Request-Method': 'POST' },
  });
  ok('preflight разрешённого origin: 204 + Allow-Origin', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://allowed.example.org', String(pre.headers.get('access-control-allow-origin')));
  ok('preflight отдаёт Allow-Headers с Authorization', (pre.headers.get('access-control-allow-headers') || '').includes('Authorization'));
  const preBad = await fetch(base + '/api/tasks', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  ok('чужому origin CORS-заголовков нет', !preBad.headers.get('access-control-allow-origin'), String(preBad.headers.get('access-control-allow-origin')));
  const healthCors = await fetch(base + '/api/health', { headers: { Origin: 'https://allowed.example.org' } });
  ok('обычный запрос с разрешённым origin получает Allow-Origin', healthCors.headers.get('access-control-allow-origin') === 'https://allowed.example.org');

  console.log('\nРегистрация и вход');
  const regA = await api('/api/register', { method: 'POST', body: JSON.stringify({ email: 'A@Example.com ', password: 'password-a1' }) });
  ok('регистрация A: 201 + токен', regA.status === 201 && !!regA.body.token, JSON.stringify(regA.body));
  ok('e-mail нормализован', regA.body.user?.email === 'a@example.com', regA.body.user?.email);
  const dup = await api('/api/register', { method: 'POST', body: JSON.stringify({ email: 'a@example.com', password: 'password-a1' }) });
  ok('повторная регистрация: 409', dup.status === 409);
  const weak = await api('/api/register', { method: 'POST', body: JSON.stringify({ email: 'c@example.com', password: 'short' }) });
  ok('короткий пароль: 400', weak.status === 400);
  const badLogin = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@example.com', password: 'wrong-pass-1' }) });
  ok('неверный пароль: 401', badLogin.status === 401);
  const loginA = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@example.com', password: 'password-a1' }) });
  ok('вход A: 200 + токен', loginA.status === 200 && !!loginA.body.token);
  const regB = await api('/api/register', { method: 'POST', body: JSON.stringify({ email: 'b@example.com', password: 'password-b2' }) });
  ok('регистрация B: 201', regB.status === 201);
  const tA = loginA.body.token, tB = regB.body.token;

  console.log('\nИзоляция данных');
  const NOW = Date.now();
  const mk = (id, title, at, extra = {}) => ({ id, title, note: '', due: '', prio: 0, done: false, deleted: false, createdAt: at, completedAt: null, updatedAt: at, ...extra });
  const pushA1 = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ since: 0, tasks: [mk('a1', 'Задача A1', NOW - 4000), mk('a2', 'Задача A2', NOW - 3000)] }) }, tA);
  ok('A пушит 2 задачи', pushA1.status === 200);
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ since: 0, tasks: [mk('b1', 'Задача B1', NOW - 3500)] }) }, tB);
  const getA = await api('/api/tasks?since=0', {}, tA);
  const getB = await api('/api/tasks?since=0', {}, tB);
  ok('A видит только свои 2', getA.body.tasks.length === 2 && getA.body.tasks.every((t) => t.id.startsWith('a')), JSON.stringify(getA.body.tasks.map((t) => t.id)));
  ok('B видит только свою 1', getB.body.tasks.length === 1 && getB.body.tasks[0].id === 'b1');
  const noAuth = await api('/api/tasks?since=0');
  ok('без токена: 401', noAuth.status === 401);

  console.log('\nLast-write-wins и надгробия');
  const lwwOld = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ since: 0, tasks: [mk('a1', 'УСТАРЕВШАЯ версия', NOW - 5000)] }) }, tA);
  ok('старая версия не перетирает', lwwOld.body.tasks.find((t) => t.id === 'a1')?.title === 'Задача A1');
  const lwwNew = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ since: 0, tasks: [mk('a1', 'Свежая версия', NOW - 2000)] }) }, tA);
  ok('свежая версия побеждает', lwwNew.body.tasks.find((t) => t.id === 'a1')?.title === 'Свежая версия');
  const del = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ since: 0, tasks: [mk('a2', 'Задача A2', NOW - 1000, { deleted: true })] }) }, tA);
  ok('удаление приходит надгробием', del.body.tasks.find((t) => t.id === 'a2')?.deleted === true);

  console.log('\nВыборка since');
  const sinceCut = await api(`/api/tasks?since=${NOW - 1500}`, {}, tA);
  ok('since отсекает старое', sinceCut.body.tasks.length === 1 && sinceCut.body.tasks[0].id === 'a2', JSON.stringify(sinceCut.body.tasks.map((t) => [t.id, t.updatedAt])));

  console.log('\nСанитизация входа');
  const dirty = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ since: 0, tasks: [{ id: 'x1', title: '<img src=x onerror="alert(1)">'.repeat(20), note: 123, prio: 99, due: 'не-дата', updatedAt: NOW - 500 }] }) }, tA);
  const x = dirty.body.tasks.find((t) => t.id === 'x1');
  ok('title обрезан до 140', x && x.title.length === 140);
  ok('prio приведён к 0', x?.prio === 0);
  ok('due приведён к пустой строке', x?.due === '');
  ok('note приведён к строке', typeof x?.note === 'string');

  console.log('\nВыход и статика');
  const out = await api('/api/logout', { method: 'POST' }, tA);
  ok('logout: 200', out.status === 200);
  const after = await api('/api/tasks?since=0', {}, tA);
  ok('после logout токен мёртв: 401', after.status === 401);
  const page = await fetch(base + '/');
  ok('статика отдаёт index.html', page.status === 200 && (await page.text()).includes('statusbar-strip'));
  ok('CSP заголовок на месте', (page.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  const secret = await fetch(base + '/data/users.json');
  ok('data/ не отдаётся наружу', secret.status === 404);
} finally {
  child.kill('SIGTERM');
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
