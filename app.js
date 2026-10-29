/* Задачи — PWA. Логика без зависимостей. */
(() => {
  'use strict';

  const STORE_KEY = 'pwa-tasks:v1';
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
    importBtn: $('#importBtn'),
    importFile: $('#importFile'),
    toast: $('#toast'),
    toastText: $('#toastText'),
    toastAction: $('#toastAction'),
    liveStatus: $('#liveStatus'),
  };

  /** @type {{tasks: Array<object>, filter: string, query: string}} */
  const state = { tasks: load(), filter: 'all', query: '' };
  let editingId = null;
  let lastDeleted = null;
  let deferredPrompt = null;
  let lastViewKey = null;
  let swReg = null;

  /* ---------------- хранилище ---------------- */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (Array.isArray(raw?.tasks)) return raw.tasks.map(normalizeTask).filter(Boolean);
    } catch { /* повреждённые данные — начинаем заново */ }
    return seed();
  }
  function normalizeTask(t) {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) return null;
    return {
      id: typeof t.id === 'string' ? t.id : uid(),
      title: t.title.slice(0, 140),
      note: typeof t.note === 'string' ? t.note.slice(0, 500) : '',
      due: typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
      prio: [0, 1, 2].includes(t.prio) ? t.prio : 0,
      done: !!t.done,
      createdAt: Number(t.createdAt) || Date.now(),
      completedAt: Number(t.completedAt) || null,
    };
  }
  /** Сохранение с обработкой переполнения/недоступности хранилища.
      Возвращает false, если записать не удалось (UI тогда не мутируем). */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, tasks: state.tasks }));
      return true;
    } catch (e) {
      showToast('Не удалось сохранить: хранилище недоступно');
      return false;
    }
  }
  function seed() {
    const t = todayStr();
    return [
      { id: uid(), title: 'Установить приложение на экран «Домой»', note: 'Safari → Поделиться → На экран «Домой»', due: t, prio: 1, done: false, createdAt: Date.now() - 3e5, completedAt: null },
      { id: uid(), title: 'Отключить Wi-Fi и проверить офлайн', note: 'Все задачи и экраны работают без сети', due: '', prio: 0, done: false, createdAt: Date.now() - 2e5, completedAt: null },
      { id: uid(), title: 'Смакнуть список вниз — заголовок схлопнется', note: '', due: '', prio: 0, done: true, createdAt: Date.now() - 1e5, completedAt: Date.now() - 6e4 },
    ];
  }
  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
  }

  /* ---------------- даты ---------------- */
  function todayStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function shiftDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  // Форматтеры Intl создаются один раз (ранее — новый на каждую строку каждый рендер)
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
    // Возврат фокуса: пересборка innerHTML раньше сбрасывала его на <body>
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
    const activeCount = state.tasks.filter((t) => !t.done).length;
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
    const was = t.done, wasAt = t.completedAt;
    t.done = !was;
    t.completedAt = t.done ? Date.now() : null;
    if (!save()) { t.done = was; t.completedAt = wasAt; return; }
    render();
  }
  function remove(id) {
    const idx = state.tasks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const [task] = state.tasks.splice(idx, 1);
    if (!save()) { state.tasks.splice(idx, 0, task); return; }
    lastDeleted = { task, idx };
    render();
    showToast('Задача удалена', 'Вернуть', restore);
  }
  function restore() {
    if (!lastDeleted) return;
    state.tasks.splice(Math.min(lastDeleted.idx, state.tasks.length), 0, lastDeleted.task);
    lastDeleted = null;
    if (!save()) return;
    render();
    hideToast();
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
  // Клавиатура: switch-галочка активируется Enter/Space
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

  // Дебаунс поиска: ранее список пересобирался на каждый символ
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
  const sheetSnapshotNow = () => JSON.stringify([els.taskTitle.value, els.taskNote.value, els.taskDate.value, getPrio()]);
  const isDirty = () => sheetSnapshotNow() !== sheetSnapshot;

  function lockScroll() {
    lockY = window.scrollY;
    document.body.style.top = `-${lockY}px`;
    document.body.classList.add('sheet-open');
  }
  function unlockScroll() {
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

  // Ловушка фокуса внутри диалога
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
    if (e.key === 'Escape' && !els.sheet.hidden) requestClose();
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
      if (!save()) { Object.assign(t, backup); return; }
    } else {
      state.tasks.push({ id: uid(), ...data, done: false, createdAt: Date.now(), completedAt: null });
      if (!save()) { state.tasks.pop(); return; }
    }
    render(true); closeSheet();
  });

  els.sheetDelete.addEventListener('click', () => {
    if (editingId) { remove(editingId); closeSheet(); }
  });

  // свайп вниз за «ручку», как в iOS
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

  // клавиатура не должна перекрывать шторку
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
  const setOnline = () => { els.offlinePill.hidden = navigator.onLine; };
  addEventListener('online', setOnline);
  addEventListener('offline', setOnline);
  setOnline();

  /* ---------------- экспорт / импорт (страховка от изоляции хранилища iOS) ---------------- */
  function exportData() {
    const payload = JSON.stringify({ app: 'pwa-tasks', v: 2, exportedAt: new Date().toISOString(), tasks: state.tasks }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const file = new File([blob], 'pwa-tasks.json', { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Задачи' }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pwa-tasks.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Резервная копия сохранена');
  }
  els.exportBtn.addEventListener('click', exportData);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const f = els.importFile.files[0];
    els.importFile.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const raw = Array.isArray(data) ? data : data?.tasks;
      if (!Array.isArray(raw)) throw new Error('bad shape');
      const tasks = raw.map(normalizeTask).filter(Boolean);
      const backup = state.tasks;
      state.tasks = tasks;
      if (!save()) { state.tasks = backup; return; }
      render(true);
      showToast(`Импортировано задач: ${tasks.length}`);
    } catch {
      showToast('Не удалось прочитать файл импорта');
    }
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

  // Предупреждение: данные установленного PWA изолированы от Safari (iOS)
  if (standalone && !localStorage.getItem('pwa-tasks:isolation-shown')) {
    els.storageBanner.hidden = false;
  }
  els.storageBannerClose.addEventListener('click', () => {
    els.storageBanner.hidden = true;
    try { localStorage.setItem('pwa-tasks:isolation-shown', '1'); } catch { /* ignore */ }
  });

  /* ---------------- service worker ---------------- */
  if ('serviceWorker' in navigator) {
    // updateViaCache:'none' — HTTP-кэш хостинга не должен держать старый sw.js
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
          // Новый SW встал в очередь: предлагаем обновить, а не ломаем сессию skipWaiting
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

    // Установленное приложение может жить днями без navigation: проверяем обновления сами
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && swReg) swReg.update().catch(() => {});
    });
  }

  /* ---------------- ярлык «Новая задача» (?new=1) ---------------- */
  if (new URLSearchParams(location.search).get('new') === '1') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openSheet(), 300);
  }

  // делегируем bindSwipe для новых строк
  const mo = new MutationObserver(() => {
    els.list.querySelectorAll('.row:not([data-swipe])').forEach((r) => { r.dataset.swipe = '1'; bindSwipe(r); });
  });
  mo.observe(els.list, { childList: true });

  // Смена суток: метки «Сегодня/Вчера» должны оставаться верными
  let lastDay = todayStr();
  setInterval(() => {
    const now = todayStr();
    if (now !== lastDay) { lastDay = now; render(); }
  }, 60000);

  render();
})();
