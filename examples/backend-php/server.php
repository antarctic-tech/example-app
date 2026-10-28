<?php

declare(strict_types=1);

/**
 * Бэкенд вашей мини-апки, не API Antarctic Wallet (AW).
 *
 * После чтения файла сверху вниз должно быть ясно:
 *   1. Секреты живут в env (AW_APP_ID / AW_API_SECRET / AW_API_BASE).
 *   2. Кто пользователь — из проверенного idToken: sub = непрозрачный
 *      user_app_login (не глобальный numeric user_id). KYC-флаги — клеймы токена.
 *   3. Интент = POST в AW /api/apps/v1/intents (X-Aw-App-Id + Bearer).
 *      В теле AW — user_app_login, никогда user_id (422 USER_ID_NOT_ACCEPTED).
 *   4. pay / scopes: после operationId мини-апка зовёт requestConfirmation.
 *      receive исполняется сразу, лист в кошельке не нужен.
 *
 * Эндпоинты:
 *   POST /api/auth/session  { idToken }              → { userId, hasKyc? }
 *   POST /api/intents       { idToken, type, ... }   → { operationId, status }
 *   POST /api/webhooks      AW → этот сервер (подписанный app_secret)
 *   GET  /health
 *
 * Запуск (локально):
 *   composer install
 *   cp .env.example .env   # заполните ключи
 *   php -S 0.0.0.0:3351 server.php
 */

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/src/bootstrap.php';

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;

loadEnvFile(__DIR__ . '/.env');

$AW_API_BASE = rtrim(env('AW_API_BASE', '') ?? '', '/');
$AW_APP_ID = env('AW_APP_ID', '') ?? '';
$AW_API_SECRET = env('AW_API_SECRET', '') ?? '';
$ALLOWED_ORIGIN = env('ALLOWED_ORIGIN', '*') ?? '*';
$defaultPublicDir = __DIR__ . DIRECTORY_SEPARATOR . 'public';
/**
 * Static files (Vue dist): STATIC_DIR env, else ./public if it has index.html,
 * else the directory of the front controller (shared-hosting: dist copied next to index.php).
 */
$STATIC_DIR = env('STATIC_DIR') ?? '';
if ($STATIC_DIR === '') {
    if (is_file($defaultPublicDir . DIRECTORY_SEPARATOR . 'index.html')) {
        $STATIC_DIR = $defaultPublicDir;
    } else {
        $scriptFile = $_SERVER['SCRIPT_FILENAME'] ?? '';
        $frontDir = is_string($scriptFile) && $scriptFile !== ''
            ? dirname($scriptFile)
            : '';
        if ($frontDir !== '' && is_file($frontDir . DIRECTORY_SEPARATOR . 'index.html')) {
            $STATIC_DIR = $frontDir;
        } elseif (is_dir($defaultPublicDir)) {
            $STATIC_DIR = $defaultPublicDir;
        }
    }
}

const AW_ISSUER = 'aw';
const AW_INTENTS_PATH = '/api/apps/v1/intents';
const VALID_TYPES = ['pay', 'receive', 'scopes'];
const VALID_SCOPES = ['userData', 'balance', 'pay'];
/** Вебхук с дрейфом часов > 5 мин отклоняем. */
const WEBHOOK_MAX_SKEW_SEC = 300;

/** @var array<string, \Firebase\JWT\Key>|null */
$jwksKeys = null;
$jwksConfigured = $AW_API_BASE !== '';

if (!$AW_API_BASE || !$AW_APP_ID || !$AW_API_SECRET) {
    error_log(
        '[boot] Missing AW_API_BASE / AW_APP_ID / AW_API_SECRET — /api/intents will return 500 until they are set.',
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(string $msg): string
{
    return hash('sha256', $msg);
}

function hmacSha256Hex(string $secret, string $msg): string
{
    return hash_hmac('sha256', $msg, $secret);
}

/** Сравнение подписей без утечки по времени ответа. */
function equalHex(string $a, string $b): bool
{
    if (strlen($a) !== strlen($b)) {
        return false;
    }
    return hash_equals($a, $b);
}

final class HttpError extends RuntimeException
{
    /** @param array<string, mixed> $extra */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        public readonly array $extra = [],
    ) {
        parent::__construct($errorCode);
    }
}

function httpError(int $status, string $code, array $extra = []): never
{
    throw new HttpError($status, $code, $extra);
}

function sendError(HttpError $error): never
{
    jsonResponse($error->status, array_merge(['error' => $error->errorCode], $error->extra));
}

function jsonResponse(int $status, array $payload): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function readJsonBody(int $maxBytes): array
{
    $raw = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if ($raw === false) {
        httpError(400, 'INVALID_JSON');
    }
    if (strlen($raw) > $maxBytes) {
        httpError(413, 'BODY_TOO_LARGE');
    }
    if ($raw === '') {
        return [];
    }
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) {
        httpError(400, 'INVALID_JSON');
    }
    return $parsed;
}

function readRawBody(int $maxBytes): string
{
    $raw = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if ($raw === false) {
        httpError(400, 'INVALID_JSON');
    }
    if (strlen($raw) > $maxBytes) {
        httpError(413, 'BODY_TOO_LARGE');
    }
    return $raw;
}

/** Только для этого демо: каждый вызов даёт НОВЫЙ id. Не копируйте в прод. */
function newReferenceId(string $prefix): string
{
    return $prefix . '-' . (int) (microtime(true) * 1000) . '-' . bin2hex(random_bytes(4));
}

/**
 * AW отвечает по-разному: data.operationId или data.operation_id.
 * Нормализуем к одной строке.
 */
function readOperationId(mixed $parsed): ?string
{
    if (!is_array($parsed)) {
        return null;
    }
    $nested = isset($parsed['data']) && is_array($parsed['data']) ? $parsed['data'] : null;
    $id = $nested['operationId']
        ?? $nested['operation_id']
        ?? $parsed['operationId']
        ?? $parsed['operation_id']
        ?? null;
    return is_string($id) && $id !== '' ? $id : null;
}

function readIntentStatus(mixed $parsed): ?string
{
    if (!is_array($parsed)) {
        return null;
    }
    $nested = isset($parsed['data']) && is_array($parsed['data']) ? $parsed['data'] : null;
    $status = $nested['status'] ?? $parsed['status'] ?? null;
    return is_string($status) && $status !== '' ? $status : null;
}

function readFailureReason(mixed $parsed): ?string
{
    if (!is_array($parsed)) {
        return null;
    }
    $nested = isset($parsed['data']) && is_array($parsed['data']) ? $parsed['data'] : null;
    $reason = $nested['failureReason']
        ?? $nested['failure_reason']
        ?? $parsed['failureReason']
        ?? null;
    return is_string($reason) && $reason !== '' ? $reason : null;
}

/**
 * @return array<string, \Firebase\JWT\Key>
 */
function fetchJwksKeys(string $apiBase): array
{
    $url = $apiBase . '/api/v2/sdk/jwks';
    $result = httpRequest('GET', $url, null, [
        'Accept: application/json',
    ], 10);
    if ($result['status'] < 200 || $result['status'] >= 300 || $result['body'] === '') {
        throw new RuntimeException('JWKS_FETCH_FAILED');
    }
    $jwks = json_decode($result['body'], true);
    if (!is_array($jwks) || !isset($jwks['keys']) || !is_array($jwks['keys'])) {
        throw new RuntimeException('JWKS_INVALID');
    }
    return JWK::parseKeySet($jwks);
}

/**
 * @param list<string> $headers
 * @return array{status: int, body: string}
 */
function httpRequest(
    string $method,
    string $url,
    ?string $body,
    array $headers,
    int $timeoutSec,
): array {
    if (!function_exists('curl_init')) {
        throw new RuntimeException('CURL_REQUIRED');
    }
    $ch = curl_init($url);
    if ($ch === false) {
        return ['status' => 502, 'body' => ''];
    }
    $opts = [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeoutSec,
        CURLOPT_FOLLOWLOCATION => false,
    ];
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = $body;
    }
    curl_setopt_array($ch, $opts);
    $responseBody = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($responseBody === false) {
        return ['status' => 502, 'body' => ''];
    }
    return ['status' => $status > 0 ? $status : 502, 'body' => $responseBody];
}

/**
 * Проверка JWT кошелька по JWKS.
 * Личность = payload.sub = непрозрачный user_app_login (16 hex), не глобальный id.
 * При scope userData в токене ещё hasKyc / hasKycData / kycCountry.
 * userContext и userId из клиента не берём — их можно подменить (IDOR).
 *
 * @return array{
 *   userId: string,
 *   userAppLogin: string,
 *   hasKyc: bool|null,
 *   hasKycData: bool|null,
 *   kycCountry: string|null,
 *   exp: int|null
 * }
 */
function verifyIdToken(
    ?string $idToken,
    string $apiBase,
    string $appId,
    bool $jwksConfigured,
    ?array &$jwksKeysCache,
): array {
    if (!$jwksConfigured || $apiBase === '') {
        httpError(500, 'JWKS_NOT_CONFIGURED', [
            'hint' => 'Set AW_API_BASE in env — JWKS URL is derived as /api/v2/sdk/jwks on that host.',
        ]);
    }
    if (!is_string($idToken) || $idToken === '') {
        httpError(400, 'ID_TOKEN_REQUIRED');
    }

    try {
        if ($jwksKeysCache === null) {
            $jwksKeysCache = fetchJwksKeys($apiBase);
        }
        $decoded = JWT::decode($idToken, $jwksKeysCache);
    } catch (Throwable $e) {
        // One retry with fresh JWKS (key rotation).
        try {
            $jwksKeysCache = fetchJwksKeys($apiBase);
            $decoded = JWT::decode($idToken, $jwksKeysCache);
        } catch (Throwable $retry) {
            httpError(401, 'INVALID_ID_TOKEN', [
                'reason' => $retry->getMessage() ?: 'verify_failed',
            ]);
        }
    }

    $iss = $decoded->iss ?? null;
    if ($iss !== AW_ISSUER) {
        httpError(401, 'INVALID_ID_TOKEN', ['reason' => 'bad_iss', 'claim' => 'iss']);
    }

    if ($appId !== '') {
        $aud = $decoded->aud ?? null;
        $audOk = false;
        if (is_string($aud)) {
            $audOk = $aud === $appId;
        } elseif (is_array($aud)) {
            $audOk = in_array($appId, $aud, true);
        }
        if (!$audOk) {
            httpError(401, 'INVALID_ID_TOKEN', ['reason' => 'bad_aud', 'claim' => 'aud']);
        }
    }

    $userAppLogin = isset($decoded->sub) ? (string) $decoded->sub : '';
    if ($userAppLogin === '') {
        httpError(401, 'INVALID_ID_TOKEN', ['reason' => 'missing_sub']);
    }

    return [
        'userId' => $userAppLogin,
        'userAppLogin' => $userAppLogin,
        'hasKyc' => isset($decoded->hasKyc) && is_bool($decoded->hasKyc) ? $decoded->hasKyc : null,
        'hasKycData' => isset($decoded->hasKycData) && is_bool($decoded->hasKycData)
            ? $decoded->hasKycData
            : null,
        'kycCountry' => isset($decoded->kycCountry) && is_string($decoded->kycCountry)
            ? $decoded->kycCountry
            : null,
        'exp' => isset($decoded->exp) ? (int) $decoded->exp : null,
    ];
}

/**
 * Тело B2B-запроса в AW.
 * user_app_login всегда из проверенного sub, никогда из req.body.
 * user_id в AW больше не принимается (422 USER_ID_NOT_ACCEPTED).
 * reference_id — id вашего заказа; в проде берите из своей БД, не от клиента.
 * Для receive reference_id обязателен: без него повтор по таймауту даст второй перевод.
 *
 * @param array{type: mixed, userAppLogin: string, amount?: mixed, scopes?: mixed, referenceId?: string|null} $args
 * @return array<string, mixed>
 */
function buildIntentPayload(array $args): array
{
    $type = $args['type'] ?? null;
    if (!is_string($type) || !in_array($type, VALID_TYPES, true)) {
        httpError(422, 'INVALID_TYPE');
    }

    $payload = [
        'type' => $type,
        'user_app_login' => $args['userAppLogin'],
    ];

    if (!empty($args['referenceId'])) {
        $payload['reference_id'] = $args['referenceId'];
    }

    if ($type === 'scopes') {
        $scopes = $args['scopes'] ?? null;
        $list = [];
        if (is_array($scopes)) {
            foreach ($scopes as $s) {
                if (!is_string($s) || !in_array($s, VALID_SCOPES, true)) {
                    httpError(422, 'INVALID_SCOPE');
                }
                if (!in_array($s, $list, true)) {
                    $list[] = $s;
                }
            }
        }
        if ($list === []) {
            httpError(422, 'SCOPES_REQUIRED');
        }
        $payload['data'] = ['scopes' => $list];
        return $payload;
    }

    $amount = $args['amount'] ?? null;
    if (!is_string($amount) || trim($amount) === '') {
        httpError(422, 'AMOUNT_REQUIRED');
    }
    if ($type === 'receive' && empty($args['referenceId'])) {
        httpError(422, 'REFERENCE_ID_REQUIRED');
    }
    $payload['data'] = ['amount' => $amount];
    return $payload;
}

/**
 * Отправить интент в AW.
 * appId и секрет только из env, браузер их не видит.
 *
 * @param array<string, mixed> $payload
 * @return array{status: int, body: string}
 */
function forwardIntent(array $payload, string $apiBase, string $appId, string $apiSecret): array
{
    $url = $apiBase . AW_INTENTS_PATH;
    $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return httpRequest(
        'POST',
        $url,
        $body === false ? '{}' : $body,
        [
            'Content-Type: application/json',
            'X-Aw-App-Id: ' . $appId,
            'Authorization: Bearer ' . $apiSecret,
        ],
        30,
    );
}

/**
 * Проверка вебхука AW: hex(HMAC-SHA256(AW_API_SECRET, "{ts}.{sha256(rawBody)}")).
 * Считаем по сырому телу — json_decode ломает подпись.
 */
function verifyWebhookSignature(
    string $rawBody,
    ?string $timestamp,
    ?string $signature,
    string $secret,
): bool {
    if ($timestamp === null || $signature === null || $secret === '') {
        return false;
    }
    if (!ctype_digit($timestamp)) {
        return false;
    }
    $ts = (int) $timestamp;
    if (abs(time() - $ts) > WEBHOOK_MAX_SKEW_SEC) {
        return false;
    }
    $expected = hmacSha256Hex($secret, $timestamp . '.' . sha256Hex($rawBody));
    return equalHex($expected, $signature);
}

function requestHeader(string $name): ?string
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$key]) && is_string($_SERVER[$key])) {
        return $_SERVER[$key];
    }
    // Some SAPIs expose custom headers differently
    foreach ($_SERVER as $k => $v) {
        if (is_string($v) && strcasecmp($k, $key) === 0) {
            return $v;
        }
    }
    return null;
}

function applyCors(string $allowedOrigin): void
{
    header('Access-Control-Allow-Origin: ' . $allowedOrigin);
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
}

function tryServeStatic(string $staticDir, string $path): bool
{
    if ($staticDir === '' || !is_dir($staticDir)) {
        return false;
    }
    $rel = $path === '/' ? '/index.html' : $path;
    $file = realpath($staticDir . $rel);
    $root = realpath($staticDir);
    if ($file === false || $root === false || !str_starts_with($file, $root) || !is_file($file)) {
        // Try .html extension like Express { extensions: ['html'] }
        $fileHtml = realpath($staticDir . $rel . '.html');
        if (
            $fileHtml === false
            || $root === false
            || !str_starts_with($fileHtml, $root)
            || !is_file($fileHtml)
        ) {
            return false;
        }
        $file = $fileHtml;
    }
    $mime = mime_content_type($file) ?: 'application/octet-stream';
    header('Content-Type: ' . $mime);
    readfile($file);
    return true;
}

/**
 * Path relative to the front controller — strips subdirectory prefixes
 * (e.g. /miniapp/health → /health when SCRIPT_NAME is /miniapp/index.php).
 */
function requestPath(): string
{
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (!is_string($uri) || $uri === '') {
        $uri = '/';
    }
    $scriptName = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '');
    $base = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');
    if ($base !== '' && $base !== '/' && str_starts_with($uri, $base)) {
        $uri = substr($uri, strlen($base)) ?: '/';
    }
    if ($uri === '' || $uri[0] !== '/') {
        $uri = '/' . ltrim($uri, '/');
    }
    return $uri;
}

// ---------------------------------------------------------------------------
// Built-in server: let PHP serve real static files under STATIC_DIR / public
// ---------------------------------------------------------------------------

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = requestPath();

if (PHP_SAPI === 'cli-server') {
    $candidate = __DIR__ . $path;
    if ($path !== '/' && is_file($candidate)) {
        return false;
    }
}

applyCors($ALLOWED_ORIGIN);

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

if ($method === 'GET' && $path === '/health') {
    jsonResponse(200, ['ok' => true]);
}

/**
 * Как ваш сервер проверяет JWT кошелька.
 * Сессию ключуйте по userAppLogin (sub), не по userContext.
 */
if ($method === 'POST' && $path === '/api/auth/session') {
    try {
        $body = readJsonBody(8 * 1024);
        $identity = verifyIdToken(
            isset($body['idToken']) && is_string($body['idToken']) ? $body['idToken'] : null,
            $AW_API_BASE,
            $AW_APP_ID,
            $jwksConfigured,
            $jwksKeys,
        );
        jsonResponse(200, [
            'ok' => true,
            'userId' => $identity['userAppLogin'],
            'userAppLogin' => $identity['userAppLogin'],
            'hasKyc' => $identity['hasKyc'],
            'hasKycData' => $identity['hasKycData'],
            'kycCountry' => $identity['kycCountry'],
            'expiresAt' => $identity['exp'],
        ]);
    } catch (HttpError $e) {
        error_log(
            '[auth] id_token verify failed: '
            . ($e->extra['reason'] ?? $e->errorCode),
        );
        sendError($e);
    } catch (Throwable $e) {
        error_log('[auth] id_token verify failed: ' . $e->getMessage());
        jsonResponse(500, ['error' => 'INTERNAL_ERROR']);
    }
}

/**
 * Как ваш сервер создаёт интент.
 * Браузер шлёт idToken + type + amount.
 * Секреты, user_id и user_app_login из клиента не принимаем — даже если прислали, игнорируем.
 */
if ($method === 'POST' && $path === '/api/intents') {
    if (!$AW_API_BASE || !$AW_APP_ID || !$AW_API_SECRET) {
        jsonResponse(500, [
            'error' => 'MISSING_CREDENTIALS',
            'hint' => 'Set AW_API_BASE, AW_APP_ID, AW_API_SECRET in env. Never send them from the browser.',
        ]);
    }
    try {
        $body = readJsonBody(16 * 1024);
        $identity = verifyIdToken(
            isset($body['idToken']) && is_string($body['idToken']) ? $body['idToken'] : null,
            $AW_API_BASE,
            $AW_APP_ID,
            $jwksConfigured,
            $jwksKeys,
        );
        $type = $body['type'] ?? null;
        $payload = buildIntentPayload([
            'type' => $type,
            'amount' => $body['amount'] ?? null,
            'scopes' => $body['scopes'] ?? null,
            'userAppLogin' => $identity['userAppLogin'],
            // receive без reference_id AW отвергает (422): иначе повтор после
            // таймаута переведёт деньги второй раз.
            //
            // Здесь id случайный — только чтобы демо собралось. Повтор того же
            // refund из браузера = второй перевод. В проде берите стабильный id
            // заказа из СВОЕЙ БД, например `refund-${order.id}`, и не принимайте
            // его из req.body.
            'referenceId' => $type === 'receive' ? newReferenceId('rcv') : null,
        ]);
        $upstream = forwardIntent($payload, $AW_API_BASE, $AW_APP_ID, $AW_API_SECRET);
        $parsed = json_decode($upstream['body'], true);
        if ($upstream['status'] < 200 || $upstream['status'] >= 300) {
            error_log('[intents] upstream ' . $upstream['status']);
            $detail = null;
            if (is_array($parsed)) {
                $detail = $parsed['errors'] ?? $parsed['error'] ?? $parsed;
            } else {
                $detail = substr($upstream['body'], 0, 300);
            }
            jsonResponse($upstream['status'], [
                'error' => is_array($parsed) ? ($parsed['message'] ?? 'UPSTREAM_ERROR') : 'UPSTREAM_ERROR',
                'detail' => $detail,
            ]);
        }
        $operationId = readOperationId($parsed);
        if ($operationId === null) {
            jsonResponse(502, ['error' => 'NO_OPERATION_ID']);
        }
        $status = readIntentStatus($parsed);
        $failureReason = readFailureReason($parsed);
        $out = ['operationId' => $operationId];
        if ($status !== null) {
            $out['status'] = $status;
        }
        if ($failureReason !== null) {
            $out['failureReason'] = $failureReason;
        }
        jsonResponse(200, $out);
    } catch (HttpError $e) {
        sendError($e);
    } catch (Throwable $e) {
        error_log('[intents] upstream error ' . $e->getMessage());
        jsonResponse(502, ['error' => 'UPSTREAM_FAILURE']);
    }
}

/**
 * AW → ваш сервер после approve/reject / авто-исполнения receive.
 * webhook_url задаётся на SdkApp в кабинете.
 * Подпись — HMAC тем же AW_API_SECRET, что и Bearer.
 * В проде: обновить заказ по data.operation_id + event (идемпотентно).
 * Сырой body нужен для HMAC, не распарсенный JSON.
 */
if ($method === 'POST' && $path === '/api/webhooks') {
    try {
        if ($AW_API_SECRET === '') {
            jsonResponse(503, ['error' => 'WEBHOOK_NOT_CONFIGURED']);
        }
        $raw = readRawBody(32 * 1024);
        $timestamp = requestHeader('X-Sdk-Webhook-Timestamp');
        $signature = requestHeader('X-Sdk-Webhook-Signature');
        if (!verifyWebhookSignature($raw, $timestamp, $signature, $AW_API_SECRET)) {
            jsonResponse(401, ['error' => 'INVALID_WEBHOOK_SIGNATURE']);
        }
        $event = json_decode($raw, true);
        if (!is_array($event)) {
            jsonResponse(400, ['error' => 'INVALID_JSON']);
        }
        $data = isset($event['data']) && is_array($event['data']) ? $event['data'] : [];
        $operationId = $data['operation_id'] ?? $data['operationId'] ?? null;
        $eventName = is_string($event['event'] ?? null) ? $event['event'] : 'unknown';
        error_log('[webhook] ' . $eventName . ' ' . (is_string($operationId) ? $operationId : ''));
        jsonResponse(200, ['ok' => true]);
    } catch (HttpError $e) {
        sendError($e);
    }
}

if ($STATIC_DIR !== '' && tryServeStatic($STATIC_DIR, $path)) {
    exit;
}

jsonResponse(404, [
    'error' => 'NOT_FOUND',
    'path' => $path,
    'hint' => 'Expected /health, /api/*, or static files (index.html) next to public/index.php. If the app lives in a subdirectory, open …/health on that same base URL.',
]);
