/* Smoke-тест логики PWA на jsdom (без браузера).
   Запуск: npm test
   Проверяет рендер, фильтры, поиск, undo, редактирование, XSS-экранирование
   и регрессии, найденные аудитом: сохранение при переполненном хранилище,
   возврат фокуса, блокировка скролла под шторкой, снятие срока, a11y-атрибуты. */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/* ---------- окружение ---------- */
const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('JSDOM_ERROR: ' + (e.message || e)));
vc.on('error', (...a) => problems.push('CONSOLE_ERROR: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://example.com/app/',
  virtualConsole: vc,
});
const w = dom.window;
const d = w.document;
const $ = (s) => d.querySelector(s);
const $$ = (s) => [...d.querySelectorAll(s)];

w.matchMedia = w.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
if (!w.crypto?.randomUUID) {
  Object.defineProperty(w, 'crypto', { value: { randomUUID: () => 'u' + Math.random().toString(16).slice(2) } });
}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

w.eval(appjs);
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
confirmed = false;                       // пользователь отменил закрытие
d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(460);
ok('Escape с черновиком спрашивает подтверждение и не закрывает', $('#sheet').hidden === false);
confirmed = true;                        // пользователь согласен потерять черновик
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

/* ---------- 6. undo ---------- */
section('Undo после удаления');
const rowsBefore = $$('#list .row').length;
click($('#list .row .row-delete'));
await sleep(40);
ok('строка удалена', $$('#list .row').length === rowsBefore - 1);
ok('тост предлагает вернуть', !$('#toastAction').hidden);
click($('#toastAction'));
await sleep(40);
ok('undo вернул строку', $$('#list .row').length === rowsBefore);

/* ---------- 7. персистентность ---------- */
section('Персистентность');
const raw = JSON.parse(store['pwa-tasks:v1']);
ok('схема хранит версию', raw.v === 2);
ok('задачи валидны нормализатором', raw.tasks.every((t) => t.id && typeof t.title === 'string'));

/* ---------- итог ---------- */
console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
if (problems.length) { console.log('Необработанные ошибки окружения:'); console.log(problems.join('\n')); }
w.close();               // гасим таймеры приложения, чтобы процесс завершился
process.exit(failed || problems.length ? 1 : 0);
