<?php
/**
 * Модульная проверка математики push-sender.php против референса Node.js.
 * Выводит JSON с результатами; сравнение делает scripts/test-php-crypto-verify.mjs.
 * Запуск: /путь/к/php scripts/test-php-crypto.php "$(node scripts/gen-crypto-input.mjs && cat /tmp/crypto-in.json)"
 */
define('PUSH_SENDER_NO_RUN', true);
require __DIR__ . '/../deploy/push-sender/push-sender.php';

$in = json_decode($argv[1] ?? '{}', true) ?: [];

// 1. ec_mul(G, d): публичная точка приватного ключа d (режим по умолчанию: GMP|BCMath)
$dBin = b64url_decode($in['privB64url']);
$g = [Math::fromBin(hex2bin(P256_GX_HEX)), Math::fromBin(hex2bin(P256_GY_HEX))];
$pub = ec_mul($g, $dBin);
$pubRaw = "\x04" . Math::toBin($pub[0], 32) . Math::toBin($pub[1], 32);
echo json_encode([
    'mode'      => Math::$mode,
    'pubRawB64' => base64_encode($pubRaw),
], JSON_UNESCAPED_SLASHES), "\n";

// 2. ECDH: общий секрет с внешней точкой (peer pub из Node)
if (isset($in['peerB64url'])) {
    $peer = b64url_decode($in['peerB64url']);
    $shared = ecdh_secret($peer, $dBin);
    echo json_encode(['sharedHex' => bin2hex($shared ?? '')]), "\n";
}

// 3. ECDSA: подпись фиксированного сообщения
if (isset($in['msg'])) {
    $sig = ecdsa_sign(hash('sha256', $in['msg'], true), $dBin);
    echo json_encode(['sigB64url' => b64url_encode($sig), 'msg' => $in['msg']]), "\n";
}

// 4. HKDF против RFC 5869 тест-вектора (A.1, SHA-256)
$v = hkdf_sha256(
    hex2bin('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
    hex2bin('000102030405060708090a0b0c'),
    hex2bin('f0f1f2f3f4f5f6f7f8f9'),
    42
);
echo json_encode(['hkdfA1' => bin2hex($v)]), "\n";

// 5. encrypt_payload: шифрование для заданной подписки (расшифрует Node в e2e-тесте)
if (isset($in['recvB64url'], $in['authB64url'])) {
    $record = encrypt_payload(b64url_decode($in['recvB64url']), b64url_decode($in['authB64url']),
        '{"title":"Проверка","body":"14:30 · Дело","tag":"r1","url":"https://ediai.ru/pwa/"}');
    echo json_encode(['recordB64' => base64_encode($record)]), "\n";
}

// 6. Повтор тех же операций в режиме BCMath (запасной путь без GMP)
if (function_exists('bcmod')) {
    Math::$mode = 'bc';
    $pub2 = ec_mul($g, $dBin);
    $pubRaw2 = "\x04" . Math::toBin($pub2[0], 32) . Math::toBin($pub2[1], 32);
    $out = [
        'mode'        => Math::$mode,
        'bcPubRawB64' => base64_encode($pubRaw2),
    ];
    if (isset($in['peerB64url'])) {
        $out['bcSharedHex'] = bin2hex(ecdh_secret(b64url_decode($in['peerB64url']), $dBin) ?? '');
    }
    if (isset($in['msg'])) {
        $out['bcSigB64url'] = b64url_encode(ecdsa_sign(hash('sha256', $in['msg'], true), $dBin));
    }
    echo json_encode($out, JSON_UNESCAPED_SLASHES), "\n";
}
