/**
 * Клиент Web Push для PWA «Ежедневник».
 *
 * Как это работает (iPhone, iOS 16.4+):
 *  1. Приложение должно быть установлено на «Экран Домой» (Safari →
 *     «Поделиться» → «На экран „Домой“») — требование iOS, из обычной
 *     вкладки Safari push не приходит.
 *  2. Пользователь включает уведомления в настройках приложения — по
 *     нажатию кнопки iOS показывает системный запрос разрешения.
 *  3. Браузер создаёт подписку (PushManager.subscribe с VAPID-ключом),
 *     она сохраняется на сервере (api.php → storage/push-subscriptions.json).
 *  4. Скрипт push-sender на хостинге (запускается по cron каждую минуту)
 *     находит напоминания, срок которых наступил, и отправляет push через
 *     сервис Apple/Google. Даже если приложение закрыто — уведомление
 *     покажет iOS.
 *
 * Публичный VAPID-ключ приложение получает с сервера (GET api.php?action=push),
 * приватный хранится только в конфиге push-sender на хостинге.
 */
import { isSyncConfigured, loadSyncConfig } from "./endpoint-sync";

const LOCAL_KEY = "planner.push.v1";

export interface PushLocalState {
  enabled: boolean;
  endpoint: string | null;
  enabledAt: string | null;
}

export interface PushSupport {
  /** Браузер вообще умеет Web Push (SW + PushManager + Notification). */
  supported: boolean;
  permission: "granted" | "denied" | "default" | "unsupported";
  /** Приложение запущено с «Экрана Домой» (обязательно для iOS). */
  standalone: boolean;
  isIos: boolean;
  /** Человекочитаемая причина, почему включить сейчас нельзя (или null). */
  blocker: string | null;
}

export interface PushSnapshot {
  support: PushSupport;
  /** Подписка реально существует в браузере. */
  subscribed: boolean;
  /** Локальный флаг включения (совпадает с подпиской). */
  enabled: boolean;
}

export type EnableResult =
  | { ok: true; endpoint: string }
  | { ok: false; error: string };

/* ------------------------------ локальное состояние ------------------------ */

function readLocalState(): PushLocalState {
  if (typeof window === "undefined") return { enabled: false, endpoint: null, enabledAt: null };
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return { enabled: false, endpoint: null, enabledAt: null };
    const parsed = JSON.parse(raw) as Partial<PushLocalState>;
    return {
      enabled: parsed.enabled === true,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : null,
      enabledAt: typeof parsed.enabledAt === "string" ? parsed.enabledAt : null,
    };
  } catch {
    return { enabled: false, endpoint: null, enabledAt: null };
  }
}

function writeLocalState(state: PushLocalState): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch {
    // localStorage недоступен — не критично
  }
}

/* --------------------------------- утилиты --------------------------------- */

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true
  );
}

function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function detectPermission(): PushSupport["permission"] {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

/** Поддержка Web Push в этом браузере и что мешает включить прямо сейчас. */
export function computePushSupport(): PushSupport {
  const hasSw = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const hasPush = typeof window !== "undefined" && "PushManager" in window;
  const hasNotif = typeof window !== "undefined" && typeof Notification !== "undefined";
  const supported = hasSw && hasPush && hasNotif;
  const standalone = isStandalone();
  const isIos = detectIos();
  const permission = hasNotif ? detectPermission() : "unsupported";

  let blocker: string | null = null;
  if (!supported) {
    blocker =
      "Этот браузер не поддерживает push-уведомления. На iPhone используйте Safari (iOS 16.4 или новее).";
  } else if (isIos && !standalone) {
    blocker =
      "Сначала установите приложение на «Экран Домой»: Safari → «Поделиться» → «На экран „Домой“». iOS присылает push только установленному приложению.";
  }

  return { supported, permission, standalone, isIos, blocker };
}

/** Мгновенный снимок состояния (синхронно, для первого рендера). */
export function getLocalPushState(): PushLocalState {
  return readLocalState();
}

/** Полный снимок: поддержка браузера + реальная подписка в Service Worker. */
export async function getPushSnapshot(): Promise<PushSnapshot> {
  const support = computePushSupport();
  let subscribed = false;
  if (support.supported) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      subscribed = !!sub;
    } catch {
      subscribed = false;
    }
  }
  const local = readLocalState();
  return {
    support,
    subscribed,
    enabled: subscribed && local.enabled,
  };
}

/** VAPID-ключ из base64url в Uint8Array (требование PushManager). */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/* ------------------------------ обмен с сервером --------------------------- */

async function apiRequest(
  action: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const cfg = loadSyncConfig();
  if (!isSyncConfigured(cfg) || !cfg.key) {
    throw new Error("Сначала настройте синхронизацию — push использует тот же сервер (api.php)");
  }
  const base = cfg.url.trim().replace(/\/+$/, "");
  const res = await fetch(`${base}?action=${encodeURIComponent(action)}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Sync-Key": cfg.key,
      ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error("Неверный ключ синхронизации (сверьте его в настройках)");
    if (res.status === 404) throw new Error("api.php не отвечает за push — обновите файл api.php на хостинге");
    throw new Error(`Сервер push вернул ошибку (HTTP ${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Публичный VAPID-ключ с сервера (действие action=push в api.php). */
export async function fetchVapidPublicKey(): Promise<string> {
  const data = await apiRequest("push");
  const key = data.publicKey;
  if (typeof key !== "string" || !key) {
    throw new Error("api.php не вернул публичный ключ push — обновите файл api.php на хостинге");
  }
  return key;
}

/* ------------------------------ включение / отключение ---------------------- */

/**
 * Включает push на этом устройстве. Вызывать ТОЛЬКО из обработчика нажатия
 * (iOS показывает системный запрос разрешения и требует действие пользователя).
 */
export async function enablePush(user: { id: string; name: string }): Promise<EnableResult> {
  const support = computePushSupport();
  if (support.blocker) return { ok: false, error: support.blocker };
  if (support.permission === "denied") {
    return {
      ok: false,
      error:
        "Разрешение на уведомления было отклонено. Включите его: Настройки iPhone → Уведомления → «Ежедневник».",
    };
  }

  try {
    // 1. Разрешение системы (обязательно внутри клика)
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return {
        ok: false,
        error:
          "Уведомления не разрешены. Без разрешения iOS не сможет показывать напоминания.",
      };
    }

    // 2. Публичный ключ сервера
    const publicKey = await fetchVapidPublicKey();

    // 3. Service Worker + подписка
    const swPath = process.env.NEXT_PUBLIC_SW_PATH || "/sw.js";
    const reg = await navigator.serviceWorker.register(swPath);
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));

    // 4. Отправляем подписку на сервер (+ часовой пояс устройства для точного времени)
    const raw = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };
    if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) {
      return { ok: false, error: "Браузер вернул неполную подписку — попробуйте ещё раз" };
    }
    await apiRequest("subscribe", {
      endpoint: raw.endpoint,
      keys: raw.keys,
      userId: user.id,
      userName: user.name,
      // минуты к востоку от UTC (например, Самара +240); скрипт отправки
      // считает срок напоминания по времени этого устройства
      tzOffsetMin: -new Date().getTimezoneOffset(),
    });

    writeLocalState({
      enabled: true,
      endpoint: raw.endpoint,
      enabledAt: new Date().toISOString(),
    });
    return { ok: true, endpoint: raw.endpoint };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Не удалось включить уведомления",
    };
  }
}

/** Отключает push: снимает подписку в браузере и на сервере. */
export async function disablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await apiRequest("unsubscribe", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    writeLocalState({ enabled: false, endpoint: null, enabledAt: null });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Не удалось отключить уведомления",
    };
  }
}

/**
 * Тихое обновление часового пояса подписки при запуске приложения
 * (если устройство переехало в другой часовой пояс). Ошибки глушатся:
 * это фоновая операция.
 */
export async function refreshPushTimezone(user: { id: string; name: string }): Promise<void> {
  try {
    const local = readLocalState();
    if (!local.enabled || !local.endpoint) return;
    const support = computePushSupport();
    if (!support.supported) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub || sub.endpoint !== local.endpoint) return;
    const raw = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };
    if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) return;
    await apiRequest("subscribe", {
      endpoint: raw.endpoint,
      keys: raw.keys,
      userId: user.id,
      userName: user.name,
      tzOffsetMin: -new Date().getTimezoneOffset(),
    });
  } catch {
    // фоновое обновление — молча
  }
}
