#!/usr/bin/env node
/**
 * Ежедневник PWA — отправка push-напоминаний в назначенное время.
 *
 * Запускается по cron на хостинге каждую минуту:
 *     * * * * * cd /путь/к/push-sender && /usr/bin/node push-sender.mjs >> push-sender.log 2>&1
 *
 * Что делает:
 *  1. Читает storage/db.json        — снапшот данных, синхронизированный с устройства;
 *     storage/push-subscriptions.json — подписки устройств (пишет api.php);
 *     storage/push-state.json       — какие напоминания уже отправлены.
 *  2. Для каждой подписки находит напоминания профиля этого устройства,
 *     срок которых наступил (с учётом часового пояса устройства tzOffsetMin),
 *     и отправляет Web Push через сервисы Apple (web.push.apple.com).
 *  3. Помечает отправленное в push-state.json (защита от повторов), удаляет
 *     недействительные подписки (HTTP 404/410).
 *
 * Настройки — config.json рядом со скриптом (образец: config.example.json).
 * Проверка без отправки: node push-sender.mjs --dry-run
 */
import { sendNotification, setVapidDetails } from "web-push";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------- аргументы ------------------------------- */

function parseArgs(argv) {
  const args = {
    config: path.join(HERE, "config.json"),
    dryRun: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--config" && argv[i + 1]) args.config = argv[(i += 1)];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log("Использование: node push-sender.mjs [--config путь/config.json] [--dry-run] [--quiet]");
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

/* -------------------------------- конфиг --------------------------------- */

const DEFAULT_CONFIG = {
  // папка storage приложения (рядом с api.php на хостинге)
  storageDir: path.join(HERE, "..", "pwa", "storage"),
  // адрес приложения для перехода по нажатию на уведомление
  appUrl: "https://ediai.ru/pwa/",
  // VAPID-ключи: та же ПАРА, что в api.php (публичный) — приватный только здесь
  vapid: {
    publicKey: "",
    privateKey: "",
    subject: "mailto:admin@ediai.ru",
  },
  // окно отправки: напоминание, «просроченное» не более чем на N минут,
  // всё ещё доставляется (если сервер/сеть были недоступны в точный момент)
  windowMinutes: 15,
  // подписки, не обновлявшиеся столько дней, считаются устаревшими
  staleSubscriptionDays: 60,
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const fileConfig = loadJson(args.config, {}) ?? {};
const cfg = {
  ...DEFAULT_CONFIG,
  ...fileConfig,
  vapid: { ...DEFAULT_CONFIG.vapid, ...(fileConfig.vapid ?? {}) },
};

if (!cfg.vapid.publicKey || !cfg.vapid.privateKey) {
  console.error(
    "[push-sender] Не заданы VAPID-ключи. Скопируйте config.example.json в config.json и впишите публичный и приватный ключи (та же пара, что в api.php)."
  );
  process.exit(1);
}

/* -------------------------------- утилиты -------------------------------- */

function log(msg) {
  if (args.quiet && !msg.startsWith("[ошибка]")) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts}  ${msg}`);
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, file);
}

/* -------------------------------- данные --------------------------------- */

const storageDir = path.resolve(cfg.storageDir);
const dbFile = path.join(storageDir, "db.json");
const subsFile = path.join(storageDir, "push-subscriptions.json");
const stateFile = path.join(storageDir, "push-state.json");

const db = loadJson(dbFile, null);
const reminders =
  db && db.data && Array.isArray(db.data.reminders) ? db.data.reminders : [];

const subsRaw = loadJson(subsFile, {});
const subs = subsRaw && typeof subsRaw === "object" ? Object.entries(subsRaw) : [];

const stateRaw = loadJson(stateFile, {});
const state = stateRaw && typeof stateRaw === "object" ? stateRaw : {};

if (subs.length === 0) {
  log("push-подписок нет — уведомления ни на одном устройстве не включены (это не ошибка)");
  process.exit(0);
}

setVapidDetails(cfg.vapid.subject, cfg.vapid.publicKey, cfg.vapid.privateKey);

/* ------------------------------ рассылка --------------------------------- */

const now = Date.now();
const windowMs = Math.max(1, Number(cfg.windowMinutes) || 15) * 60000;
const staleMs = Math.max(1, Number(cfg.staleSubscriptionDays) || 60) * 86400000;
let sentCount = 0;
let failCount = 0;
let removedCount = 0;
let pendingCount = 0;

for (const [endpoint, sub] of subs) {
  // устаревшая подписка (устройство давно не обновляло её)
  const updatedAt = Date.parse(sub.updatedAt ?? "");
  if (Number.isFinite(updatedAt) && now - updatedAt > staleMs) {
    delete subsRaw[endpoint];
    removedCount += 1;
    log(`подписка устарела (> ${cfg.staleSubscriptionDays} дн.) — удалена: ${sub.userName || "?"}`);
    continue;
  }

  const tz = Number.isFinite(sub.tzOffsetMin) ? Number(sub.tzOffsetMin) : 0;

  // напоминания профиля этого устройства: не выполненные, со временем
  const candidates = reminders.filter(
    (r) =>
      r &&
      r.userId === sub.userId &&
      r.completed !== true &&
      typeof r.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      typeof r.time === "string" &&
      /^\d{1,2}:\d{2}$/.test(r.time)
  );
  if (candidates.length === 0) continue;

  let subAlive = true;
  for (const r of candidates) {
    if (!subAlive) break;

    // срок по часовому поясу устройства: локальные дата+время → момент UTC
    const [y, m, d] = r.date.split("-").map(Number);
    const [hh, mm] = r.time.split(":").map(Number);
    if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) continue;
    const dueEpoch = Date.UTC(y, m - 1, d, hh, mm) - tz * 60000;

    if (dueEpoch > now) continue; // ещё не наступил
    if (now - dueEpoch > windowMs) continue; // слишком старое — окно упущено
    pendingCount += 1;

    const stateKey = `${r.id}|${r.date}|${r.time}`;
    if (state[stateKey]) continue; // уже отправляли

    const payload = JSON.stringify({
      title: "Ежедневник — напоминание",
      body: `${r.time} · ${r.title}`,
      tag: r.id,
      url: cfg.appUrl,
    });

    if (args.dryRun) {
      log(`[dry-run] отправил бы: ${sub.userName || sub.userId || "?"} ← «${r.title}» (${r.date} ${r.time})`);
      sentCount += 1;
      continue;
    }

    try {
      await sendNotification(
        { endpoint, keys: sub.keys ?? {} },
        payload,
        { TTL: 3600, urgency: "high" }
      );
      state[stateKey] = new Date(now).toISOString();
      sentCount += 1;
      log(`отправлено: ${sub.userName || sub.userId || "?"} ← «${r.title}» (${r.date} ${r.time})`);
    } catch (e) {
      const status = e && (e.statusCode ?? e.status);
      const msg = e && e.message ? String(e.message) : String(e ?? "");
      const invalidKeys = /not valid for specified curve|invalid.{0,20}key/i.test(msg);
      if (status === 404 || status === 410 || invalidKeys) {
        delete subsRaw[endpoint];
        removedCount += 1;
        subAlive = false;
        log(
          `подписка недействительна (${status ? `HTTP ${status}` : "кривые ключи шифрования"}) — удалена: ${sub.userName || "?"}`
        );
      } else {
        failCount += 1;
        subAlive = false; // не долбим эту подписку остальными напоминаниями в этом прогоне
        log(`[ошибка] отправка для ${sub.userName || "?"}: ${e && e.message ? e.message : e}`);
      }
    }
  }
}

/* ------------------------- сохранение состояния --------------------------- */

if (!args.dryRun) {
  // записи старше 30 дней больше не нужны
  const cutoff = now - 30 * 86400000;
  for (const [key, at] of Object.entries(state)) {
    const t = Date.parse(String(at));
    if (Number.isFinite(t) && t < cutoff) delete state[key];
  }
  if (Object.keys(state).length > 0) atomicWriteJson(stateFile, state);
  if (removedCount > 0) atomicWriteJson(subsFile, subsRaw);
}

log(
  `итог: напоминаний «сейчас» ${pendingCount}, отправлено ${sentCount}, ошибок ${failCount}, подписок удалено ${removedCount}`
);
process.exit(0);
