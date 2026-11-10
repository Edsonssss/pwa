/**
 * Сквозной тест push-sender.php:
 *  [1] sender шифрует payload и отправляет на сервер-перехватчик;
 *      Node расшифровывает запись aes128gcm (как браузер) и проверяет VAPID JWT;
 *  [2] повторный запуск не дублирует отправку (push-state.json);
 *  [3] реальный запрос в сервис Google с фиктивным токеном → 404/410
 *      (значит VAPID-подпись и шифрование приняты), подписка удаляется.
 *
 * Важно: сервер-перехватчик и PHP живут в одном процессе Node — PHP
 * запускается через spawn (не execFileSync), чтобы event loop отвечал curl'у.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";

const PHP = "/tmp/php";
const SENDER_SRC = "/home/z/my-project/deploy/push-sender/push-sender.php";
const ROOT = "/tmp/php-push-test";
const STORAGE = `${ROOT}/storage`;
const PORT = 8092;

const VAPID_PUB_B64URL =
  "BAWVggx3TiOGr6UxJIqhOpoMgpA_lFOt7lLlsBI3vthuqhCIXtjnmrY8Dh17bqjvtVbi6GspUxc4LSyGsyNDgkw";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};

const b64u = (b) => Buffer.from(b).toString("base64url");

// --- реальная подписка: ключи P-256, приватник остаётся у «браузера» ---
const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const privJwk = kp.privateKey.export({ format: "jwk" });
const pubJwk = kp.publicKey.export({ format: "jwk" });
const recvPubRaw = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pubJwk.x, "base64url"),
  Buffer.from(pubJwk.y, "base64url"),
]);
const authSecret = crypto.randomBytes(16);

// --- перехватчик push-запросов ---
const captured = [];
const server = http.createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    captured.push({
      url: req.url,
      auth: req.headers.authorization ?? "",
      encoding: req.headers["content-encoding"] ?? "",
      ttl: req.headers.ttl ?? "",
      urgency: req.headers.urgency ?? "",
      ctype: req.headers["content-type"] ?? "",
      expect: req.headers.expect ?? "",
      body: Buffer.concat(body),
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// --- PHP: spawn вместо execFileSync (не блокирует event loop) ---
function runSender() {
  return new Promise((resolve) => {
    const child = spawn(PHP, [`${STORAGE}/push-sender.php`]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", () => resolve(out));
  });
}

// --- расшифровка записи aes128gcm (то же, что делает браузер) ---
function decryptRecord(rec, authSecretBuf) {
  const salt = rec.subarray(0, 16);
  const rs = rec.readUInt32BE(16);
  const idlen = rec[20];
  const ephPubRaw = rec.subarray(21, 21 + idlen);
  const ciphertext = rec.subarray(21 + idlen);

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privJwk.d, "base64url"));
  const shared = ecdh.computeSecret(ephPubRaw);

  const hkdf = (ikm, saltBuf, info, len) => {
    const prk = crypto.createHmac("sha256", saltBuf).update(ikm).digest();
    return expandOnly(prk, info, len);
  };
  const expandOnly = (prk, info, len) => {
    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    let i = 1;
    while (okm.length < len) {
      t = crypto.createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
      okm = Buffer.concat([okm, t]);
      i++;
    }
    return okm.subarray(0, len);
  };
  // RFC 8291: auth-секрет участвует в деривации
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), recvPubRaw, ephPubRaw]);
  const secret = hkdf(shared, authSecretBuf, keyInfo, 32);
  const prk = crypto.createHmac("sha256", salt).update(secret).digest();
  // expand БЕЗ второго extract (prk уже готов)
  const cek = expandOnly(prk, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = expandOnly(prk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);

  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const pt = Buffer.concat([
    d.update(ciphertext.subarray(0, ciphertext.length - 16)),
    d.final(),
  ]);
  // plaintext = контент || 0x02 (пэддинг-разделитель в конце)
  const cut = pt.lastIndexOf(0x02);
  return { rs, idlen, json: pt.subarray(0, cut).toString("utf8") };
}

// --- фикстуры ---
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(STORAGE, { recursive: true });
cpSync(SENDER_SRC, `${STORAGE}/push-sender.php`);

const TZ = 240; // Самара
const now = Date.now();
const p = (n) => String(n).padStart(2, "0");
const shift = new Date(now - 2 * 60000 + TZ * 60000);
const due = {
  date: `${shift.getUTCFullYear()}-${p(shift.getUTCMonth() + 1)}-${p(shift.getUTCDate())}`,
  time: `${p(shift.getUTCHours())}:${p(shift.getUTCMinutes())}`,
};

writeFileSync(
  `${STORAGE}/db.json`,
  JSON.stringify({
    app: "ezhednik",
    version: 1,
    exportedAt: new Date(now).toISOString(),
    data: {
      users: [{ id: "u1", name: "Иван", color: "#0d9488", hasPin: false, createdAt: "" }],
      reminders: [
        { id: "r-due", userId: "u1", title: "Позвонить в банк", note: "", date: due.date, time: due.time, priority: "high", completed: false, createdAt: "", updatedAt: "", completedAt: null },
        { id: "r-future", userId: "u1", title: "Будущее дело", note: "", date: "2030-01-01", time: "09:00", priority: "normal", completed: false, createdAt: "", updatedAt: "", completedAt: null },
        { id: "r-done", userId: "u1", title: "Выполненное", note: "", date: due.date, time: due.time, priority: "normal", completed: true, createdAt: "", updatedAt: "", completedAt: null },
        { id: "r-notime", userId: "u1", title: "Без времени", note: "", date: due.date, time: null, priority: "normal", completed: false, createdAt: "", updatedAt: "", completedAt: null },
      ],
      links: [],
    },
  })
);

const subsFile = `${STORAGE}/push-subscriptions.json`;
const writeSubs = (endpoint) =>
  writeFileSync(
    subsFile,
    JSON.stringify(
      {
        [endpoint]: {
          endpoint,
          keys: { p256dh: b64u(recvPubRaw), auth: b64u(authSecret) },
          userId: "u1",
          userName: "Иван (iPhone)",
          tzOffsetMin: TZ,
          updatedAt: new Date(now).toISOString(),
        },
      },
      null,
      2
    )
  );

const endpoint = `http://127.0.0.1:${PORT}/push/capture`;
writeSubs(endpoint);

/* ============ [1] отправка + расшифровка ============ */
console.log("\n[1] sender → перехватчик: заголовки, JWT, расшифровка payload");
const out1 = await runSender();
check("запрос получен", captured.length === 1, `captured=${captured.length}, log=${out1.trim().split("\n").pop() ?? ""}`);
const cap = captured[0] ?? {};
check("Content-Encoding: aes128gcm", cap.encoding === "aes128gcm", cap.encoding);
check("TTL: 3600", cap.ttl === "3600", cap.ttl);
check("Urgency: high", cap.urgency === "high", cap.urgency);
check("Content-Type: application/octet-stream", cap.ctype === "application/octet-stream", cap.ctype);
check("Expect: 100-continue отсутствует", cap.expect === "", cap.expect);

// Authorization: vapid t=<jwt>, k=<pub>
const m = /^vapid t=([^,]+), k=([^,\s]+)$/.exec(cap.auth ?? "");
check("формат Authorization vapid t=...,k=...", !!m, cap.auth);

if (m) {
  const [h64, c64, s64] = m[1].split(".");
  const jwtPayload = JSON.parse(Buffer.from(c64, "base64url").toString("utf8"));
  check("JWT aud = адрес endpoint", jwtPayload.aud === `http://127.0.0.1:${PORT}`, jwtPayload.aud);
  check("JWT sub = mailto", typeof jwtPayload.sub === "string" && jwtPayload.sub.startsWith("mailto:"), jwtPayload.sub);
  check("JWT exp в будущем", jwtPayload.exp > now / 1000, jwtPayload.exp);
  check("JWT alg ES256", JSON.parse(Buffer.from(h64, "base64url").toString()).alg === "ES256");

  const vapidRaw = Buffer.from(VAPID_PUB_B64URL, "base64url");
  const vapidJwk = {
    kty: "EC",
    crv: "P-256",
    x: vapidRaw.subarray(1, 33).toString("base64url"),
    y: vapidRaw.subarray(33, 65).toString("base64url"),
  };
  const sigOk = crypto.verify(
    "sha256",
    Buffer.from(`${h64}.${c64}`),
    { key: crypto.createPublicKey({ format: "jwk", key: vapidJwk }), dsaEncoding: "ieee-p1363" },
    Buffer.from(s64, "base64url")
  );
  check("VAPID ES256 подпись валидна", sigOk);
  check("k= совпадает с VAPID-ключом", m[2] === VAPID_PUB_B64URL);
}

if (cap.body) {
  try {
    const { rs, idlen, json } = decryptRecord(cap.body, authSecret);
    check("idlen=65 (ключ эфемерной пары в заголовке)", idlen === 65, idlen);
    check("rs в заголовке = 4096", rs === 4096, rs);
    let payload = null;
    try {
      payload = JSON.parse(json);
    } catch {}
    check("payload расшифрован", !!payload, json.slice(0, 80));
    check("payload.title = Ежедневник — напоминание", payload?.title === "Ежедневник — напоминание", payload?.title);
    check("payload.body содержит дело", payload?.body?.includes("Позвонить в банк"), payload?.body);
    check("payload.tag = r-due", payload?.tag === "r-due", payload?.tag);
    check("payload.url = приложение", payload?.url === "https://ediai.ru/pwa/", payload?.url);
  } catch (e) {
    check("payload расшифрован", false, String(e));
  }
}

/* ============ [2] повторный запуск без дублей ============ */
console.log("\n[2] повторный запуск: дублей нет");
captured.length = 0;
await runSender();
check("второй раз ничего не отправлено", captured.length === 0, `captured=${captured.length}`);
check("push-state.json создан", existsSync(`${STORAGE}/push-state.json`));

/* ============ [3] реальный push-сервис Google с фиктивным токеном ============ */
console.log("\n[3] реальный FCM endpoint: ждём 404/410 (подпись VAPID и шифрование приняты)");
rmSync(`${STORAGE}/push-state.json`, { force: true });
const fakeEndpoint = "https://fcm.googleapis.com/fcm/send/FAKE-TOKEN-1";
writeSubs(fakeEndpoint);
const out3 = await runSender();
console.log("  лог:", out3.trim().split("\n").slice(-2).join(" | "));
check(
  "FCM вернул 404/410 → VAPID-подпись PHP принята",
  out3.includes("(HTTP 404)") || out3.includes("(HTTP 410)"),
  out3
);
const subsAfter = JSON.parse(readFileSync(subsFile, "utf8"));
check("подписка после 404/410 удалена", Object.keys(subsAfter).length === 0);

server.close();
console.log(`\nИТОГ: pass=${pass}, fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
