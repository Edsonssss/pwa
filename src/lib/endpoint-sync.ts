/**
 * Синхронизация данных с сервером через простой HTTP-эндпоинт.
 *
 * Архитектура (серверного приложения нет — только статические файлы):
 *  - приложение хранит данные в localStorage устройства (local-store.ts);
 *  - при каждом изменении данные помечаются «грязными» и через несколько секунд
 *    (а также при закрытии приложения) отправляются на эндпоинт одним POST-запросом;
 *  - при запуске приложение читает данные с эндпоинта и, если на сервере они
 *    свежее локальных, загружает их на устройство.
 *
 * Эндпоинт — это файл api.php в папке приложения на хостинге (ediai.ru/pwa/api.php).
 * Он хранит данные в JSON-файле рядом с собой и требует ключ синхронизации
 * (заголовок X-Sync-Key). Запасной вариант — Cloudflare Worker с тем же протоколом
 * (deploy/worker.js): токен GitHub тогда хранится в Worker'е, а не на устройстве.
 *
 * Ключ и адрес эндпоинта по умолчанию вшиваются при сборке (next.config.ts,
 * переменные NEXT_PUBLIC_SYNC_URL / NEXT_PUBLIC_SYNC_KEY) и могут быть
 * переопределены в настройках приложения (localStorage этого устройства).
 */
import { exportAll, importAll, statsAll, subscribeDataChanges } from "./local-store";

/* --------------------------------- конфиг --------------------------------- */

export interface SyncConfig {
  /** Полный адрес эндпоинта, например https://ediai.ru/pwa/api.php */
  url: string;
  /** Ключ синхронизации (задаётся в api.php, константа SYNC_KEY) */
  key: string;
  auto: boolean;
}

const CONFIG_KEY = "planner.sync.v2";
const LAST_SYNC_KEY = "planner.sync.lastAt";
const DIRTY_KEY = "planner.sync.dirty";

export const SYNC_DEFAULTS: SyncConfig = {
  url: process.env.NEXT_PUBLIC_SYNC_URL ?? "",
  key: process.env.NEXT_PUBLIC_SYNC_KEY ?? "",
  auto: true,
};

export function loadSyncConfig(): SyncConfig {
  if (typeof window === "undefined") return { ...SYNC_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<SyncConfig>) : {};
    const str = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() ? v.trim() : fallback;
    return {
      url: str(parsed.url, SYNC_DEFAULTS.url),
      key: str(parsed.key, SYNC_DEFAULTS.key),
      auto: parsed.auto !== false,
    };
  } catch {
    return { ...SYNC_DEFAULTS };
  }
}

export function saveSyncConfig(patch: Partial<SyncConfig>): SyncConfig {
  const next = { ...loadSyncConfig(), ...patch };
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  refreshStatusMeta();
  return next;
}

export function isSyncConfigured(cfg = loadSyncConfig()): boolean {
  return /^https?:\/\//i.test(cfg.url);
}

/* ------------------------------ статус-стор ------------------------------- */

export type SyncState = "idle" | "syncing" | "ok" | "error";

export interface SyncStatus {
  state: SyncState;
  message: string;
  /** ISO-время последней успешной синхронизации (или null). */
  at: string | null;
  /** Есть ли локальные изменения, ещё не отправленные на сервер. */
  dirty: boolean;
  hasKey: boolean;
  configured: boolean;
}

let status: SyncStatus = {
  state: "idle",
  message: "Синхронизация не настроена",
  at: null,
  dirty: false,
  hasKey: false,
  configured: false,
};

const statusListeners = new Set<() => void>();

export function subscribeSyncStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

export function getSyncStatus(): SyncStatus {
  return status;
}

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  statusListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // слушатель не должен ломать синхронизацию
    }
  });
}

function refreshStatusMeta(): void {
  const cfg = loadSyncConfig();
  let dirty = false;
  let at: string | null = null;
  try {
    dirty = window.localStorage.getItem(DIRTY_KEY) === "1";
    at = window.localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    // localStorage недоступен
  }
  setStatus({
    dirty,
    at: at && at !== "" ? at : null,
    hasKey: !!cfg.key,
    configured: isSyncConfigured(cfg),
  });
}

/* ------------------------------ HTTP-транспорт ----------------------------- */

function endpointUrl(cfg: SyncConfig, action?: string): string {
  const base = cfg.url.trim().replace(/\/+$/, "");
  return action ? `${base}?action=${encodeURIComponent(action)}` : base;
}

function apiHeaders(cfg: SyncConfig, withBody = false): Record<string, string> {
  const headers: Record<string, string> = { "X-Sync-Key": cfg.key };
  if (withBody) headers["Content-Type"] = "application/json; charset=utf-8";
  return headers;
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  return fetch(url, { ...init, signal, cache: "no-store" });
}

function friendlyError(httpStatus: number, method: "GET" | "POST"): string {
  switch (httpStatus) {
    case 401:
    case 403:
      return "Неверный ключ синхронизации — сверьте его со значением SYNC_KEY в api.php";
    case 404:
      return method === "POST"
        ? "Эндпоинт не найден — проверьте адрес api.php"
        : "На сервере ещё нет файла данных";
    case 405:
      return "Сервер не принимает такой метод запроса";
    case 413:
      return "Файл данных слишком большой для сервера";
    default:
      return `Ошибка сервера синхронизации (HTTP ${httpStatus})`;
  }
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/* --------------------------- метки времени / счёт --------------------------- */

function stampOf(payload: unknown): string {
  const p = payload as { exportedAt?: unknown; updatedAt?: unknown } | null;
  if (p && typeof p === "object") {
    if (typeof p.exportedAt === "string" && p.exportedAt) return p.exportedAt;
    if (typeof p.updatedAt === "string" && p.updatedAt) return p.updatedAt;
  }
  return "";
}

function countPayload(payload: unknown): { users: number; reminders: number; links: number } {
  const p = payload as { data?: unknown } | null;
  const data = (
    p && typeof p === "object" && p.data ? p.data : payload
  ) as { users?: unknown[]; reminders?: unknown[]; links?: unknown[] } | null;
  if (!data || typeof data !== "object") return { users: 0, reminders: 0, links: 0 };
  return {
    users: Array.isArray(data.users) ? data.users.length : 0,
    reminders: Array.isArray(data.reminders) ? data.reminders.length : 0,
    links: Array.isArray(data.links) ? data.links.length : 0,
  };
}

/* ------------------------------ флаги занятости ---------------------------- */

let pullBusy = false;
let pushBusy = false;
/** Подавление пометки «грязно» во время записи данных, пришедших с сервера. */
let applyingRemote = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function getLocalFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocalFlag(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // localStorage недоступен
  }
}

/* --------------------------------- загрузка -------------------------------- */

export type PullResult = "applied" | "current" | "missing" | "conflict";

/**
 * Читает файл данных с сервера и при необходимости применяет его на устройстве.
 * force = применить безусловно (по кнопке «с заменой»).
 */
export async function pullFromServer(
  opts: { force?: boolean; timeoutMs?: number } = {}
): Promise<PullResult> {
  const cfg = loadSyncConfig();
  if (!isSyncConfigured(cfg)) {
    setStatus({ state: "idle", message: "Укажите адрес сервера синхронизации" });
    throw new Error("Синхронизация не настроена");
  }
  if (pullBusy) throw new Error("Загрузка уже выполняется");
  pullBusy = true;
  const timeoutMs = opts.timeoutMs ?? 15000;
  setStatus({ state: "syncing", message: "Проверяем данные на сервере…" });
  try {
    const res = await fetchWithTimeout(
      endpointUrl(cfg, "db"),
      { headers: apiHeaders(cfg) },
      timeoutMs
    );
    if (res.status === 404) {
      refreshStatusMeta();
      setStatus({
        state: "ok",
        message: "На сервере ещё нет файла данных — он появится при первой отправке",
      });
      return "missing";
    }
    if (!res.ok) throw new Error(friendlyError(res.status, "GET"));
    const text = await res.text();
    if (!text) throw new Error("Файл данных на сервере пуст");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Файл данных на сервере повреждён (не является JSON)");
    }

    const stamp = stampOf(payload);
    const last = getLocalFlag(LAST_SYNC_KEY) ?? "";
    const dirty = getLocalFlag(DIRTY_KEY) === "1";
    const counts = countPayload(payload);
    const total = counts.users + counts.reminders + counts.links;
    const firstSync = last === "";

    if (dirty && !opts.force) {
      refreshStatusMeta();
      setStatus({
        state: "ok",
        message: "На сервере есть данные, но и на устройстве есть несохранённые изменения — отправьте их или загрузите с заменой",
      });
      return "conflict";
    }
    if (!opts.force && !firstSync && stamp && stamp <= last) {
      refreshStatusMeta();
      setStatus({ state: "ok", message: "Данные актуальны — на сервере ничего нового" });
      return "current";
    }
    if (opts.force) {
      // применение по явной кнопке — без условий
    } else if (firstSync && total === 0) {
      refreshStatusMeta();
      setStatus({
        state: "ok",
        message: "На сервере пока пусто — локальные данные будут отправлены при первой синхронизации",
      });
      return "current";
    } else if (firstSync) {
      const local = await statsAll();
      if (local.users + local.reminders + local.links > 0) {
        refreshStatusMeta();
        setStatus({
          state: "ok",
          message: "Данные есть и на сервере, и на устройстве — выберите: отправить локальные или загрузить с заменой",
        });
        return "conflict";
      }
      // устройство пустое — восстанавливаем данные с сервера
    }

    applyingRemote = true;
    try {
      await importAll(payload);
    } finally {
      applyingRemote = false;
    }
    setLocalFlag(LAST_SYNC_KEY, stamp || new Date().toISOString());
    setLocalFlag(DIRTY_KEY, null);
    refreshStatusMeta();
    setStatus({ state: "ok", message: "Данные с сервера загружены на устройство" });
    return "applied";
  } catch (e) {
    const offline = e instanceof TypeError; // сетевая ошибка / CORS
    setStatus({
      state: "error",
      message: offline ? "Сервер синхронизации недоступен" : messageOf(e, "Не удалось связаться с сервером"),
    });
    throw e;
  } finally {
    pullBusy = false;
  }
}

/* --------------------------------- отправка -------------------------------- */

/**
 * Упаковывает локальные данные в JSON и отправляет на сервер одним POST-запросом.
 */
export async function pushToServer(opts: { timeoutMs?: number } = {}): Promise<"pushed"> {
  const cfg = loadSyncConfig();
  if (!isSyncConfigured(cfg)) throw new Error("Синхронизация не настроена");
  if (!cfg.key) {
    setStatus({ state: "error", message: "Для отправки данных нужен ключ синхронизации" });
    throw new Error("Нужен ключ синхронизации");
  }
  if (pushBusy) throw new Error("Отправка уже выполняется");
  pushBusy = true;
  const timeoutMs = opts.timeoutMs ?? 15000;
  setStatus({ state: "syncing", message: "Отправляем данные на сервер…" });
  try {
    const snapshot = await exportAll();
    const res = await fetchWithTimeout(
      endpointUrl(cfg),
      {
        method: "POST",
        headers: apiHeaders(cfg, true),
        body: JSON.stringify(snapshot),
        keepalive: true,
      },
      timeoutMs
    );
    if (!res.ok) throw new Error(friendlyError(res.status, "POST"));
    setLocalFlag(LAST_SYNC_KEY, snapshot.exportedAt);
    setLocalFlag(DIRTY_KEY, null);
    refreshStatusMeta();
    setStatus({ state: "ok", message: "Данные отправлены на сервер" });
    return "pushed";
  } catch (e) {
    const offline = e instanceof TypeError;
    setStatus({
      state: "error",
      message: offline ? "Сервер синхронизации недоступен" : messageOf(e, "Не удалось отправить данные на сервер"),
    });
    throw e;
  } finally {
    pushBusy = false;
  }
}

/* -------------------------------- проверка --------------------------------- */

/** Проверяет эндпоинт и ключ (кнопка «Сохранить и проверить»). */
export async function testConnection(timeoutMs = 12000): Promise<string> {
  const cfg = loadSyncConfig();
  if (!isSyncConfigured(cfg)) throw new Error("Укажите адрес сервера синхронизации");
  try {
    const res = await fetchWithTimeout(
      endpointUrl(cfg, "status"),
      { headers: apiHeaders(cfg) },
      timeoutMs
    );
    if (!res.ok) throw new Error(friendlyError(res.status, "GET"));
    let name = "";
    try {
      const j = (await res.json()) as { app?: string; php?: string };
      if (j && typeof j.php === "string") name = ` · PHP ${j.php}`;
    } catch {
      // ответ не JSON — эндпоинт есть, но отвечает не тем форматом
    }
    const msg = `Сервер синхронизации работает${name}`;
    setStatus({ state: "ok", message: msg });
    return msg;
  } catch (e) {
    const offline = e instanceof TypeError;
    setStatus({
      state: "error",
      message: offline ? "Сервер синхронизации недоступен" : messageOf(e, "Не удалось подключиться к серверу"),
    });
    throw e;
  }
}

/* ------------------------- автоматическая работа --------------------------- */

/** Подписывает автосинхронизацию на изменения локальных данных. Вызвать один раз. */
export function initDataSync(): () => void {
  return subscribeDataChanges(() => {
    if (applyingRemote) return;
    const cfg = loadSyncConfig();
    if (!isSyncConfigured(cfg) || !cfg.key) {
      refreshStatusMeta();
      return;
    }
    setLocalFlag(DIRTY_KEY, "1");
    refreshStatusMeta();
    if (!cfg.auto) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void pushToServer().catch(() => undefined);
    }, 8000);
  });
}

/** Отправляет несохранённые изменения немедленно (закрытие/сворачивание приложения). */
export function flushSync(): void {
  if (getLocalFlag(DIRTY_KEY) !== "1") return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  void pushToServer().catch(() => undefined);
}

/**
 * Запуск при старте приложения: подтягивает свежие данные с сервера или,
 * если есть несохранённые изменения, отправляет их. Безопасно при первом
 * запуске: пустой сервер не затирает данные устройства.
 */
export async function bootSync(): Promise<void> {
  refreshStatusMeta();
  const cfg = loadSyncConfig();
  if (!isSyncConfigured(cfg)) return;
  try {
    const dirty = getLocalFlag(DIRTY_KEY) === "1";
    if (dirty && cfg.key) {
      await pushToServer({ timeoutMs: 8000 });
      return;
    }
    const result = await pullFromServer({ timeoutMs: 8000 });
    if (result === "missing") {
      // на сервере пусто — выгружаем локальные данные как первую версию
      const local = await statsAll();
      if (local.users + local.reminders + local.links > 0 && cfg.key) {
        await pushToServer({ timeoutMs: 8000 });
      } else if (local.users + local.reminders + local.links > 0) {
        setStatus({
          state: "ok",
          message: "Есть данные для отправки — укажите ключ синхронизации в настройках",
        });
      }
    }
  } catch {
    // ошибка уже отражена в статусе синхронизации
  }
}
