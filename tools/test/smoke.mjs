/* Smoke-тест логики PWA на jsdom (без браузера).
   Запуск: npm test
   Проверяет рендер, фильтры, поиск, undo, редактирование, XSS-экранирование
   и регрессии, найденные аудитом: сохранение при переполненном хранилище,
   возврат фокуса, блокировка скролла под шторкой, снятие срока, a11y-атрибуты.
   Плюс новые сценарии: экспорт .json, импорт со слиянием, мягкое удаление
   (надгробия), вход в аккаунт с синхронизацией и PIN-блокировка. */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- окружение ---------- */
/**
 * @param {object} opts
 * @param {string} opts.url            адрес страницы (?debug=1 открывает __pwa-хук)
 * @param {boolean} [opts.subtle]      подменить window.crypto на node:webcrypto (нужен для PIN)
 * @param {Function} [opts.fetch]      стаб fetch для /api/*
 */
function createEnv({ url, subtle = false, fetch: fetchImpl = null }) {
  const problems = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => problems.push('JSDOM_ERROR: ' + (e.message || e)));
  vc.on('error', (...a) => problems.push('CONSOLE_ERROR: ' + a.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url,
    virtualConsole: vc,
  });
  const w = dom.window;
  const d = w.document;

  w.matchMedia = w.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  if (subtle) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  } else if (!w.crypto?.randomUUID) {
    Object.defineProperty(w, 'crypto', { value: { randomUUID: () => 'u' + Math.random().toString(16).slice(2) } });
  }
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.visualViewport = { height: 800, offsetTop: 0, addEventListener() {}, removeEventListener() {} };
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  w.scrollTo = () => {};   // jsdom не реализует scrollTo — нам достаточно отсутствия ошибки

  const store = {};
  const storage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (storage.__throw) throw new w.DOMException('QuotaExceededError'); store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear() { for (const k in store) delete store[k]; },
  };
  Object.defineProperty(w, 'localStorage', { value: storage });
  w.navigator.serviceWorker = { register: () => Promise.resolve({ active: null, addEventListener() {}, installing: null }) };
  let confirmed = true;
  w.confirm = () => confirmed;
  if (fetchImpl) w.fetch = fetchImpl;

  // перехват скачивания файла (экспорт)
  const downloads = [];
  w.URL.createObjectURL = (blob) => { downloads.push({ blob }); return 'blob:stub'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {
    if (this.download) downloads[downloads.length - 1].name = this.download;
  };

  const env = {
    dom, w, d, problems, store, storage, downloads,
    $: (s) => d.querySelector(s),
    $$: (s) => [...d.querySelectorAll(s)],
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    sleep,
    set confirmed(v) { confirmed = v; },
    get confirmed() { return confirmed; },
    /** подменить FileList у #importFile и вызвать change */
    async importJSON(payload) {
      const input = d.querySelector('#importFile');
      const file = { text: async () => JSON.stringify(payload) };
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
      await sleep(40);
    },
    run() { w.eval(appjs); },
    close() { w.close(); },
  };
  env.run();
  return env;
}

/* =======================================================================
   ЧАСТЬ 1: локальный режим (без аккаунта, без сети API, без crypto.subtle)
   ======================================================================= */
const A = createEnv({ url: 'https://example.com/app/' });
const { w, d, $, $$, problems, store, storage, click } = A;
await sleep(60);

/* ---------- 1. старт ---------- */
section('Рендер и стартовое состояние');
ok('нет необработанных ошибок при загрузке', problems.length === 0, problems.join(' | '));
ok('отрисованы 3 demo-строки', $$('#list .row').length === 3);
ok('счётчик в title', d.title === 'Задачи (2)', d.title);
ok('список больше не aria-live (нет озвучки всего списка)', $('#list').getAttribute('aria-live') === null);
ok('есть вежливый регион статуса', $('#liveStatus')?.getAttribute('role') === 'status');
ok('шторка — dialog с aria-modal', $('#sheet').getAttribute('role') === 'dialog' && $('#sheet').getAttribute('aria-modal') === 'true');
ok('тост — role=status', $('#toast').getAttribute('role') === 'status');
ok('галочка — role=switch с aria-checked', $$('#list .check').every((c) => c.getAttribute('role') === 'switch' && c.hasAttribute('aria-checked')));
ok('полоса под статус-бар присутствует', !!$('.statusbar-strip'));
ok('кнопка аккаунта доступна с aria-haspopup', $('#acctBtn')?.getAttribute('aria-haspopup') === 'dialog');

/* ---------- 2. toggle + фокус ---------- */
section('Переключение и возврат фокуса');
const targetRow = $('#list .row');
const targetId = targetRow.dataset.id;
const firstCheck = targetRow.querySelector('.check');
firstCheck.focus();
click(firstCheck);
await sleep(40);
const toggledCheck = $(`#list .row[data-id="${targetId}"] .check`);
ok('aria-checked обновился', toggledCheck.getAttribute('aria-checked') === 'true');
ok('фокус возвращён на галочку после рендера', d.activeElement === toggledCheck, String(d.activeElement?.className));
ok('title пересчитан', d.title === 'Задачи (1)', d.title);

/* ---------- 3. хранилище под нагрузкой ---------- */
section('Сохранение при недоступном хранилище');
storage.__throw = true;
const errsBefore = problems.length;
click($(`#list .row[data-id="${targetId}"] .check`));   // откатываем задачу обратно
await sleep(40);
storage.__throw = false;
ok('нет uncaught-исключений из save()', problems.length === errsBefore, problems.slice(errsBefore).join(' | '));
ok('показан тост об ошибке сохранения', !$('#toast').hidden && /хранилище/i.test($('#toastText').textContent));
ok('состояние не рассинхронизировалось (title не изменился)', d.title === 'Задачи (1)', d.title);

/* ---------- 4. шторка: скролл-лок, Escape, черновик ---------- */
section('Шторка');
click($('#fab'));
await sleep(60);
ok('body.sheet-open блокирует прокрутку', d.body.classList.contains('sheet-open'));
ok('кнопка «убрать срок» скрыта при пустой дате', $('#taskDateClear').hidden === true);
$('#taskTitle').value = 'черновик';
$('#taskDate').value = '2026-11-05';
$('#taskDate').dispatchEvent(new w.Event('input', { bubbles: true }));
await sleep(20);
ok('кнопка «убрать срок» появилась', $('#taskDateClear').hidden === false);
click($('#taskDateClear'));
ok('срок снимается кнопкой', $('#taskDate').value === '' && $('#taskDateClear').hidden === true);
$('#taskDate').value = '2026-11-05';
A.confirmed = false;                       // пользователь отменил закрытие
d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(460);
ok('Escape с черновиком спрашивает подтверждение и не закрывает', $('#sheet').hidden === false);
A.confirmed = true;                        // пользователь согласен потерять черновик
d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(480);
ok('после подтверждения шторка закрыта и скролл разблокирован', $('#sheet').hidden === true && !d.body.classList.contains('sheet-open'));

/* ---------- 5. создание/редактирование/поиск/фильтры ---------- */
section('CRUD, поиск, фильтры');
click($('#fab'));
await sleep(60);
$('#taskTitle').value = 'Купить молоко <img src=x onerror="window.__pwned=1">';
$('#sheet').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(60);
ok('задача добавлена', $$('#list .row').length === 4);
ok('XSS экранирован', !d.querySelector('#list img') && w.__pwned === undefined);

$('#search').value = 'молоко';
$('#search').dispatchEvent(new w.Event('input', { bubbles: true }));
await sleep(200); // дебаунс 120мс
ok('поиск фильтрует (после дебаунса)', $$('#list .row').length === 1);
ok('анонс для скринридера обновлён', /Показано задач: 1/.test($('#liveStatus').textContent), $('#liveStatus').textContent);
$('#search').value = '';
$('#search').dispatchEvent(new w.Event('input', { bubbles: true }));
await sleep(200);

const segs = $$('#segmented .seg');
click(segs[2]);
await sleep(30);
ok('фильтр «Готово» и aria-pressed', segs[2].getAttribute('aria-pressed') === 'true' && $$('#list .row').length >= 1);
click(segs[0]);
await sleep(30);

/* ---------- 6. undo + мягкое удаление ---------- */
section('Undo и надгробия удалений');
const rowsBefore = $$('#list .row').length;
click($('#list .row .row-delete'));
await sleep(40);
ok('строка удалена из видимых', $$('#list .row').length === rowsBefore - 1);
ok('тост предлагает вернуть', !$('#toastAction').hidden);
const deletedInStore = JSON.parse(store['pwa-tasks:v1']).tasks.filter((t) => t.deleted);
ok('удаление записано надгробием (deleted:true)', deletedInStore.length === 1 && typeof deletedInStore[0].updatedAt === 'number');
click($('#toastAction'));
await sleep(40);
ok('undo вернул строку', $$('#list .row').length === rowsBefore);
ok('после undo надгробие снято', JSON.parse(store['pwa-tasks:v1']).tasks.every((t) => !t.deleted));

/* ---------- 7. экспорт .json ---------- */
section('Экспорт в .json');
A.downloads.length = 0;
click($('#exportBtn'));
await sleep(40);
const dl = A.downloads[A.downloads.length - 1];
const name = dl?.name || '';
ok('скачан файл pwa-tasks-ГГГГ-ММ-ДД.json', /^pwa-tasks-\d{4}-\d{2}-\d{2}\.json$/.test(name), name);
const exported = JSON.parse(await dl.blob.text());
ok('в файле app/v2/exportedAt', exported.app === 'pwa-tasks' && exported.v === 2 && !Number.isNaN(Date.parse(exported.exportedAt)));
ok('экспортированы только неудалённые задачи', exported.tasks.length === $$('#list .row').length + 0 || exported.tasks.every((t) => !t.deleted));
ok('в локальном режиме account === null', exported.account === null);

/* ---------- 8. импорт со слиянием (LWW) ---------- */
section('Импорт: слияние вместо затирания');
const current = exported.tasks;
const base = current[0];
const remoteNewer = { ...base, title: 'Обновлено с другого устройства', updatedAt: Date.now() + 60_000 };
const stale = { ...current[1], title: 'Устаревшая копия', updatedAt: 1 };
const fresh = { id: 'imp-1', title: 'Новая из файла', note: '', due: '', prio: 0, done: false, deleted: false, createdAt: Date.now(), completedAt: null, updatedAt: Date.now() };
await A.importJSON({ app: 'pwa-tasks', v: 2, tasks: [remoteNewer, stale, fresh] });
const merged = JSON.parse(store['pwa-tasks:v1']).tasks;
const byId = (id) => merged.find((t) => t.id === id);
ok('более свежая версия победила', byId(base.id).title === 'Обновлено с другого устройства', byId(base.id).title);
ok('устаревшая версия не перезаписала локальную', byId(current[1].id).title !== 'Устаревшая копия');
ok('новая задача из файла добавлена', !!byId('imp-1'));
ok('импорт не удалил остальные задачи', merged.length >= current.length + 1, `${merged.length} vs ${current.length}`);

/* ---------- 9. персистентность ---------- */
section('Персистентность');
const raw = JSON.parse(store['pwa-tasks:v1']);
ok('схема хранит версию', raw.v === 2);
ok('задачи валидны нормализатором', raw.tasks.every((t) => t.id && typeof t.title === 'string'));
ok('у каждой задачи есть updatedAt для синхронизации', raw.tasks.every((t) => typeof t.updatedAt === 'number' && t.updatedAt > 0));

/* =======================================================================
   ЧАСТЬ 2: аккаунт, синхронизация, PIN (crypto.subtle + стаб fetch)
   ======================================================================= */
section('\nАккаунт, синхронизация, PIN');
const REMOTE_ID = 'remote-1';
const apiCalls = [];
let serverNow = Date.now();
const remoteTask = {
  id: REMOTE_ID, title: 'Задача со второго устройства', note: '', due: '', prio: 1,
  done: false, deleted: false, createdAt: serverNow, completedAt: null, updatedAt: serverNow,
};
const fetchStub = async (url, opts = {}) => {
  apiCalls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
  const json = (data, status = 200) => ({
    ok: status < 400, status, json: async () => data,
  });
  const route = new URL(String(url), 'https://local').pathname;
  if (route === '/api/health') return json({ ok: true, name: 'pwa-tasks', version: '1.2.0' });
  url = route;
  if (url === '/api/login' || url === '/api/register') {
    return json({ token: 'tok-123', user: { id: 'u1', email: 'anna@example.com' } });
  }
  if (url === '/api/me') return json({ user: { id: 'u1', email: 'anna@example.com' } });
  if (url === '/api/logout') return json({ ok: true });
  if (url === '/api/tasks') {
    serverNow = Date.now();
    const body = opts.body ? JSON.parse(opts.body) : {};
    // сервер отвечает задачами, изменёнными после since: отдаём удалённую задачу
    return json({ serverNow, tasks: body.since ? [remoteTask] : [remoteTask] });
  }
  return json({ error: 'not found' }, 404);
};

const B = createEnv({ url: 'https://example.com/app/?debug=1', subtle: true, fetch: fetchStub });
await sleep(60);
const b$ = B.$, b$$ = B.$$;

ok('нет ошибок при загрузке с debug-хуком', B.problems.length === 0, B.problems.join(' | '));
ok('debug-хук __pwa доступен', !!B.w.__pwa && typeof B.w.__pwa.mergeTasks === 'function');
ok('mergeTasks: побеждает больший updatedAt',
  B.w.__pwa.mergeTasks(
    [{ id: 'x', updatedAt: 10, title: 'старая' }],
    [{ id: 'x', updatedAt: 20, title: 'новая' }],
  )[0].title === 'новая');
ok('mergeTasks: локальная свежее — остаётся',
  B.w.__pwa.mergeTasks(
    [{ id: 'y', updatedAt: 30, title: 'локальная' }],
    [{ id: 'y', updatedAt: 5, title: 'серверная' }],
  )[0].title === 'локальная');

// --- вход с переносом локальных задач ---
B.click(b$('#acctBtn'));
await sleep(80);
ok('шторка аккаунта открыта (dialog)', !b$('#acctSheet').hidden && b$('#acctSheet').getAttribute('role') === 'dialog');
ok('анонимный блок виден, авторизованный скрыт', !b$('#acctAnon').hidden && b$('#acctIn').hidden);
ok('состояние сервера показано (role=status)', b$('#serverState').getAttribute('role') === 'status' && /отвечает/.test(b$('#serverState').textContent), b$('#serverState').textContent);
ok('health отмечен как успешный', b$('#serverState').className.includes('ok'), b$('#serverState').className);

// адрес отдельного сервера: сохраняется, нормализуется, сбрасывается
b$('#apiBase').value = 'https://tasks.example.org/';
B.click(b$('#apiBaseSave'));
await sleep(100);
ok('адрес API сохранён без хвостового слэша', B.store['pwa-tasks:api-base'] === 'https://tasks.example.org', B.store['pwa-tasks:api-base']);
ok('health запрошен по внешнему адресу', apiCalls.some((c) => String(c.url).startsWith('https://tasks.example.org/api/health')), JSON.stringify(apiCalls.map((c) => c.url)));
B.click(b$('#apiBaseReset'));
await sleep(100);
ok('сброс вернул свой origin', !B.store['pwa-tasks:api-base']);

// API недоступен (статический хостинг / сервер упал) — причина видна пользователю
const goodFetch = B.w.fetch;
B.w.fetch = async () => { throw new TypeError('Failed to fetch'); };
B.click(b$('#authRegister'));
await sleep(40);
b$('#authEmail').value = 'x@y.zz';
b$('#authPassword').value = 'password123';
b$('#authFields').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(150);
const failMsg = b$('#authError').textContent;
ok('при сбое сети показана конкретная причина', !b$('#authError').hidden && /Не удалось связаться с сервером/i.test(failMsg), failMsg);
ok('индикатор сервера переключился в ошибку', b$('#serverState').className.includes('bad'), b$('#serverState').className);
ok('аккаунт не создан, задачи не тронуты', !B.store['pwa-tasks:account'] && B.w.__pwa.state.tasks.length === 3);
B.w.fetch = goodFetch;
await B.w.__pwa.probeServer?.() || sleep(0);

B.click(b$('#authLogin'));
await sleep(60);
ok('форма входа раскрыта', !b$('#authFields').hidden && b$('#authModeTitle').textContent === 'Вход');
b$('#authEmail').value = 'Anna@Example.com';
b$('#authPassword').value = 'supersecret1';
// локальное хранилище появляется после первой записи — переключаем задачу
B.click(b$('#list .row .check'));
await sleep(40);
const localBefore = B.w.__pwa.state.tasks.length;
b$('#authFields').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(120);
ok('аккаунт сохранён в localStorage', JSON.parse(B.store['pwa-tasks:account'] || 'null')?.token === 'tok-123');
const acctTasks = JSON.parse(B.store['pwa-tasks:v2:u1'] || '{}').tasks || [];
const localIds = new Set(JSON.parse(B.store['pwa-tasks:v1']).tasks.map((t) => t.id));
ok('задачи перенесены в хранилище аккаунта', acctTasks.length >= localBefore && [...localIds].every((id) => acctTasks.some((t) => t.id === id)), `${acctTasks.length} vs ${localBefore}`);
ok('локальное хранилище не очищено (можно выйти обратно)', JSON.parse(B.store['pwa-tasks:v1']).tasks.length === localBefore);
ok('чип аккаунта показывает инициалы', b$('#acctInitials').textContent === 'AN', b$('#acctInitials').textContent);
ok('в тосте подтверждён вход', /Вход выполнен/.test(b$('#toastText').textContent), b$('#toastText').textContent);

// --- синхронизация ---
apiCalls.length = 0;
await B.w.__pwa.syncNow();
await sleep(40);
const push = apiCalls.find((c) => c.url === '/api/tasks' && c.method === 'POST');
ok('push идёт с Bearer-токеном', push?.headers?.Authorization === 'Bearer tok-123', JSON.stringify(push?.headers));
ok('push отправляет задачи аккаунта', !!push && JSON.parse(push.body).tasks.length >= localBefore);
ok('после синхронизации подтянута задача с сервера',
  B.w.__pwa.state.tasks.some((t) => t.id === REMOTE_ID),
  `${B.w.__pwa.state.tasks.length} задач`);
ok('подтянутая задача отрисована в списке', b$$('#list .row').length === localBefore + 1, `${b$$('#list .row').length} строк`);
ok('курсор since сохранён', Number(B.store['pwa-tasks:pull:u1']) > 0, B.store['pwa-tasks:pull:u1']);
ok('индикатор синхронизации — ok', b$('#acctDot').className.includes('ok'), b$('#acctDot').className);

// --- PIN ---
B.click(b$('#acctBtn'));
await sleep(60);
ok('в аккаунте видно e-mail', b$('#acctEmail').textContent === 'anna@example.com', b$('#acctEmail').textContent);
ok('кнопка PIN доступна (есть crypto.subtle)', !b$('#pinSetBtn').hidden);
B.click(b$('#pinSetBtn'));
await sleep(60);
b$('#pinInput').value = '2468';
b$('#pinRepeat').value = '1357';
b$('#pinSheet').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(120);
ok('несовпавший PIN отклонён', !b$('#pinError').hidden && /не совпадает/i.test(b$('#pinError').textContent));
b$('#pinRepeat').value = '2468';
b$('#pinSheet').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(600);
const pinRec = JSON.parse(B.store['pwa-tasks:pin:u1'] || 'null');
ok('PIN сохранён хэшем с солью (не в открытом виде)', !!pinRec && !!pinRec.salt && /^[0-9a-f]{64}$/.test(pinRec.hash));
ok('в хранилище нет открытого PIN', !JSON.stringify(B.store).includes('"2468"'));
ok('шторка PIN закрыта', b$('#pinSheet').hidden === true);
B.click(b$('#lockBtn'));
await sleep(520);
ok('экран блокировки показан', !b$('#lockOverlay').hidden && b$('#lockOverlay').getAttribute('aria-modal') === 'true');
b$('#lockPin').value = '9999';
b$('#lockOverlay').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(250);
ok('неверный PIN не пускает', !b$('#lockOverlay').hidden && /Неверный PIN/.test(b$('#lockError').textContent));
b$('#lockPin').value = '2468';
b$('#lockOverlay').dispatchEvent(new B.w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(300);
ok('верный PIN разблокировал приложение', b$('#lockOverlay').hidden === true);

// --- экспорт из-под аккаунта ---
B.downloads.length = 0;
B.click(b$('#exportBtn'));
await sleep(40);
const bExport = JSON.parse(await B.downloads[B.downloads.length - 1].blob.text());
ok('экспорт из аккаунта помечен e-mail', bExport.account === 'anna@example.com', String(bExport.account));
ok('экспорт содержит синхронизированные задачи', bExport.tasks.some((t) => t.id === REMOTE_ID));

// --- выход ---
B.click(b$('#acctBtn'));
await sleep(60);
B.click(b$('#logoutBtn'));
await sleep(600);
ok('после выхода аккаунт удалён', !B.store['pwa-tasks:account']);
ok('после выхода видны локальные задачи', JSON.parse(B.store['pwa-tasks:v1']).tasks.length > 0);
ok('чип аккаунта вернулся в анонимное состояние', b$('#acctInitials').textContent === '•');

/* =======================================================================
   ЧАСТЬ 3: статический хостинг (GitHub Pages) — API нет вовсе
   ======================================================================= */
section('\nСтатический хостинг: локальный режим');
const staticFetch = async (url) => {
  const route = new URL(String(url), 'https://local').pathname;
  if (route.startsWith('/api/')) {
    return { ok: false, status: 404, json: async () => { throw new Error('not json'); }, text: async () => '<html>404</html>' };
  }
  throw new TypeError('статика в тесте не отдаётся');
};
const C = createEnv({ url: 'https://user.github.io/pwa/', fetch: staticFetch });
await sleep(200);
const c$ = C.$;
ok('нет ошибок при загрузке на статике', C.problems.length === 0, C.problems.join(' | '));
ok('зонд понял, что API нет (404/HTML)', /Локальный режим/.test(c$('#serverState').textContent), c$('#serverState').textContent);
ok('задачи работают без сервера', C.$$('#list .row').length === 3);
C.click(c$('#acctBtn'));
await sleep(150);
ok('кнопки «Войти»/«Создать аккаунт» скрыты', c$('#authButtons').hidden === true);
ok('вместо них — объяснение про локальный режим', c$('#localOnlyNote').hidden === false && /Экспорт \.json/.test(c$('#localOnlyNote').textContent));
ok('точка синхронизации не пугает красным', !c$('#acctDot').className.includes('error'), c$('#acctDot').className);
ok('адрес внешнего API всё ещё можно задать', !!c$('#apiBase') && c$('#apiBase').closest('details') !== null);
C.downloads.length = 0;
C.click(c$('#exportBtn'));
await sleep(60);
ok('экспорт .json работает без сервера', /^pwa-tasks-\d{4}-\d{2}-\d{2}\.json$/.test(C.downloads[C.downloads.length - 1]?.name || ''), C.downloads[C.downloads.length - 1]?.name);
ok('аккаунт не появился', !C.store['pwa-tasks:account']);
C.close();

/* ---------- итог ---------- */
console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
const allProblems = [...problems, ...B.problems];
if (allProblems.length) { console.log('Необработанные ошибки окружения:'); console.log(allProblems.join('\n')); }
w.close();               // гасим таймеры приложения, чтобы процесс завершился
B.close();
process.exit(failed || allProblems.length ? 1 : 0);
