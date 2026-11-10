// Сверка PHP-математики с Node-референсом (RFC + подпись ECDSA)
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync("/tmp/crypto-in.json", "utf8"));
const raw = readFileSync("/tmp/crypto-out.txt", "utf8")
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => JSON.parse(l));

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

const b64u2buf = (s) => Buffer.from(s, "base64url");
const privKeyObj = crypto.createPrivateKey({ format: "jwk", key: input.privJwk });

// 1. ec_mul(G, d) == публичный ключ Node
const pubLine = raw[0];
const nodePub = crypto.createPublicKey({ format: "jwk", key: input.pubJwk });
const nodePubRaw = nodePub.export({ format: "der", type: "spki" });
const phpPubRaw = Buffer.from(pubLine.pubRawB64, "base64");
check("ec_mul(G,d): точка совпадает с Node", phpPubRaw.equals(nodePubRaw.subarray(nodePubRaw.length - 65)));

// 2. ECDH: PHP-секрет == Node-секрет (priv PHP × pub peer)
// peer сгенерирован в gen-crypto-input.mjs — пересоздаём его приватник? Нет: peer в input — публичная точка.
// Секрет на стороне peer-приватника должен совпасть. Для этого восстановим peer-приватник невозможно —
// поэтому сверяем иначе: PHP делил (peerPub × privPHP). Node посчитает (peerPub × privPHP) тем же ECDH.
const ecdh = crypto.createECDH("prime256v1");
const dBuf = b64u2buf(input.privJwk.d);
ecdh.setPrivateKey(dBuf);
const sharedNode = ecdh.computeSecret(nodePubRaw.subarray(nodePubRaw.length - 65));
const sharedLine = raw.find((o) => o.sharedHex);
check("ECDH секрет совпадает", sharedLine && sharedLine.sharedHex === sharedNode.toString("hex"), `php=${sharedLine?.sharedHex} node=${sharedNode.toString("hex")}`);

// 3. ECDSA: проверяем подпись PHP публичным ключом
const sigLine = raw.find((o) => o.sigB64url);
const sig = b64u2buf(sigLine.sigB64url);
const ok = crypto.verify("sha256", Buffer.from(sigLine.msg), { key: privKeyObj, dsaEncoding: "ieee-p1363" }, sig);
check("ECDSA ES256 подпись валидна (Node verify)", ok);

// 4. HKDF RFC 5869 A.1
const hkdfLine = raw.find((o) => o.hkdfA1);
check(
  "HKDF-SHA256 == RFC 5869 A.1",
  hkdfLine.hkdfA1 === "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
);

// 5. Режим математики
check("Математика через GMP", pubLine.mode === "gmp", pubLine.mode);

// 6. Режим BCMath: те же значения другим путём
const bcLine = raw.find((o) => o.bcPubRawB64);
if (bcLine) {
  check(
    "BCMath: точка совпадает",
    Buffer.from(bcLine.bcPubRawB64, "base64").equals(phpPubRaw)
  );
  check(
    "BCMath: ECDH совпадает",
    bcLine.bcSharedHex === sharedNode.toString("hex")
  );
  check(
    "BCMath: ECDSA подпись валидна",
    crypto.verify("sha256", Buffer.from(sigLine.msg), { key: privKeyObj, dsaEncoding: "ieee-p1363" }, b64u2buf(bcLine.bcSigB64url))
  );
}

console.log(`\nИТОГ: pass=${pass}, fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
