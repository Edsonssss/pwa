/**
 * Тест push-sender: dry-run, окно отправки, часовые пояса, удаление
 * недействительных подписок. Запуск: node scripts/test-push-sender.mjs
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = "/tmp/push-test";
const STORAGE = path.join(ROOT, "storage");
const SENDER = "/home/z/my-project/deploy/push-sender/push-sender.mjs";
const CONFIG = "/home/z/my-project/deploy/push-sender/config.example.json";

// валидная клиентская подписка (настоящий ключ P-256): шифрование проходит,
// запрос реально уходит в push-сервис, где фиктивный токен получает 404/410
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = publicKey.export({ type: "spki", format: "der" });
const rawPoint = spki.subarray(spki.length - 65); // несжатая точка кривой (65 байт)
const CLIENT_P256DH = b64url(rawPoint);
const CLIENT_AUTH = b64url(randomBytes(16));

// VAPID-ключи (та же пара, что в deploy/api.php)
const VAPID = {
  publicKey:
    "BAWVggx3TiOGr6UxJIqhOpoMgpA_lFOt7lLlsBI3vthuqhCIXtjnmrY8Dh17bqjvtVbi6GspUxc4LSyGsyNDgkw",
  privateKey: "82SECMIZofEI-kGPVwhvAHGwDCSkW6ZuNQoWToi0e78",
};

// «Устройство в Самаре» (UTC+4)
const TZ = 240;
const now = Date.now();
// локальное время устройства (wall clock) в формате YYYY-MM-DD / HH:MM
function localParts(ms) {
  const d = new Date(ms + TZ * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// --- готовим фикстуры ---
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(STORAGE, { recursive: true });

const due = localParts(now - 2 * 60000); // наступило 2 минуты назад
const future = localParts(now + 3 * 3600000); // через 3 часа
const old = localParts(now - 40 * 60000); // 40 минут назад — вне окна 15 мин

const db = {
  app: "ezhednik",
  version: 1,
  exportedAt: new Date(now).toISOString(),
  data: {
    users: [{ id: "u1", name: "Иван", color: "#0d9488", hasPin: false, createdAt: new Date(now).toISOString() }],
    reminders: [
      { id: "r-due", userId: "u1", title: "Позвонить в банк", note: "", date: due.date, time: due.time, priority: "high", completed: false, createdAt: "", updatedAt: "", completedAt: null },
      { id: "r-future", userId: "u1", title: "Будущее дело", note: "", date: future.date, time: future.time, priority: "normal", completed: false, createdAt: "", updatedAt: "", completedAt: null },
      { id: "r-old", userId: "u1", title: "Просроченное (вне окна)", note: "", date: old.date, time: old.time, priority: "normal", completed: false, createdAt: "", updatedAt: "", completedAt: null },
      { id: "r-done", userId: "u1", title: "Выполненное", note: "", date: due.date, time: due.time, priority: "normal", completed: true, createdAt: "", updatedAt: "", completedAt: null },
      { id: "r-other", userId: "u2", title: "Чужой профиль", note: "", date: due.date, time: due.time, priority: "normal", completed: false, createdAt: "", updatedAt: "", completedAt: null },
      { id: "r-notime", userId: "u1", title: "Без времени", note: "", date: due.date, time: null, priority: "normal", completed: false, createdAt: "", updatedAt: "", completedAt: null },
    ],
    links: [],
  },
};
writeFileSync(path.join(STORAGE, "db.json"), JSON.stringify(db, null, 2));

const subs = {
  "https://fcm.googleapis.com/fcm/send/FAKE-TOKEN-1": {
    endpoint: "https://fcm.googleapis.com/fcm/send/FAKE-TOKEN-1",
    keys: { p256dh: CLIENT_P256DH, auth: CLIENT_AUTH },
    userId: "u1",
    userName: "Иван (iPhone)",
    tzOffsetMin: TZ,
    updatedAt: new Date(now).toISOString(),
  },
};
writeFileSync(path.join(STORAGE, "push-subscriptions.json"), JSON.stringify(subs, null, 2));

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
cfg.storageDir = STORAGE;
writeFileSync(path.join(ROOT, "config.json"), JSON.stringify(cfg, null, 2));

function runSender(extraArgs = []) {
  return execFileSync("node", [SENDER, "--config", path.join(ROOT, "config.json"), ...extraArgs], {
    encoding: "utf8",
    timeout: 60000,
  });
}

console.log("\n[1] dry-run: должен «отправить» только напоминание r-due");
const dry = runSender(["--dry-run"]);
check("r-due в dry-run", dry.includes("r-due") || dry.includes("Позвонить в банк"), dry);
check("r-future пропущено", !dry.includes("Будущее дело"), dry);
check("r-old вне окна", !dry.includes("Просроченное"), dry);
check("r-done пропущено", !dry.includes("Выполненное"), dry);
check("r-other пропущено", !dry.includes("Чужой профиль"), dry);
check("r-notime пропущено", !dry.includes("Без времени"), dry);
check("состояние не записано в dry-run", !existsSync(path.join(STORAGE, "push-state.json")));

console.log("\n[2] повторный dry-run: дубликата нет (state не писался, но это dry-run — повтор допустим)");
const dry2 = runSender(["--dry-run"]);
check("dry-run повторяем", dry2.includes("Позвонить в банк"));

console.log("\n[3] реальная отправка: фейковый endpoint → ошибка сервера, подписка удаляется");
let realOut = "";
let realErrCode = 0;
try {
  realOut = runSender([]);
} catch (e) {
  realErrCode = e.status ?? 1;
  realOut = String(e.stdout ?? "") + String(e.stderr ?? "");
}
// ожидаем сообщение об удалении недействительной подписки (FCM отвечает 4xx на фиктивный токен)
check("подписка удалена как недействительная", realOut.includes("недействительна") || realOut.includes("ошибка"), realOut);
const stateFile = path.join(STORAGE, "push-state.json");
const subsAfter = JSON.parse(readFileSync(path.join(STORAGE, "push-subscriptions.json"), "utf8"));
check(
  "после ошибки отправки подписок стало меньше",
  Object.keys(subsAfter).length === 0,
  JSON.stringify(Object.keys(subsAfter))
);

console.log(`\nИТОГ: pass=${pass}, fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
