<?php
/**
 * Ежедневник PWA — отправка push-напоминаний в назначенное время.
 * ЧИСТЫЙ PHP, БЕЗ ЗАВИСИМОСТЕЙ (без composer, без Node.js).
 *
 * Куда положить: в папку storage приложения (рядом с api.php):
 *     …/ediai.ru/pwa/storage/push-sender.php
 * Папка storage закрыта от веба через .htaccess (Require all denied),
 * поэтому приватный ключ в этом файле недоступен из интернета.
 *
 * Запуск по cron из панели хостинга (каждую минуту):
 *     /usr/bin/php /var/www/<пользователь>/data/www/ediai.ru/pwa/storage/push-sender.php
 * (точный путь к php уточните в панели; вывод дописывается в push-sender.log)
 *
 * Что делает:
 *  1. Читает db.json (данные, синхронизированные с устройства) и
 *     push-subscriptions.json (подписки устройств, пишет их api.php).
 *  2. Находит напоминания, срок которых наступил (с учётом часового пояса
 *     устройства tzOffsetMin), и отправляет Web Push — подпись VAPID (ES256)
 *     и шифрование payload по RFC 8291 (aes128gcm) реализованы здесь же.
 *  3. Помечает отправленное в push-state.json (защита от дублей), удаляет
 *     недействительные подписки (HTTP 404/410).
 *
 * Совместимо с PHP 7.4+; нужны расширения openssl (AES-GCM), gmp ИЛИ bcmath,
 * curl (или allow_url_fopen как запасной транспорт).
 */

declare(strict_types=1);

/* ============================ НАСТРОЙКИ ============================ */

/** Приватный VAPID-ключ — ТА ЖЕ ПАРА, что публичный в api.php. */
const VAPID_PRIVATE_KEY = '82SECMIZofEI-kGPVwhvAHGwDCSkW6ZuNQoWToi0e78';
/** Публичный VAPID-ключ (для заголовка Authorization). */
const VAPID_PUBLIC_KEY  = 'BAWVggx3TiOGr6UxJIqhOpoMgpA_lFOt7lLlsBI3vthuqhCIXtjnmrY8Dh17bqjvtVbi6GspUxc4LSyGsyNDgkw';
/** contact для сервисов push (email). */
const VAPID_SUBJECT     = 'mailto:admin@ediai.ru';
/** Адрес приложения — открывается по нажатию на уведомление. */
const APP_URL           = 'https://ediai.ru/pwa/';
/** Окно доставки: напоминание, «просроченное» не более чем на N минут,
 *  всё ещё доставляется (запас на паузу cron). */
const WINDOW_MINUTES    = 15;
/** Подписки, не обновлявшиеся столько дней, считаются устаревшими. */
const STALE_SUB_DAYS    = 60;
/** Заголовок уведомления. */
const PUSH_TITLE        = 'Ежедневник — напоминание';
/** TTL уведомления в push-сервисе, секунд. */
const PUSH_TTL          = 3600;

/* ======================= СЛУЖЕБНЫЕ ПУТИ/ЛОГ ======================= */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("Скрипт выполняется только из cron (PHP CLI)\n");
}

$DATA_DIR   = __DIR__;                      // скрипт лежит в storage/ рядом с db.json
$DB_FILE    = $DATA_DIR . '/db.json';
$SUBS_FILE  = $DATA_DIR . '/push-subscriptions.json';
$STATE_FILE = $DATA_DIR . '/push-state.json';
$LOG_FILE   = $DATA_DIR . '/push-sender.log';
$LOCK_FILE  = $DATA_DIR . '/push-sender.lock';

function logline(string $msg): void {
    global $LOG_FILE;
    $ts = date('Y-m-d H:i:s');
    echo $ts . '  ' . $msg . PHP_EOL;
    @file_put_contents($LOG_FILE, $ts . '  ' . $msg . PHP_EOL, FILE_APPEND | LOCK_EX);
}

/* ------------------------- блокировка параллельного запуска ------------------------- */

$lockFp = @fopen($LOCK_FILE, 'c');
if ($lockFp === false || !@flock($lockFp, LOCK_EX | LOCK_NB)) {
    exit(0); // предыдущий прогон ещё работает — пропускаем
}

/* ========================= JSON-УТИЛИТЫ ========================= */

function load_json(string $file) {
    if (!is_file($file)) return null;
    $raw = @file_get_contents($file);
    if ($raw === false || trim($raw) === '') return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function atomic_write(string $file, string $body): void {
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $body) !== false) {
        @rename($tmp, $file);
    }
    @unlink($tmp);
}

/* ========================= BASE64URL ========================= */

function b64url_decode(string $s): string {
    $pad = strlen($s) % 4;
    if ($pad) $s .= str_repeat('=', 4 - $pad);
    $raw = base64_decode(strtr($s, '-_', '+/'), true);
    return $raw === false ? '' : $raw;
}

function b64url_encode(string $raw): string {
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

/* ==================== МАТЕМАТИКА P-256 (чистый PHP) ====================
 * Большая арифметика: GMP (быстро) или BCMath (есть везде как запасной).
 * Точки кривой — аффинные координаты [x, y]; null = точка на бесконечности.
 */

abstract class Math {
    /** режим: 'gmp' | 'bc' */
    public static string $mode;

    public static function pick(): void {
        self::$mode = function_exists('gmp_init') ? 'gmp' : 'bc';
        if (self::$mode === 'bc' && !function_exists('bcmod')) {
            logline('Нужны расширения gmp или bcmath — ни одного нет в PHP');
            exit(1);
        }
    }

    public static function fromBin(string $bin) {
        if (self::$mode === 'gmp') return gmp_import($bin);
        $n = '0';
        $len = strlen($bin);
        for ($i = 0; $i < $len; $i++) {
            $n = bcadd(bcmul($n, '256'), (string) ord($bin[$i]));
        }
        return $n;
    }

    public static function toBin($n, int $bytes = 32): string {
        if (self::$mode === 'gmp') {
            $raw = gmp_export($n);
        } else {
            $raw = '';
            $n = (string) $n;
            while (bccomp($n, '0') > 0) {
                $q = bcdiv($n, '256', 0);
                $raw = chr((int) bcmod($n, '256')) . $raw;
                $n = $q;
            }
        }
        return $raw === false ? '' : str_pad($raw, $bytes, "\0", STR_PAD_LEFT);
    }

    public static function add($a, $b)  { return self::$mode === 'gmp' ? gmp_add($a, $b) : bcadd((string)$a, (string)$b); }
    public static function sub($a, $b)  { return self::$mode === 'gmp' ? gmp_sub($a, $b) : bcsub((string)$a, (string)$b); }
    public static function mul($a, $b)  { return self::$mode === 'gmp' ? gmp_mul($a, $b) : bcmul((string)$a, (string)$b); }
    public static function mod($a, $m)  {
        $r = self::$mode === 'gmp' ? gmp_mod($a, $m) : bcmod((string) $a, (string) $m);
        // bcmod может вернуть отрицательный остаток для отрицательного числа —
        // нормализуем в диапазон [0, m) (gmp_mod делает это сам)
        if (self::$mode === 'bc' && bccomp((string) $r, '0') < 0) {
            $r = bcadd((string) $r, (string) $m);
        }
        return $r;
    }
    public static function cmp($a, $b)  { return self::$mode === 'gmp' ? gmp_cmp($a, $b) : bccomp((string)$a, (string)$b); }
    /** floor-деление */
    public static function div($a, $b)  { return self::$mode === 'gmp' ? gmp_div_q($a, $b) : bcdiv((string)$a, (string)$b, 0); }

    /** modpow по основанию 2 через square-and-multiply (работает в обоих режимах) */
    public static function powMod($base, $expBytes, $m) {
        $result = self::fromBin("\x01");
        $base = self::mod($base, $m);
        $len = strlen($expBytes);
        for ($i = 0; $i < $len; $i++) {
            $byte = ord($expBytes[$i]);
            for ($bit = 7; $bit >= 0; $bit--) {
                $result = self::mod(self::mul($result, $result), $m);
                if (($byte >> $bit) & 1) {
                    $result = self::mod(self::mul($result, $base), $m);
                }
            }
        }
        return $result;
    }

    /** модульный обратный элемент (Ферма: x^(m-2) mod m, m — простое) */
    public static function inv($x, $p) {
        $exp = self::sub($p, self::fromBin("\x02"));
        return self::powMod($x, self::toBin($exp, 32), $p);
    }
}

Math::pick();

/* Параметры кривой NIST P-256 (secp256r1 / prime256v1) */
const P256_P_HEX = 'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff';
const P256_A_HEX = 'ffffffff00000001000000000000000000000000fffffffffffffffffffffffc'; // a = p - 3
const P256_B_HEX = '5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b';
const P256_N_HEX = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
const P256_GX_HEX = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const P256_GY_HEX = '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';

$P256_P = Math::fromBin(hex2bin(P256_P_HEX));
$P256_A = Math::fromBin(hex2bin(P256_A_HEX));
$P256_B = Math::fromBin(hex2bin(P256_B_HEX));
$P256_N = Math::fromBin(hex2bin(P256_N_HEX));
$P256_G = [Math::fromBin(hex2bin(P256_GX_HEX)), Math::fromBin(hex2bin(P256_GY_HEX))];

/** Складывает две точки (или точку с бесконечностью). */
function ec_add(?array $p1, ?array $p2): ?array {
    global $P256_P, $P256_A;
    if ($p1 === null) return $p2;
    if ($p2 === null) return $p1;
    if (Math::cmp($p1[0], $p2[0]) === 0) {
        if (Math::cmp(Math::add($p1[1], $p2[1]), $P256_P) === 0 || Math::cmp($p1[1], self0()) === 0) {
            return null; // P + (-P) = O или P + P при y=0
        }
        return ec_double($p1);
    }
    $slope = Math::mod(Math::mul(
        Math::sub($p2[1], $p1[1]),
        Math::inv(Math::mod(Math::sub($p2[0], $p1[0]), $P256_P), $P256_P)
    ), $P256_P);
    $x3 = Math::mod(Math::sub(Math::sub(Math::mul($slope, $slope), $p1[0]), $p2[0]), $P256_P);
    $y3 = Math::mod(Math::sub(Math::mul($slope, Math::sub($p1[0], $x3)), $p1[1]), $P256_P);
    return [$x3, $y3];
}

function self0() { return Math::$mode === 'gmp' ? gmp_init(0) : '0'; }

/** Удваивает точку. */
function ec_double(?array $p): ?array {
    global $P256_P, $P256_A;
    if ($p === null || Math::cmp($p[1], self0()) === 0) return null;
    $num = Math::mod(Math::add(Math::mul(Math::fromBin("\x03"), Math::mul($p[0], $p[0])), $P256_A), $P256_P);
    $den = Math::mod(Math::mul(Math::fromBin("\x02"), $p[1]), $P256_P);
    $slope = Math::mod(Math::mul($num, Math::inv($den, $P256_P)), $P256_P);
    $x3 = Math::mod(Math::sub(Math::mul($slope, $slope), Math::mul(Math::fromBin("\x02"), $p[0])), $P256_P);
    $y3 = Math::mod(Math::sub(Math::mul($slope, Math::sub($p[0], $x3)), $p[1]), $P256_P);
    return [$x3, $y3];
}

/** Скалярное умножение k·P (двоичный метод, слева направо). */
function ec_mul(array $point, string $scalar32): ?array {
    $result = null;
    for ($byte = 0; $byte < 32; $byte++) {
        for ($bit = 7; $bit >= 0; $bit--) {
            $result = ec_double($result);
            if ((ord($scalar32[$byte]) >> $bit) & 1) {
                $result = ec_add($result, $point);
            }
        }
    }
    return $result;
}

/** Проверка точки на кривой: y² = x³ - 3x + b (mod p). */
function ec_on_curve(array $p): bool {
    global $P256_P, $P256_A, $P256_B;
    $left  = Math::mod(Math::mul($p[1], $p[1]), $P256_P);
    $right = Math::mod(Math::add(Math::sub(Math::mul(Math::mul($p[0], $p[0]), $p[0]), Math::mul(Math::fromBin("\x03"), $p[0])), $P256_B), $P256_P);
    return Math::cmp($left, $right) === 0;
}

/** ECDH: общий секрет — X-координата k·Peer, где k — наш приватный скаляр. */
function ecdh_secret(string $peerRaw65, string $priv32): ?string {
    global $P256_P;
    if (strlen($peerRaw65) !== 65 || ord($peerRaw65[0]) !== 0x04) return null;
    $x = Math::fromBin(substr($peerRaw65, 1, 32));
    $y = Math::fromBin(substr($peerRaw65, 33, 32));
    $peer = [$x, $y];
    if (!ec_on_curve($peer)) return null;
    $shared = ec_mul($peer, $priv32);
    if ($shared === null) return null;
    return Math::toBin($shared[0], 32);
}

/* ==================== VAPID (ES256 JWT, чистый PHP) ==================== */

/**
 * ECDSA-подпись (raw R||S, 64 байта) хеша SHA-256 приватным ключом d.
 */
function ecdsa_sign(string $hash32, string $priv32): string {
    global $P256_N, $P256_G;
    $d = Math::fromBin($priv32);
    $z = Math::fromBin($hash32);
    $nMinus1 = Math::sub($P256_N, Math::fromBin("\x01"));
    while (true) {
        // k — случайное в [1, n-1]
        $kBin = random_bytes(32);
        if (Math::cmp(Math::fromBin($kBin), $nMinus1) > 0) {
            $kBin = Math::toBin(Math::mod(Math::fromBin($kBin), $P256_N), 32);
        }
        if (ltrim($kBin, "\0") === '') continue;
        $kg = ec_mul($P256_G, $kBin);
        if ($kg === null) continue;
        $r = Math::mod($kg[0], $P256_N);
        if (Math::cmp($r, self0()) === 0) continue;
        $kInv = Math::inv(Math::fromBin($kBin), $P256_N);
        $s = Math::mod(Math::mul($kInv, Math::add($z, Math::mul($r, $d))), $P256_N);
        if (Math::cmp($s, self0()) === 0) continue;
        return Math::toBin($r, 32) . Math::toBin($s, 32);
    }
}

/** VAPID JWT: base64url(header).base64url(claims).base64url(ES256-подпись). */
function vapid_jwt(string $aud): string {
    global $P256_N;
    $privBin = b64url_decode(VAPID_PRIVATE_KEY);
    if (strlen($privBin) !== 32) {
        logline('VAPID_PRIVATE_KEY некорректен (ожидался 32-байтный base64url)');
        exit(1);
    }
    $header  = b64url_encode((string) json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
    $claims  = b64url_encode((string) json_encode([
        'aud' => $aud,
        'exp' => time() + 43200, // 12 часов
        'sub' => VAPID_SUBJECT,
    ]));
    $input   = $header . '.' . $claims;
    $sig     = ecdsa_sign(hash('sha256', $input, true), $privBin);
    return $input . '.' . b64url_encode($sig);
}

/* ==================== ШИФРОВАНИЕ PAYLOAD (RFC 8291, aes128gcm) ==================== */

/** HKDF-SHA256: только extract (RFC 5869) */
function hkdf_extract(string $salt, string $ikm): string {
    return hash_hmac('sha256', $ikm, $salt, true);
}

/** HKDF-SHA256: только expand (RFC 5869) */
function hkdf_expand(string $prk, string $info, int $len): string {
    $t = '';
    $okm = '';
    $i = 1;
    while (strlen($okm) < $len) {
        $t = hash_hmac('sha256', $t . $info . chr($i), $prk, true);
        $okm .= $t;
        $i++;
    }
    return substr($okm, 0, $len);
}

/** Полный HKDF (extract + expand) */
function hkdf_sha256(string $ikm, string $salt, string $info, int $len): string {
    return hkdf_expand(hkdf_extract($salt, $ikm), $info, $len);
}

/**
 * Шифрует payload по RFC 8291 (кодирование aes128gcm):
 * заголовок записи salt(16) | rs(4) | idlen(1)=65 | ключ эфемерной пары (65).
 *
 * Деривация (как в http_ece / RFC 8291 §3.3):
 *   secret = HKDF(ikm=ECDH-секрет, salt=AUTH-секрет подписки, info="WebPush: info\0"+receiver+sender, 32)
 *   prk    = HMAC-SHA256(salt=случайный salt записи, ikm=secret)   — только extract
 *   cek    = expand(prk, "Content-Encoding: aes128gcm\0", 16)
 *   nonce  = expand(prk, "Content-Encoding: nonce\0", 12)
 * plaintext записи = payload || 0x02 (без дополнительного заполнения).
 */
function encrypt_payload(string $recvRaw65, string $authSecret, string $payloadJson): string {
    global $P256_P;
    // 1. эфемерная пара P-256
    $dBin = null;
    $ephRaw = null;
    while ($ephRaw === null) {
        $dBin = random_bytes(32);
        if (Math::cmp(Math::fromBin($dBin), $P256_P) >= 0) continue;
        $eph = ec_mul([Math::fromBin(hex2bin(P256_GX_HEX)), Math::fromBin(hex2bin(P256_GY_HEX))], $dBin);
        if ($eph === null) continue;
        $ephRaw = "\x04" . Math::toBin($eph[0], 32) . Math::toBin($eph[1], 32);
    }
    // 2. общий секрет ECDH
    $shared = ecdh_secret($recvRaw65, $dBin);
    if ($shared === null) {
        throw new RuntimeException('Публичный ключ подписки не на кривой P-256');
    }
    // 3. HKDF по RFC 8291
    $keyInfo = 'WebPush: info' . "\x00" . $recvRaw65 . $ephRaw;
    $secret  = hkdf_sha256($shared, $authSecret, $keyInfo, 32);
    $salt    = random_bytes(16);
    $prk     = hkdf_extract($salt, $secret);
    $cek     = hkdf_expand($prk, "Content-Encoding: aes128gcm\x00", 16);
    $nonce   = hkdf_expand($prk, "Content-Encoding: nonce\x00", 12);
    // 4. padding: контент || 0x02 (как в эталонных реализациях)
    if (strlen($payloadJson) > 4096 - 17 - 1) {
        throw new RuntimeException('Payload слишком велик для одной записи aes128gcm');
    }
    $plaintext = $payloadJson . "\x02";
    // 5. AES-128-GCM
    $tag = '';
    $ct = openssl_encrypt($plaintext, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
    if ($ct === false) {
        throw new RuntimeException('openssl_encrypt aes-128-gcm недоступен');
    }
    // 6. запись: заголовок (salt | rs=4096 | idlen=65 | ключ эфемерной пары) + шифротекст + тег
    return $salt . pack('N', 4096) . "\x41" . $ephRaw . $ct . $tag;
}

/* ==================== HTTP-ОТПРАВКА ==================== */

/** POST с заголовками; возвращает [status|null, тело, ошибка|null]. */
function http_post(string $url, string $body, array $headers): array {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            // Expect: подавляем — curl добавляет «Expect: 100-continue» для тел > 1 КБ,
            // а push-сервисы такого ждут не все
            CURLOPT_HTTPHEADER => array_merge($headers, ['Expect:']),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 20,
        ]);
        $res = curl_exec($ch);
        $err = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($res === false) return [null, '', $err];
        return [$status, (string) $res, null];
    }
    // запасной транспорт: file_get_contents
    $ctx = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => implode("\r\n", $headers),
        'content' => $body,
        'ignore_errors' => true,
        'timeout' => 25,
    ]]);
    $res = @file_get_contents($url, false, $ctx);
    if ($res === false) return [null, '', 'network error'];
    $status = 0;
    foreach (($http_response_header ?? []) as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $status = (int) $m[1];
    }
    return [$status, $res, null];
}

/** aud = схема://хост[:порт] из endpoint (требование VAPID). */
function endpoint_aud(string $endpoint): string {
    $u = parse_url($endpoint);
    if (!isset($u['scheme'], $u['host'])) return '';
    $aud = $u['scheme'] . '://' . $u['host'];
    if (isset($u['port'])) $aud .= ':' . $u['port'];
    return $aud;
}

/* ==================== ОСНОВНОЙ ЦИКЛ ==================== */

if (defined('PUSH_SENDER_NO_RUN')) {
    return; // модульный режим (тесты подключают файл ради функций)
}

$db = load_json($DB_FILE);
$reminders = ($db['data']['reminders'] ?? null) !== null && is_array($db['data']['reminders'] ?? null)
    ? $db['data']['reminders'] : [];

$subsMap = load_json($SUBS_FILE) ?? [];
if (!is_array($subsMap)) $subsMap = [];
$subs = array_values($subsMap);

if (count($subs) === 0) {
    logline('push-подписок нет — уведомления ни на одном устройстве не включены (это не ошибка)');
    flock($lockFp, LOCK_UN);
    exit(0);
}

$state = load_json($STATE_FILE) ?? [];
if (!is_array($state)) $state = [];

$now = time();
$windowSec = max(1, WINDOW_MINUTES) * 60;
$staleSec = max(1, STALE_SUB_DAYS) * 86400;
$sent = 0; $failed = 0; $removed = 0; $pending = 0;

foreach ($subs as $sub) {
    $endpoint = (string) ($sub['endpoint'] ?? '');
    if ($endpoint === '') continue;

    // устаревшая подписка
    $updated = isset($sub['updatedAt']) ? strtotime((string) $sub['updatedAt']) : false;
    if ($updated !== false && $updated > 0 && ($now - $updated) > $staleSec) {
        unset($subsMap[$endpoint]);
        $removed++;
        logline('подписка устарела (> ' . STALE_SUB_DAYS . ' дн.) — удалена: ' . (string) ($sub['userName'] ?? '?'));
        continue;
    }

    $tz = isset($sub['tzOffsetMin']) && is_numeric($sub['tzOffsetMin']) ? (int) $sub['tzOffsetMin'] : 0;
    $userId = (string) ($sub['userId'] ?? '');
    $userName = (string) ($sub['userName'] ?? '?');
    $p256dh = (string) ($sub['keys']['p256dh'] ?? '');
    $authSecret = (string) ($sub['keys']['auth'] ?? '');
    $recvRaw = b64url_decode($p256dh);

    // напоминания профиля этого устройства: не выполненные, с датой и временем
    $candidates = [];
    foreach ($reminders as $r) {
        if (!is_array($r)) continue;
        if ((string) ($r['userId'] ?? '') !== $userId) continue;
        if (($r['completed'] ?? false) === true) continue;
        if (!is_string($r['date'] ?? null) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $r['date'])) continue;
        if (!is_string($r['time'] ?? null) || !preg_match('/^\d{1,2}:\d{2}$/', (string) $r['time'])) continue;
        $candidates[] = $r;
    }
    if (count($candidates) === 0) continue;

    foreach ($candidates as $r) {
        // срок по часовому поясу устройства: локальные дата+время → момент UTC
        $dt = date_create_from_format('Y-m-d H:i', $r['date'] . ' ' . $r['time'], new DateTimeZone('UTC'));
        if ($dt === false) continue;
        $dueEpoch = $dt->getTimestamp() - $tz * 60;

        if ($dueEpoch > $now) continue;                    // ещё не наступил
        if (($now - $dueEpoch) > $windowSec) continue;      // окно упущено
        $pending++;

        $stateKey = $r['id'] . '|' . $r['date'] . '|' . $r['time'];
        if (isset($state[$stateKey])) continue;             // уже отправляли

        $payload = json_encode([
            'title' => PUSH_TITLE,
            'body'  => $r['time'] . ' · ' . (string) $r['title'],
            'tag'   => (string) $r['id'],
            'url'   => APP_URL,
        ], JSON_UNESCAPED_UNICODE);
        if ($payload === false) continue;

        try {
            $body = encrypt_payload($recvRaw, b64url_decode($authSecret), $payload);
        } catch (RuntimeException $e) {
            // ключ подписки недействителен — удаляем её
            unset($subsMap[$endpoint]);
            $removed++;
            logline('подписка недействительна (' . $e->getMessage() . ') — удалена: ' . $userName);
            break;
        }

        $aud = endpoint_aud($endpoint);
        if ($aud === '') {
            unset($subsMap[$endpoint]);
            $removed++;
            logline('endpoint некорректен — подписка удалена: ' . $userName);
            break;
        }
        $headers = [
            'Authorization: vapid t=' . vapid_jwt($aud) . ', k=' . VAPID_PUBLIC_KEY,
            'Content-Type: application/octet-stream',
            'Content-Encoding: aes128gcm',
            'TTL: ' . PUSH_TTL,
            'Urgency: high',
        ];
        [$status, , $err] = http_post($endpoint, $body, $headers);

        if ($status !== null && $status >= 200 && $status < 300) {
            $state[$stateKey] = date('c', $now);
            $sent++;
            logline('отправлено: ' . $userName . ' ← «' . (string) $r['title'] . '» (' . $r['date'] . ' ' . $r['time'] . ')');
        } elseif ($status === 404 || $status === 410) {
            unset($subsMap[$endpoint]);
            $removed++;
            logline('подписка недействительна (HTTP ' . $status . ') — удалена: ' . $userName);
            break;
        } else {
            $failed++;
            logline('[ошибка] отправка для ' . $userName . ': HTTP ' . ($status ?? '—') . ($err !== null ? ' / ' . $err : ''));
            break; // не долбим эту подписку остальными напоминаниями в этом прогоне
        }
    }
}

// чистим записи состояния старше 30 дней
$cutoff = $now - 30 * 86400;
foreach ($state as $key => $at) {
    $t = strtotime((string) $at);
    if ($t !== false && $t < $cutoff) unset($state[$key]);
}
if (count($state) > 0) atomic_write($STATE_FILE, (string) json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
if ($removed > 0) atomic_write($SUBS_FILE, (string) json_encode($subsMap, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

logline('итог: напоминаний «сейчас» ' . $pending . ', отправлено ' . $sent . ', ошибок ' . $failed . ', подписок удалено ' . $removed);
flock($lockFp, LOCK_UN);
