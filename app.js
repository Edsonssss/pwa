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
    prioSeg: $('#prioSeg'),
    installCard: $('#installCard'),
    installBtn: $('#installBtn'),
    installClose: $('#installClose'),
    installDesc: $('#installDesc'),
    offlinePill: $('#offlinePill'),
    swHint: $('#swHint'),
    toast: $('#toast'),
    toastText: $('#toastText'),
    toastAction: $('#toastAction'),
  };

  /** @type {{tasks: Array<object>, filter: string, query: string}} */
  const state = { tasks: load(), filter: 'all', query: '' };
  let editingId = null;
  let lastDeleted = null;
  let deferredPrompt = null;
  let lastViewKey = null;

  /* ---------------- хранилище ---------------- */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (Array.isArray(raw?.tasks)) return raw.tasks;
    } catch { /* повреждённые данные — начинаем заново */ }
    return seed();
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify({ tasks: state.tasks }));
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
  function dueLabel(due) {
    if (!due) return '';
    if (due === todayStr()) return 'Сегодня';
    if (due === shiftDays(1)) return 'Завтра';
    if (due === shiftDays(-1)) return 'Вчера';
    const [y, m, d] = due.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const sameYear = y === new Date().getFullYear();
    return new Intl.DateTimeFormat('ru', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  }
  function dueClass(due, done) {
    if (!due || done) return '';
    if (due < todayStr()) return 'overdue';
    if (due === todayStr()) return 'today';
    return '';
  }

  /* ---------------- выборка и сортировка ---------------- */
  function visibleTasks() {
    const q = state.query.trim().toLowerCase();
    let list = state.tasks.filter((t) => {
      if (state.filter === 'done' && !t.done) return false;
      if (state.filter === 'today' && t.due !== todayStr()) return false;
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

  function rowHTML(t) {
    const meta = [];
    if (t.due) meta.push(`<span class="due ${dueClass(t.due, t.done)}">${esc(dueLabel(t.due))}</span>`);
    if (t.prio > 0 && !t.done) meta.push(`<span class="prio ${t.prio === 2 ? 'p2' : ''}" title="${t.prio === 2 ? 'Срочно' : 'Важно'}"></span>`);
    return `
      <div class="row ${t.done ? 'done' : ''}" data-id="${t.id}">
        <button class="row-delete" data-act="delete">Удалить</button>
        <div class="row-track" data-act="edit">
          <button class="check" data-act="toggle" aria-label="Отметить выполненной">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8.4 L6.4 11.8 L13 4.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <div class="row-main">
            <div class="row-title">${esc(t.title)}</div>
            ${t.note ? `<div class="row-note">${esc(t.note)}</div>` : ''}
          </div>
          ${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}
        </div>
      </div>`;
  }

  function render() {
    const list = visibleTasks();
    els.list.innerHTML = list.map(rowHTML).join('');
    els.empty.hidden = list.length > 0;
    if (!list.length) {
      els.emptyText.textContent = state.query
        ? 'Ничего не найдено'
        : state.filter === 'done' ? 'Нет выполненных задач'
        : state.filter === 'today' ? 'На сегодня задач нет'
        : 'Пока пусто — нажмите «+»';
    }
    const active = state.tasks.filter((t) => !t.done).length;
    document.title = active ? `Задачи (${active})` : 'Задачи';

    // стаггер-анимация только при смене вкладки/поиска, а не на каждое действие
    const viewKey = `${state.filter}|${state.query}`;
    if (viewKey !== lastViewKey) {
      lastViewKey = viewKey;
      list.slice(0, 8).forEach((_, i) => {
        const row = els.list.children[i];
        if (row) { row.classList.add('enter'); row.style.animationDelay = `${i * 22}ms`; }
      });
    }
  }

  /* ---------------- действия с задачами ---------------- */
  function toggle(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    save(); render();
  }
  function remove(id) {
    const idx = state.tasks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    lastDeleted = { task: state.tasks[idx], idx };
    state.tasks.splice(idx, 1);
    save(); render();
    showToast('Задача удалена');
  }
  function restore() {
    if (!lastDeleted) return;
    state.tasks.splice(Math.min(lastDeleted.idx, state.tasks.length), 0, lastDeleted.task);
    lastDeleted = null;
    save(); render();
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

  /* ---------------- фильтры и поиск ---------------- */
  els.segmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    els.segmented.querySelectorAll('.seg').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    const idx = [...els.segmented.querySelectorAll('.seg')].indexOf(btn);
    els.segThumb.style.transform = `translateX(${idx * 100}%)`;
    render();
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    render();
  });

  /* ---------------- bottom sheet ---------------- */
  function setPrio(p) {
    els.prioSeg.querySelectorAll('.seg').forEach((b, i) => b.classList.toggle('is-active', i === p));
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

  function openSheet(id = null) {
    editingId = id;
    const t = id ? state.tasks.find((x) => x.id === id) : null;
    els.sheetTitle.textContent = t ? 'Задача' : 'Новая задача';
    els.taskTitle.value = t?.title || '';
    els.taskNote.value = t?.note || '';
    els.taskDate.value = t?.due || '';
    setPrio(t?.prio || 0);
    els.sheetDelete.hidden = !t;

    els.sheet.hidden = false;
    els.backdrop.hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => {
      els.sheet.classList.add('show');
      els.backdrop.classList.add('show');
    });
    setTimeout(() => els.taskTitle.focus({ preventScroll: true }), 380);
  }

  function closeSheet() {
    els.sheet.classList.remove('show');
    els.backdrop.classList.remove('show');
    document.body.classList.remove('sheet-open');
    els.taskTitle.blur();
    setTimeout(() => { els.sheet.hidden = true; els.backdrop.hidden = true; els.sheet.style.bottom = ''; }, 420);
  }

  els.fab.addEventListener('click', () => openSheet());
  els.sheetCancel.addEventListener('click', closeSheet);
  els.backdrop.addEventListener('click', closeSheet);

  els.sheet.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = els.taskTitle.value.trim();
    if (!title) { els.taskTitle.focus(); return; }
    const data = { title, note: els.taskNote.value.trim(), due: els.taskDate.value, prio: getPrio() };
    if (editingId) {
      Object.assign(state.tasks.find((x) => x.id === editingId), data);
    } else {
      state.tasks.push({ id: uid(), ...data, done: false, createdAt: Date.now(), completedAt: null });
    }
    save(); render(); closeSheet();
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
      if (dy > 90) closeSheet();
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
  function showToast(text) {
    els.toastText.textContent = text;
    els.toast.hidden = false;
    els.toastAction.hidden = !lastDeleted;
    requestAnimationFrame(() => els.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    els.toast.classList.remove('show');
    clearTimeout(toastTimer);
    setTimeout(() => { els.toast.hidden = true; }, 260);
  }
  els.toastAction.addEventListener('click', restore);

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

  /* ---------------- service worker ---------------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      const ready = () => {
        if (!localStorage.getItem('pwa-tasks:hint-shown')) {
          els.swHint.hidden = false;
          localStorage.setItem('pwa-tasks:hint-shown', '1');
          setTimeout(() => { els.swHint.hidden = true; }, 9000);
        }
      };
      if (reg.active) ready();
      else reg.addEventListener('updatefound', () => {
        reg.installing?.addEventListener('statechange', (e) => {
          if (e.target.state === 'activated') ready();
        });
      });
    }).catch(() => { /* например, file:// — молча пропускаем */ });
  }

  /* ---------------- ярлык «Новая задача» (?new=1) ---------------- */
  if (new URLSearchParams(location.search).get('new') === '1') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openSheet(), 300);
  }

  els.list.querySelectorAll('.row').forEach(bindSwipe);
  // делегируем bindSwipe для новых строк
  const mo = new MutationObserver(() => {
    els.list.querySelectorAll('.row:not([data-swipe])').forEach((r) => { r.dataset.swipe = '1'; bindSwipe(r); });
  });
  mo.observe(els.list, { childList: true });

  render();
})();
