// Генерирует входные данные для test-php-crypto.php (P-256 пара + сообщение)
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";

const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const privJwk = kp.privateKey.export({ format: "jwk" });
const pubJwk = kp.publicKey.export({ format: "jwk" });
const x = Buffer.from(pubJwk.x, "base64url");
const y = Buffer.from(pubJwk.y, "base64url");
const peerRaw = Buffer.concat([Buffer.from([0x04]), x, y]);

writeFileSync(
  "/tmp/crypto-in.json",
  JSON.stringify({
    privB64url: privJwk.d,
    peerB64url: peerRaw.toString("base64url"),
    msg: "test-message-2026",
    privJwk,
    pubJwk,
  })
);
console.log("input written");
