<?php
/**
 * Ежедневник PWA — сервер синхронизации данных и push-подписок (единый файл).
 *
 * Кладётся в папку приложения на хостинге (например, ediai.ru/pwa/api.php).
 * Хранит данные приложения в JSON-файле storage/db.json и подписки push
 * в storage/push-subscriptions.json (папка закрыта от прямого доступа).
 *
 * Протокол:
 *   GET  api.php?action=status            → {"ok":true,...}          (проверка связи)
 *   GET  api.php?action=db                → JSON-данные или 404      (загрузка данных)
 *   POST api.php  (тело = JSON-данные)    → {"ok":true,...}          (отправка данных)
 *   GET  api.php?action=push              → {"ok":true,"publicKey":…}(VAPID-ключ)
 *   POST api.php?action=subscribe         → подписка push {endpoint,keys,userId,userName,tzOffsetMin}
 *   POST api.php?action=unsubscribe       → удаление подписки {endpoint}
 *
 * Файл подписок читает скрипт push-sender (Node.js, cron на хостинге):
 * он находит напоминания, срок которых наступил, и рассылает Web Push.
 *
 * Ключ синхронизации передаётся в заголовке X-Sync-Key (или ?key=...).
 * Он же должен быть вшит в сборку приложения (NEXT_PUBLIC_SYNC_KEY).
 *
 * Совместимо с PHP 7.4+ (виртуальный хостинг AdminVPS: выберите PHP 8.x
 * в панели управления, если версия не выбрана автоматически).
 */

declare(strict_types=1);

/* ============================ НАСТРОЙКИ ============================ */

/** Ключ синхронизации — замените при желании и обновите его в сборке приложения. */
const SYNC_KEY = '5e254577c0cffc3536b691c9368b46ed';

/**
 * Публичный VAPID-ключ для Web Push (пара с приватным ключом в push-sender/config.json).
 * Приложение получает его действием action=push. Сгенерировать новую пару:
 *   npx web-push generate-vapid-keys
 */
const VAPID_PUBLIC_KEY = 'BAWVggx3TiOGr6UxJIqhOpoMgpA_lFOt7lLlsBI3vthuqhCIXtjnmrY8Dh17bqjvtVbi6GspUxc4LSyGsyNDgkw';

/** Файл хранения данных (создаётся автоматически). */
const STORAGE_FILE = __DIR__ . '/storage/db.json';

/** Файл push-подписок (создаётся автоматически; читает push-sender). */
const PUSH_SUBS_FILE = __DIR__ . '/storage/push-subscriptions.json';

/** Максимальный размер тела запроса, байт (2 МБ достаточно с запасом). */
const MAX_BYTES = 2097152;

/** Источники, которым разрешено обращаться к api.php с другого сайта (CORS).
 *  Приложение обычно лежит на том же домене — CORS тогда не требуется.
 *  Пустой список [] означает «разрешить всем источникам». */
const ALLOWED_ORIGINS = ['https://ediai.ru'];

/* ========================== СЛУЖЕБНЫЕ ФУНКЦИИ ========================== */

function json_out(int $status, array $payload): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function cors_headers(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return; // обычный (однодоменный) запрос — CORS не нужен
    }
    if (in_array($origin, ALLOWED_ORIGINS, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    }
}

function fail(int $status, string $code, string $detail = ''): void {
    $payload = ['ok' => false, 'error' => $code];
    if ($detail !== '') {
        $payload['detail'] = $detail;
    }
    json_out($status, $payload);
}

/** Готовит папку storage (папка + .htaccess, запрещающий прямой доступ). */
function ensure_storage(string $file): void {
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        fail(500, 'storage_error', 'Не удалось создать папку storage');
    }
    $htaccess = $dir . '/.htaccess';
    if (!is_file($htaccess)) {
        @file_put_contents($htaccess, "Require all denied\nDeny from all\n");
    }
}

/** Атомарная запись JSON-файла: во временный файл, затем переименование. */
function atomic_write(string $file, string $body): void {
    ensure_storage($file);
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, $body) === false) {
        fail(500, 'storage_error', 'Не удалось записать файл (проверьте права на папку storage)');
    }
    @chmod($tmp, 0664);
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        fail(500, 'storage_error', 'Не удалось сохранить файл');
    }
}

/** Читает JSON-файл или возвращает запасное значение. */
function read_json(string $file, $fallback) {
    if (!is_file($file)) {
        return $fallback;
    }
    $raw = file_get_contents($file);
    if ($raw === false || trim($raw) === '') {
        return $fallback;
    }
    $decoded = json_decode($raw, true);
    return $decoded === null ? $fallback : $decoded;
}

/* ============================== ЗАПРОС ============================== */

// Служебная папка не для поисковых роботов
header('X-Robots-Tag: noindex, nofollow', true);
header('X-Content-Type-Options: nosniff');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Preflight-запрос браузера (CORS)
if ($method === 'OPTIONS') {
    cors_headers();
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Sync-Key');
    header('Access-Control-Max-Age: 600');
    http_response_code(204);
    exit;
}
cors_headers();

// Ключ синхронизации
$givenKey = $_SERVER['HTTP_X_SYNC_KEY'] ?? ($_GET['key'] ?? '');
if (!is_string($givenKey) || $givenKey === '' || !hash_equals(SYNC_KEY, $givenKey)) {
    fail(403, 'bad_key', 'Ключ синхронизации не передан или неверен');
}

$action = isset($_GET['action']) ? (string) $_GET['action'] : '';

/* --- проверка связи --- */
if ($action === 'status') {
    json_out(200, [
        'ok'   => true,
        'app'  => 'ezhednik',
        'php'  => PHP_VERSION,
        'push' => true,
        'time' => date('c'),
    ]);
}

/* --- загрузка данных --- */
if ($action === 'db' && $method === 'GET') {
    if (!is_file(STORAGE_FILE)) {
        fail(404, 'not_found', 'На сервере ещё нет файла данных');
    }
    $raw = file_get_contents(STORAGE_FILE);
    if ($raw === false || trim($raw) === '') {
        fail(500, 'storage_error', 'Файл данных пуст или не читается');
    }
    header('Content-Type: application/json; charset=utf-8');
    echo $raw;
    exit;
}

/* --- VAPID-ключ для push-подписки (приложение получает его при включении уведомлений) --- */
if ($action === 'push' && $method === 'GET') {
    json_out(200, [
        'ok'        => true,
        'publicKey' => VAPID_PUBLIC_KEY,
    ]);
}

/* --- сохранение push-подписки устройства --- */
if ($action === 'subscribe' && $method === 'POST') {
    $body = file_get_contents('php://input');
    if ($body === false || trim($body) === '') {
        fail(400, 'empty_body', 'Тело запроса пустое');
    }
    if (strlen($body) > MAX_BYTES) {
        fail(413, 'too_large', 'Подписка превышает допустимый размер');
    }
    $sub = json_decode($body, true);
    if (!is_array($sub)) {
        fail(400, 'bad_json', 'Тело запроса не является корректным JSON');
    }
    $endpoint = isset($sub['endpoint']) && is_string($sub['endpoint']) ? $sub['endpoint'] : '';
    $keys     = isset($sub['keys']) && is_array($sub['keys']) ? $sub['keys'] : [];
    if ($endpoint === '' || !isset($keys['p256dh'], $keys['auth'])) {
        fail(400, 'bad_subscription', 'Ожидаются поля endpoint и keys.p256dh/keys.auth');
    }

    $subs = read_json(PUSH_SUBS_FILE, []);
    if (!is_array($subs)) {
        $subs = [];
    }
    $subs[$endpoint] = [
        'endpoint'    => $endpoint,
        'keys'        => $keys,
        'userId'      => isset($sub['userId']) && is_string($sub['userId']) ? $sub['userId'] : '',
        'userName'    => isset($sub['userName']) && is_string($sub['userName']) ? $sub['userName'] : '',
        // часовой пояс устройства (минуты к востоку от UTC): срок напоминания
        // считается по времени этого устройства
        'tzOffsetMin' => isset($sub['tzOffsetMin']) && is_numeric($sub['tzOffsetMin'])
            ? (int) $sub['tzOffsetMin'] : 0,
        'updatedAt'   => date('c'),
    ];
    atomic_write(PUSH_SUBS_FILE, json_encode($subs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

    json_out(200, ['ok' => true, 'subscriptions' => count($subs), 'time' => date('c')]);
}

/* --- удаление push-подписки --- */
if ($action === 'unsubscribe' && $method === 'POST') {
    $body = file_get_contents('php://input');
    $sub = $body ? json_decode($body, true) : null;
    $endpoint = is_array($sub) && isset($sub['endpoint']) && is_string($sub['endpoint'])
        ? $sub['endpoint'] : '';
    if ($endpoint === '') {
        fail(400, 'bad_request', 'Ожидается поле endpoint');
    }
    $subs = read_json(PUSH_SUBS_FILE, []);
    if (is_array($subs) && isset($subs[$endpoint])) {
        unset($subs[$endpoint]);
        atomic_write(PUSH_SUBS_FILE, json_encode($subs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }
    json_out(200, ['ok' => true, 'time' => date('c')]);
}

/* --- отправка данных --- */
if ($action === '' && $method === 'POST') {
    $body = file_get_contents('php://input');
    if ($body === false || trim($body) === '') {
        fail(400, 'empty_body', 'Тело запроса пустое');
    }
    if (strlen($body) > MAX_BYTES) {
        fail(413, 'too_large', 'Файл данных превышает допустимый размер');
    }
    $decoded = json_decode($body);
    if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
        fail(400, 'bad_json', 'Тело запроса не является корректным JSON');
    }

    atomic_write(STORAGE_FILE, $body);

    json_out(200, [
        'ok'    => true,
        'bytes' => strlen($body),
        'time'  => date('c'),
    ]);
}

fail(404, 'unknown_action', 'Доступны: GET action=status|db|push, POST (запись данных), POST action=subscribe|unsubscribe');
