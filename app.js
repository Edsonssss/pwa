/* Задачи — PWA. Логика без зависимостей.
   Режимы: локальный (без аккаунта, офлайн) и аккаунт с синхронизацией через /api.
   Синхронизация: last-write-wins по updatedAt, удаления — надгробиями (deleted). */
(() => {
  'use strict';

  const LOCAL_STORE_KEY = 'pwa-tasks:v1';
  const ACCOUNT_KEY = 'pwa-tasks:account';
  const API_BASE_KEY = 'pwa-tasks:api-base';
  const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
  const $ = (s) => document.querySelector(s);

  const els = {
    list: $('#list'),
    empty: $('#empty'),
    emptyText: $('#emptyText'),
    search: $('#search'),
    segmented: $('#segmented'),
    segThumb: $('#segThumb'),
    fab: $('#fab'),
    sheet: $('#sheet'),
    backdrop: $('#backdrop'),
    sheetTitle: $('#sheetTitle'),
    sheetCancel: $('#sheetCancel'),
    sheetDelete: $('#sheetDelete'),
    taskTitle: $('#taskTitle'),
    taskNote: $('#taskNote'),
    taskDate: $('#taskDate'),
    taskDateClear: $('#taskDateClear'),
    prioSeg: $('#prioSeg'),
    installCard: $('#installCard'),
    installBtn: $('#installBtn'),
    installClose: $('#installClose'),
    installDesc: $('#installDesc'),
    offlinePill: $('#offlinePill'),
    swHint: $('#swHint'),
    storageBanner: $('#storageBanner'),
    storageBannerClose: $('#storageBannerClose'),
    exportBtn: $('#exportBtn'),
    shareBtn: $('#shareBtn'),
    importBtn: $('#importBtn'),
    importFile: $('#importFile'),
    toast: $('#toast'),
    toastText: $('#toastText'),
    toastAction: $('#toastAction'),
    liveStatus: $('#liveStatus'),
    acctBtn: $('#acctBtn'),
    acctInitials: $('#acctInitials'),
    acctDot: $('#acctDot'),
    acctSheet: $('#acctSheet'),
    acctClose: $('#acctClose'),
    acctAnon: $('#acctAnon'),
    acctIn: $('#acctIn'),
    acctEmail: $('#acctEmail'),
    acctSyncState: $('#acctSyncState'),
    authFields: $('#authFields'),
    authModeTitle: $('#authModeTitle'),
    authEmail: $('#authEmail'),
    authPassword: $('#authPassword'),
    authMigrate: $('#authMigrate'),
    authError: $('#authError'),
    authSubmit: $('#authSubmit'),
    authCancel: $('#authCancel'),
    serverState: $('#serverState'),
    apiBase: $('#apiBase'),
    apiBaseSave: $('#apiBaseSave'),
    apiBaseReset: $('#apiBaseReset'),
    syncNowBtn: $('#syncNowBtn'),
    pinSetBtn: $('#pinSetBtn'),
    lockBtn: $('#lockBtn'),
    logoutBtn: $('#logoutBtn'),
    pinSheet: $('#pinSheet'),
    pinClose: $('#pinClose'),
    pinTitle: $('#pinTitle'),
    pinInput: $('#pinInput'),
    pinRepeat: $('#pinRepeat'),
    pinRepeatRow: $('#pinRepeatRow'),
    pinError: $('#pinError'),
    pinSubmit: $('#pinSubmit'),
    lockOverlay: $('#lockOverlay'),
    lockPin: $('#lockPin'),
    lockError: $('#lockError'),
    lockSubmit: $('#lockSubmit'),
  };

  /* ---------------- аккаунт и хранилище ---------------- */
  let account = loadAccount();      // {id, email, token} | null
  let locked = false;               // локальная блокировка PIN-ом (в рамках сессии)
  let authMode = 'login';           // 'login' | 'register'

  function loadAccount() {
    try {
      const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
      if (a && a.id && a.token && a.email) return a;
    } catch { /* ignore */ }
    return null;
  }
  /* Адрес API: по умолчанию тот же origin; можно задать другой (статика на Pages,
     server.js на отдельном хостинге) — тогда на сервере нужен ALLOWED_ORIGINS. */
  let apiBase = readApiBase();
  function readApiBase() {
    try {
      const v = (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '');
      return /^https?:\/\//i.test(v) ? v : '';
    } catch { return ''; }
  }
  const apiUrl = (p) => apiBase + p;
  let serverOk = null;   // null — ещё не проверяли

  const storeKey = () => (account ? `pwa-tasks:v2:${account.id}` : LOCAL_STORE_KEY);
  const pullKey = () => `pwa-tasks:pull:${account ? account.id : 'local'}`;

  /** @type {{tasks: Array<object>, filter: string, query: string}} */
  const state = { tasks: load(), filter: 'all', query: '' };
  let editingId = null;
  let lastDeleted = null;
  let deferredPrompt = null;
  let lastViewKey = null;
  let swReg = null;
  let syncState = 'idle';   // idle | syncing | ok | error | off
  let syncing = false;
  let syncTimer = null;

  function normalizeTask(t) {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) return null;
    return {
      id: typeof t.id === 'string' ? t.id.slice(0, 64) : uid(),
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
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (Array.isArray(raw?.tasks)) return raw.tasks.map(normalizeTask).filter(Boolean);
    } catch { /* повреждённые данные — начинаем заново */ }
    return account ? [] : seed();
  }
  /** Сохранение с обработкой переполнения/недоступности хранилища. */
  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ v: 2, tasks: state.tasks }));
      return true;
    } catch (e) {
      showToast('Не удалось сохранить: хранилище недоступно');
      return false;
    }
  }
  function seed() {
    const t = todayStr();
    const now = Date.now();
    return [
      { id: uid(), title: 'Установить приложение на экран «Домой»', note: 'Safari → Поделиться → На экран «Домой»', due: t, prio: 1, done: false, deleted: false, createdAt: now - 3e5, completedAt: null, updatedAt: now - 3e5 },
      { id: uid(), title: 'Отключить Wi-Fi и проверить офлайн', note: 'Все задачи и экраны работают без сети', due: '', prio: 0, done: false, deleted: false, createdAt: now - 2e5, completedAt: null, updatedAt: now - 2e5 },
      { id: uid(), title: 'Смакнуть список вниз — заголовок схлопнется', note: '', due: '', prio: 0, done: true, deleted: false, createdAt: now - 1e5, completedAt: now - 6e4, updatedAt: now - 1e5 },
    ];
  }
  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
  }
  const touch = (t) => { t.updatedAt = Date.now(); return t; };

  /* ---------------- даты ---------------- */
  function todayStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function shiftDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  const fmtShort = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
  const fmtFull = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' });

  function dueLabel(due, today, tomorrow, yesterday) {
    if (!due) return '';
    if (due === today) return 'Сегодня';
    if (due === tomorrow) return 'Завтра';
    if (due === yesterday) return 'Вчера';
    const [y, m, d] = due.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return (y === new Date().getFullYear() ? fmtShort : fmtFull).format(date);
  }
  function dueClass(due, done, today) {
    if (!due || done) return '';
    if (due < today) return 'overdue';
    if (due === today) return 'today';
    return '';
  }

  /* ---------------- выборка и сортировка ---------------- */
  function visibleTasks(today) {
    const q = state.query.trim().toLowerCase();
    let list = state.tasks.filter((t) => {
      if (t.deleted) return false;
      if (state.filter === 'done' && !t.done) return false;
      if (state.filter === 'today' && t.due !== today) return false;
      if (q && !(t.title + ' ' + (t.note || '')).toLowerCase().includes(q)) return false;
      return true;
    });
    const rank = (t) => (t.done ? 1 : 0);
    list.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.done && b.done) return (b.completedAt || 0) - (a.completedAt || 0);
      const da = a.due || '9999-12-31';
      const db = b.due || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      if (a.prio !== b.prio) return b.prio - a.prio;
      return a.createdAt - b.createdAt;
    });
    return list;
  }

  /* ---------------- рендер ---------------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function rowHTML(t, today, tomorrow, yesterday) {
    const meta = [];
    if (t.due) meta.push(`<span class="due ${dueClass(t.due, t.done, today)}">${esc(dueLabel(t.due, today, tomorrow, yesterday))}</span>`);
    if (t.prio > 0 && !t.done) meta.push(`<span class="prio ${t.prio === 2 ? 'p2' : ''}" title="${t.prio === 2 ? 'Срочно' : 'Важно'}"></span>`);
    const label = esc(t.title);
    return `
      <div class="row ${t.done ? 'done' : ''}" data-id="${t.id}">
        <button class="row-delete" data-act="delete" aria-label="Удалить задачу: ${label}">Удалить</button>
        <div class="row-track" data-act="edit">
          <span class="check" role="switch" tabindex="0" data-act="toggle"
                aria-checked="${t.done ? 'true' : 'false'}" aria-label="${label}">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8.4 L6.4 11.8 L13 4.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <button type="button" class="row-edit" data-act="edit" aria-label="Изменить задачу: ${label}">
            <span class="row-main">
              <span class="row-title">${label}</span>
              ${t.note ? `<span class="row-note">${esc(t.note)}</span>` : ''}
            </span>
            ${meta.length ? `<span class="row-meta">${meta.join('')}</span>` : ''}
          </button>
        </div>
      </div>`;
  }

  function render(announce = false) {
    let restoreSel = null;
    const active = document.activeElement;
    if (active && active.closest && active.closest('#list')) {
      const row = active.closest('.row');
      const act = (active.dataset && active.dataset.act) || (active.closest('[data-act]') || {}).dataset?.act;
      if (row && act) restoreSel = `.row[data-id="${row.dataset.id}"] [data-act="${act}"]`;
    }

    const today = todayStr();
    const tomorrow = shiftDays(1);
    const yesterday = shiftDays(-1);
    const list = visibleTasks(today);
    els.list.innerHTML = list.map((t) => rowHTML(t, today, tomorrow, yesterday)).join('');

    if (restoreSel) {
      const el = els.list.querySelector(restoreSel);
      if (el) el.focus({ preventScroll: true });
    }

    els.empty.hidden = list.length > 0;
    if (!list.length) {
      els.emptyText.textContent = state.query
        ? 'Ничего не найдено'
        : state.filter === 'done' ? 'Нет выполненных задач'
        : state.filter === 'today' ? 'На сегодня задач нет'
        : 'Пока пусто — нажмите «+»';
    }
    const activeCount = state.tasks.filter((t) => !t.done && !t.deleted).length;
    document.title = activeCount ? `Задачи (${activeCount})` : 'Задачи';

    const viewKey = `${state.filter}|${state.query}`;
    if (viewKey !== lastViewKey) {
      lastViewKey = viewKey;
      announce = true;
      list.slice(0, 8).forEach((_, i) => {
        const row = els.list.children[i];
        if (row) { row.classList.add('enter'); row.style.animationDelay = `${i * 22}ms`; }
      });
    }
    if (announce) {
      els.liveStatus.textContent = list.length
        ? `Показано задач: ${list.length}`
        : els.emptyText.textContent;
    }
  }

  /* ---------------- действия с задачами ---------------- */
  function toggle(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const was = t.done, wasAt = t.completedAt, wasUpd = t.updatedAt;
    t.done = !was;
    t.completedAt = t.done ? Date.now() : null;
    touch(t);
    if (!save()) { t.done = was; t.completedAt = wasAt; t.updatedAt = wasUpd; return; }
    render();
    scheduleSync();
  }
  function remove(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t || t.deleted) return;
    const wasUpd = t.updatedAt;
    t.deleted = true;
    touch(t);
    if (!save()) { t.deleted = false; t.updatedAt = wasUpd; return; }
    lastDeleted = { id: t.id };
    render();
    showToast('Задача удалена', 'Вернуть', restore);
    scheduleSync();
  }
  function restore() {
    if (!lastDeleted) return;
    const t = state.tasks.find((x) => x.id === lastDeleted.id);
    lastDeleted = null;
    if (!t) return;
    t.deleted = false;
    touch(t);
    if (!save()) return;
    render();
    hideToast();
    scheduleSync();
  }
  function purgeOldTombstones() {
    const cut = Date.now() - TOMBSTONE_TTL_MS;
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((t) => !(t.deleted && t.updatedAt < cut));
    return state.tasks.length !== before;
  }

  /* ---------------- swipe-to-delete ---------------- */
  function bindSwipe(row) {
    const track = row.querySelector('.row-track');
    let startX = 0, startY = 0, dx = 0, mode = null;
    const MAX = -88;

    const reset = (commit) => {
      track.classList.remove('dragging');
      if (commit && dx < MAX * 0.55) {
        remove(row.dataset.id);
        return;
      }
      track.style.transform = '';
    };

    row.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY; dx = 0; mode = null;
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      const mx = e.touches[0].clientX - startX;
      const my = e.touches[0].clientY - startY;
      if (mode === null) {
        if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my) * 1.2) { mode = 'x'; track.classList.add('dragging'); }
        else if (Math.abs(my) > 8) { mode = 'y'; }
      }
      if (mode !== 'x') return;
      e.preventDefault();
      dx = Math.max(MAX * 1.35, Math.min(0, mx));
      track.style.transform = `translateX(${dx}px)`;
    }, { passive: false });

    row.addEventListener('touchend', () => { if (mode === 'x') reset(true); });
    row.addEventListener('touchcancel', () => { if (mode === 'x') reset(false); });
  }

  els.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') toggle(row.dataset.id);
    else if (act === 'delete') remove(row.dataset.id);
    else if (act === 'edit') openSheet(row.dataset.id);
  });
  els.list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-act="toggle"]');
    if (!t) return;
    e.preventDefault();
    const row = t.closest('.row');
    if (row) toggle(row.dataset.id);
  });

  /* ---------------- фильтры и поиск ---------------- */
  els.segmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    els.segmented.querySelectorAll('.seg').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    const idx = [...els.segmented.querySelectorAll('.seg')].indexOf(btn);
    els.segThumb.style.transform = `translateX(${idx * 100}%)`;
    render(true);
  });

  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value;
      render(true);
    }, 120);
  });

  /* ---------------- bottom sheet ---------------- */
  function setPrio(p) {
    els.prioSeg.querySelectorAll('.seg').forEach((b, i) => {
      b.classList.toggle('is-active', i === p);
      b.setAttribute('aria-pressed', i === p ? 'true' : 'false');
    });
    const thumb = els.prioSeg.querySelector('.segmented-thumb');
    if (thumb) thumb.style.transform = `translateX(${p * 100}%)`;
  }
  function getPrio() {
    return [...els.prioSeg.querySelectorAll('.seg')].findIndex((b) => b.classList.contains('is-active'));
  }
  els.prioSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (btn) setPrio(Number(btn.dataset.prio));
  });

  let sheetSnapshot = '';
  let sheetOpener = null;
  let lockY = 0;
  let lockDepth = 0;          // вложенные шторки (аккаунт → PIN): разблокируем только закрыв все
  const sheetSnapshotNow = () => JSON.stringify([els.taskTitle.value, els.taskNote.value, els.taskDate.value, getPrio()]);
  const isDirty = () => sheetSnapshotNow() !== sheetSnapshot;

  function lockScroll() {
    lockDepth++;
    if (lockDepth > 1) return;
    lockY = window.scrollY;
    document.body.style.top = `-${lockY}px`;
    document.body.classList.add('sheet-open');
  }
  function unlockScroll() {
    lockDepth = Math.max(0, lockDepth - 1);
    if (lockDepth > 0) return;
    document.body.classList.remove('sheet-open');
    document.body.style.top = '';
    window.scrollTo(0, lockY);
  }

  function syncDateClear() { els.taskDateClear.hidden = !els.taskDate.value; }
  els.taskDate.addEventListener('input', syncDateClear);
  els.taskDateClear.addEventListener('click', () => {
    els.taskDate.value = '';
    syncDateClear();
    els.taskDate.focus({ preventScroll: true });
  });

  function openSheet(id = null) {
    editingId = id;
    sheetOpener = document.activeElement;
    const t = id ? state.tasks.find((x) => x.id === id) : null;
    els.sheetTitle.textContent = t ? 'Задача' : 'Новая задача';
    els.taskTitle.value = t?.title || '';
    els.taskNote.value = t?.note || '';
    els.taskDate.value = t?.due || '';
    syncDateClear();
    setPrio(t?.prio || 0);
    els.sheetDelete.hidden = !t;
    sheetSnapshot = sheetSnapshotNow();

    els.sheet.hidden = false;
    els.backdrop.hidden = false;
    lockScroll();
    requestAnimationFrame(() => {
      els.sheet.classList.add('show');
      els.backdrop.classList.add('show');
    });
    setTimeout(() => els.taskTitle.focus({ preventScroll: true }), 380);
  }

  function closeSheet() {
    els.sheet.classList.remove('show');
    els.backdrop.classList.remove('show');
    els.taskTitle.blur();
    setTimeout(() => {
      els.sheet.hidden = true;
      els.backdrop.hidden = true;
      els.sheet.style.bottom = '';
      unlockScroll();
      if (sheetOpener && document.contains(sheetOpener)) sheetOpener.focus({ preventScroll: true });
      sheetOpener = null;
    }, 420);
  }

  function requestClose() {
    if (isDirty() && !window.confirm('Закрыть без сохранения? Несохранённые правки будут потеряны.')) return;
    closeSheet();
  }

  els.fab.addEventListener('click', () => openSheet());
  els.sheetCancel.addEventListener('click', requestClose);
  els.backdrop.addEventListener('click', requestClose);

  els.sheet.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = [...els.sheet.querySelectorAll('button, input, textarea, [tabindex="0"]')]
      .filter((el) => !el.hidden && !el.disabled);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.pinSheet.hidden) { closePin(); return; }
    if (!els.acctSheet.hidden) { closeAcct(); return; }
    if (!els.sheet.hidden) requestClose();
  });

  els.sheet.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = els.taskTitle.value.trim();
    if (!title) { els.taskTitle.focus(); return; }
    const data = { title, note: els.taskNote.value.trim(), due: els.taskDate.value, prio: getPrio() };
    if (editingId) {
      const t = state.tasks.find((x) => x.id === editingId);
      const backup = { ...t };
      Object.assign(t, data);
      touch(t);
      if (!save()) { Object.assign(t, backup); return; }
    } else {
      state.tasks.push(touch({ id: uid(), ...data, done: false, deleted: false, createdAt: Date.now(), completedAt: null }));
      if (!save()) { state.tasks.pop(); return; }
    }
    render(true); closeSheet();
    scheduleSync();
  });

  els.sheetDelete.addEventListener('click', () => {
    if (editingId) { remove(editingId); closeSheet(); }
  });

  (() => {
    let y0 = null;
    const grip = $('#sheetGrip');
    grip.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    grip.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      const dy = Math.max(0, e.touches[0].clientY - y0);
      els.sheet.style.transition = 'none';
      els.sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    grip.addEventListener('touchend', (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      els.sheet.style.transition = '';
      els.sheet.style.transform = '';
      if (dy > 90) requestClose();
      y0 = null;
    });
  })();

  if (window.visualViewport) {
    visualViewport.addEventListener('resize', () => {
      if (els.sheet.hidden) return;
      const offset = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
      els.sheet.style.bottom = `${offset}px`;
    });
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  let toastActionHandler = null;
  function showToast(text, actionLabel = null, onAction = null) {
    els.toastText.textContent = text;
    els.toastAction.hidden = !actionLabel;
    if (actionLabel) els.toastAction.textContent = actionLabel;
    toastActionHandler = onAction;
    els.toast.hidden = false;
    requestAnimationFrame(() => els.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    els.toast.classList.remove('show');
    clearTimeout(toastTimer);
    setTimeout(() => { els.toast.hidden = true; }, 260);
  }
  els.toastAction.addEventListener('click', () => {
    const fn = toastActionHandler;
    toastActionHandler = null;
    if (fn) fn(); else hideToast();
  });

  /* ---------------- скролл: large title → navbar ---------------- */
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      document.body.classList.toggle('scrolled', scrollY > 56);
      ticking = false;
    });
  }, { passive: true });

  /* ---------------- офлайн-индикатор ---------------- */
  const setOnline = () => {
    els.offlinePill.hidden = navigator.onLine;
    if (navigator.onLine) scheduleSync();
  };
  addEventListener('online', setOnline);
  addEventListener('offline', () => { els.offlinePill.hidden = false; setSyncUI(syncState); });
  setOnline();

  /* ---------------- экспорт / импорт ---------------- */
  function exportPayload() {
    return JSON.stringify({
      app: 'pwa-tasks',
      v: 2,
      exportedAt: new Date().toISOString(),
      account: account ? account.email : null,
      tasks: state.tasks.filter((t) => !t.deleted).map((t) => ({ ...t })),
    }, null, 2);
  }
  function exportFile() {
    const blob = new Blob([exportPayload()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pwa-tasks-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Файл .json сохранён в загрузки');
  }
  async function exportShare() {
    const blob = new Blob([exportPayload()], { type: 'application/json' });
    const file = new File([blob], `pwa-tasks-${todayStr()}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Задачи' }); return; } catch { /* отменено */ return; }
    }
    exportFile();
  }
  els.exportBtn.addEventListener('click', exportFile);
  els.shareBtn.addEventListener('click', exportShare);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const f = els.importFile.files[0];
    els.importFile.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const raw = Array.isArray(data) ? data : data?.tasks;
      if (!Array.isArray(raw)) throw new Error('bad shape');
      const incoming = raw.map(normalizeTask).filter(Boolean);
      const backup = state.tasks;
      state.tasks = mergeTasks(state.tasks, incoming);
      if (!save()) { state.tasks = backup; return; }
      render(true);
      showToast(`Импортировано задач: ${incoming.length}`);
      scheduleSync();
    } catch {
      showToast('Не удалось прочитать файл импорта');
    }
  });

  /* ---------------- синхронизация ---------------- */
  function setSyncUI(next) {
    syncState = next;
    const map = {
      off: ['нет аккаунта', ''],
      idle: ['синхронизировано', 'ok'],
      syncing: ['синхронизация…', 'syncing'],
      ok: ['синхронизировано', 'ok'],
      error: ['ошибка синхронизации', 'error'],
    };
    const [text, cls] = map[next] || map.idle;
    els.acctDot.className = 'sync-dot' + (cls ? ' ' + cls : '');
    els.acctSyncState.textContent = navigator.onLine ? text : 'офлайн: изменения в очереди';
  }
  function scheduleSync() {
    if (!account || locked) { setSyncUI(account ? syncState : 'off'); return; }
    if (!navigator.onLine) { setSyncUI('error'); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1500);
  }
  /** Слияние LWW по updatedAt; используется и для импорта, и для пулла с сервера. */
  function mergeTasks(local, remote) {
    const byId = new Map(local.map((t) => [t.id, t]));
    for (const r of remote) {
      const cur = byId.get(r.id);
      if (!cur || r.updatedAt > cur.updatedAt) byId.set(r.id, r);
    }
    return [...byId.values()];
  }
  async function api(path, opts = {}) {
    const res = await fetch(apiUrl(path), {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(account ? { Authorization: `Bearer ${account.token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401 && account) {
      dropAccount();
      showToast('Сессия истекла — войдите снова');
      throw new Error('unauthorized');
    }
    return res;
  }
  async function syncNow() {
    if (!account || syncing || locked || !navigator.onLine || typeof fetch !== 'function') return;
    syncing = true;
    setSyncUI('syncing');
    try {
      const since = Number(localStorage.getItem(pullKey()) || 0);
      const res = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ since, tasks: state.tasks }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.tasks)) throw new Error('bad response');
      const remote = (data.tasks || []).map(normalizeTask).filter(Boolean);
      const purged = purgeOldTombstones();
      state.tasks = mergeTasks(state.tasks, remote);
      localStorage.setItem(pullKey(), String(data.serverNow || Date.now()));
      if (!save()) throw new Error('storage');
      render();
      setSyncUI('ok');
      if (purged) save();
    } catch (e) {
      if (e?.message !== 'unauthorized') setSyncUI('error');
    } finally {
      syncing = false;
    }
  }

  /* ---------------- аккаунт: вход/регистрация/выход ---------------- */
  function accountUI() {
    if (account) {
      els.acctInitials.textContent = account.email.slice(0, 2).toUpperCase();
      els.acctBtn.setAttribute('aria-label', `Аккаунт ${account.email}`);
      els.acctAnon.hidden = true;
      els.acctIn.hidden = false;
      els.acctEmail.textContent = account.email;
    } else {
      els.acctInitials.textContent = '•';
      els.acctBtn.setAttribute('aria-label', 'Войти или создать аккаунт');
      els.acctAnon.hidden = false;
      els.acctIn.hidden = true;
      setSyncUI('off');
    }
  }
  function renderServerState() {
    const where = apiBase || 'этот сайт';
    let text, cls;
    if (typeof fetch !== 'function') { text = 'сервер не проверить: нужен HTTPS или localhost'; cls = 'bad'; }
    else if (serverOk === null) { text = `проверяем сервер (${where})…`; cls = ''; }
    else if (serverOk) { text = `сервер синхронизации отвечает (${where})`; cls = 'ok'; }
    else if (!navigator.onLine) { text = 'нет подключения — задачи доступны локально'; cls = 'bad'; }
    else { text = `сервер не отвечает: по адресу ${where} нет API`; cls = 'bad'; }
    els.serverState.textContent = text;
    els.serverState.className = 'server-state' + (cls ? ' ' + cls : '');
  }
  /** Пинг /api/health: по нему видно, развёрнут ли API там, откуда открыто приложение. */
  async function probeServer() {
    renderServerState();
    if (typeof fetch !== 'function') { serverOk = false; renderServerState(); return false; }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 6000) : null;
    try {
      const res = await fetch(apiUrl('/api/health'), {
        method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
      });
      const data = await res.json().catch(() => null);
      serverOk = !!(res.ok && data && data.ok);
    } catch {
      serverOk = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    renderServerState();
    if (!account) setSyncUI(serverOk ? 'off' : 'error');
    return serverOk;
  }
  function openAcct() {
    accountUI();
    els.authFields.hidden = true;
    els.authError.hidden = true;
    els.apiBase.value = apiBase;
    if (!account) probeServer(); else renderServerState();
    els.acctSheet.hidden = false;
    els.backdrop.hidden = false;
    lockScroll();
    requestAnimationFrame(() => {
      els.acctSheet.classList.add('show');
      els.backdrop.classList.add('show');
    });
    setTimeout(() => (account ? els.syncNowBtn : $('#authLogin')).focus({ preventScroll: true }), 120);
  }
  function closeAcct() {
    els.acctSheet.classList.remove('show');
    els.backdrop.classList.remove('show');
    setTimeout(() => {
      els.acctSheet.hidden = true;
      els.backdrop.hidden = true;
      unlockScroll();
    }, 420);
  }
  els.acctBtn.addEventListener('click', openAcct);
  els.acctClose.addEventListener('click', closeAcct);

  els.apiBaseSave.addEventListener('click', async () => {
    const raw = els.apiBase.value.trim().replace(/\/+$/, '');
    if (raw && !/^https?:\/\//i.test(raw)) {
      els.authError.textContent = 'Адрес сервера должен начинаться с https:// (или http:// для localhost)';
      els.authError.hidden = false;
      return;
    }
    els.authError.hidden = true;
    apiBase = raw;
    try {
      if (raw) localStorage.setItem(API_BASE_KEY, raw); else localStorage.removeItem(API_BASE_KEY);
    } catch { /* приватный режим — значение останется до перезапуска */ }
    serverOk = null;
    const alive = await probeServer();
    showToast(alive ? 'Сервер отвечает' : 'Сервер не отвечает — проверьте адрес и ALLOWED_ORIGINS');
  });
  els.apiBaseReset.addEventListener('click', () => {
    els.apiBase.value = '';
    els.apiBaseSave.click();
  });

  function setAuthMode(mode) {
    authMode = mode;
    els.authModeTitle.textContent = mode === 'login' ? 'Вход' : 'Регистрация';
    els.authSubmit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    els.authFields.hidden = false;
    els.authError.hidden = true;
    setTimeout(() => els.authEmail.focus({ preventScroll: true }), 120);
  }
  $('#authLogin').addEventListener('click', () => setAuthMode('login'));
  $('#authRegister').addEventListener('click', () => setAuthMode('register'));
  els.authCancel.addEventListener('click', () => { els.authFields.hidden = true; els.authError.hidden = true; });

  function dropAccount() {
    account = null;
    try { localStorage.removeItem(ACCOUNT_KEY); } catch { /* ignore */ }
  }
  /** Понятный текст ошибки входа: отличаем «нет API на этом хостинге» от «нет сети». */
  function authFailMessage(res, data, networkError) {
    if (networkError) {
      if (!navigator.onLine) return 'Нет подключения к интернету. Задачи сохранятся локально, вход выполните позже.';
      return serverOk === false
        ? `Сервер синхронизации не отвечает (${apiUrl('/api')}). Если сайт открыт со статического хостинга (GitHub Pages, Netlify), API там нет: запустите server.js или укажите адрес сервера в блоке «Сервер синхронизации».`
        : `Не удалось связаться с сервером (${apiUrl('/api')}). Проверьте интернет и адрес сервера.`;
    }
    if (data && data.error) return data.error;
    if (res && res.status === 404) return `По адресу ${apiUrl('/api')} нет API: приложение открыто без server.js (статический хостинг).`;
    if (res && res.status >= 500) return `Ошибка сервера (${res.status}). Попробуйте ещё раз через минуту.`;
    return `Сервер ответил ошибкой${res ? ` (${res.status})` : ''}`;
  }
  function showAuthError(text) {
    els.authError.textContent = text;
    els.authError.hidden = false;
  }
  async function submitAuth(e) {
    e.preventDefault();
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    els.authError.hidden = true;
    if (typeof fetch !== 'function') {
      showAuthError('Синхронизация доступна только по HTTPS или localhost: браузер не даёт сетевые запросы и crypto.subtle в незащищённом контексте.');
      return;
    }
    if (!email || password.length < 8) {
      showAuthError('Нужны e-mail и пароль минимум 8 символов.');
      return;
    }
    // локальные задачи ДО переключения хранилища — для переноса
    const localBefore = account ? [] : state.tasks.slice();
    let res = null, data = null, networkError = false;
    try {
      res = await fetch(apiUrl(`/api/${authMode === 'login' ? 'login' : 'register'}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      data = await res.json().catch(() => null);
    } catch { networkError = true; }

    // сначала свежая диагностика, иначе текст ошибки опишет устаревшее состояние сервера
    if (networkError) await probeServer();
    if (networkError || !res || !res.ok || !data || !data.token || !data.user) {
      showAuthError(!networkError && res && res.ok
        ? 'Сервер ответил неожиданным форматом (нет токена). Похоже, по этому адресу не server.js этого проекта.'
        : authFailMessage(res, data, networkError));
      if (!networkError) probeServer();
      return;
    }
    account = { id: data.user.id, email: data.user.email, token: data.token };
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch { /* приватный режим */ }
    state.tasks = load();
    if (els.authMigrate.checked && localBefore.length) {
      state.tasks = mergeTasks(state.tasks, localBefore.map((t) => ({ ...t })));
    }
    save();
    locked = false;
    serverOk = true;
    accountUI();
    render(true);
    closeAcct();
    showToast(`Вход выполнен: ${account.email}`);
    syncNow();
  }
  els.authFields.addEventListener('submit', submitAuth);

  els.logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* best effort */ }
    dropAccount();
    state.tasks = load();
    save();
    accountUI();
    render(true);
    closeAcct();
    showToast('Вы вышли: задачи остались на этом устройстве');
  });
  els.syncNowBtn.addEventListener('click', () => syncNow());

  /* ---------------- PIN-блокировка (локальная, на устройство) ---------------- */
  const pinKey = () => `pwa-tasks:pin:${account ? account.id : 'local'}`;
  const pinAvailable = () => !!(window.crypto && crypto.subtle);
  const pinStored = () => {
    try { return JSON.parse(localStorage.getItem(pinKey()) || 'null'); } catch { return null; }
  };
  async function derivePin(pin, salt) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function pinUI() {
    els.pinSetBtn.hidden = !pinAvailable();
    els.lockBtn.hidden = !pinAvailable() || !pinStored();
  }
  let pinMode = 'set';
  function openPin(mode) {
    pinMode = mode;
    els.pinTitle.textContent = mode === 'set' ? 'Установить PIN' : 'Сменить PIN';
    els.pinRepeatRow.hidden = mode !== 'set';
    els.pinInput.value = '';
    els.pinRepeat.value = '';
    els.pinError.hidden = true;
    els.pinSheet.hidden = false;
    els.backdrop.hidden = false;
    lockScroll();
    els.backdrop.classList.add('show');
    els.pinSheet.classList.add('show');
    setTimeout(() => els.pinInput.focus({ preventScroll: true }), 120);
  }
  function closePin() {
    els.pinSheet.classList.remove('show');
    els.backdrop.classList.remove('show');
    setTimeout(() => { els.pinSheet.hidden = true; els.backdrop.hidden = true; unlockScroll(); }, 420);
  }
  els.pinSetBtn.addEventListener('click', () => openPin('set'));
  els.pinClose.addEventListener('click', closePin);
  els.pinSheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = els.pinInput.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      els.pinError.textContent = 'PIN — от 4 до 8 цифр';
      els.pinError.hidden = false;
      return;
    }
    if (pinMode === 'set' && pin !== els.pinRepeat.value.trim()) {
      els.pinError.textContent = 'PIN не совпадает';
      els.pinError.hidden = false;
      return;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16)).join('');
    const hash = await derivePin(pin, salt);
    localStorage.setItem(pinKey(), JSON.stringify({ salt, hash }));
    closePin();
    pinUI();
    showToast('PIN установлен на этом устройстве');
  });
  els.lockBtn.addEventListener('click', () => {
    closeAcct();
    setLocked(true);
  });
  function setLocked(v) {
    locked = v;
    els.lockOverlay.hidden = !v;
    if (v) {
      els.lockPin.value = '';
      els.lockError.hidden = true;
      setTimeout(() => els.lockPin.focus({ preventScroll: true }), 60);
    }
  }
  els.lockOverlay.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rec = pinStored();
    const hash = await derivePin(els.lockPin.value.trim(), rec.salt);
    if (hash !== rec.hash) {
      els.lockError.textContent = 'Неверный PIN';
      els.lockError.hidden = false;
      els.lockPin.value = '';
      return;
    }
    setLocked(false);
    scheduleSync();
  });

  /* ---------------- установка PWA ---------------- */
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!standalone) {
      els.installCard.hidden = false;
      els.installBtn.hidden = false;
      els.installDesc.textContent = 'Приложение можно поставить как обычное: с иконкой и без адресной строки.';
    }
  });
  addEventListener('appinstalled', () => { els.installCard.hidden = true; });

  if (!standalone && isIOS && !localStorage.getItem('pwa-tasks:install-dismissed')) {
    els.installCard.hidden = false;
    els.installBtn.hidden = true;
    els.installDesc.innerHTML = 'В Safari: «Поделиться» <svg width="12" height="14" viewBox="0 0 12 14" style="vertical-align:-2px"><path d="M6 1v8M3 3.6 6 1l3 2.6M1.5 6.5v5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> → «На экран “Домой”».';
  }
  els.installClose.addEventListener('click', () => {
    els.installCard.hidden = true;
    localStorage.setItem('pwa-tasks:install-dismissed', '1');
  });
  els.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    els.installCard.hidden = true;
  });

  // Предупреждение об изоляции хранилища — только в локальном режиме без аккаунта
  if (standalone && !account && !localStorage.getItem('pwa-tasks:isolation-shown')) {
    els.storageBanner.hidden = false;
  }
  els.storageBannerClose.addEventListener('click', () => {
    els.storageBanner.hidden = true;
    try { localStorage.setItem('pwa-tasks:isolation-shown', '1'); } catch { /* ignore */ }
  });

  /* ---------------- service worker ---------------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
      swReg = reg;
      const ready = () => {
        if (!localStorage.getItem('pwa-tasks:hint-shown')) {
          els.swHint.hidden = false;
          localStorage.setItem('pwa-tasks:hint-shown', '1');
          setTimeout(() => { els.swHint.hidden = true; }, 9000);
        }
      };
      if (reg.active) ready();

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'activated') ready();
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Доступна новая версия', 'Обновить', () => {
              reg.waiting?.postMessage('SKIP_WAITING');
              installing.postMessage?.('SKIP_WAITING');
              setTimeout(() => location.reload(), 150);
            });
          }
        });
      });
    }).catch(() => { /* например, file:// — молча пропускаем */ });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (swReg) swReg.update().catch(() => {});
        syncNow();
      }
    });
  }

  /* ---------------- ярлык «Новая задача» (?new=1) ---------------- */
  if (new URLSearchParams(location.search).get('new') === '1') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openSheet(), 300);
  }

  const mo = new MutationObserver(() => {
    els.list.querySelectorAll('.row:not([data-swipe])').forEach((r) => { r.dataset.swipe = '1'; bindSwipe(r); });
  });
  mo.observe(els.list, { childList: true });

  let lastDay = todayStr();
  setInterval(() => {
    const now = todayStr();
    if (now !== lastDay) { lastDay = now; render(); }
  }, 60000);

  /* ---------------- старт ---------------- */
  accountUI();
  pinUI();
  if (account && pinStored()) setLocked(true);
  if (account) {
    api('/api/me').then((r) => { if (r.ok) syncNow(); }).catch(() => setSyncUI('error'));
  }
  render();

  // отладочный хук для тестов: ?debug=1
  if (new URLSearchParams(location.search).has('debug')) {
    window.__pwa = { mergeTasks, syncNow, scheduleSync, probeServer, get account() { return account; }, state, normalizeTask, exportPayload };
  }
})();
