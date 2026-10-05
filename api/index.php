<?php

declare(strict_types=1);

/**
 * Front controller.
 *
 * Private Sync Space API:
 *   - POST /api/auth/create   create a space (code + password)
 *   - POST /api/auth/open     open a space (24h session cookie)
 *   - POST /api/auth/rotate   reissue the current session's token
 *   - POST /api/auth/logout   invalidate the current session
 *   - POST /api/auth/status   is the current session valid?
 *   - POST /api/sync/push     apply client changes (last-write-wins)
 *   - POST /api/sync/pull     return changes after a cursor
 *   - GET  /api/health        liveness probe (no secrets)
 *
 * Runs as the built-in PHP router script too:
 *   php -S localhost:8787 api/index.php
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/sync.php';
require_once __DIR__ . '/share-intake.php';

error_reporting(0);
ini_set('display_errors', '0');
// The interpreter's version is not the caller's business, and the response it
// decorates with "X-Powered-By: PHP/8.4.20" is emitted before any of this file's
// code runs on some SAPIs. This is the one setting that can still be changed
// from inside the request, and it is set here rather than only in the Docker
// php.ini so that `npm run dev` and the bare built-in server are covered too.
// (tt_security_headers() also calls header_remove, which is what actually takes
// the header off the built-in server — see the note there.)
ini_set('expose_php', '0');

mb_internal_encoding('UTF-8');

/* ---------------------------- Response headers --------------------------- */

/**
 * The security headers, sent on every response this front controller produces.
 *
 * They are also declared in docker/nginx/default.conf for the container
 * deployment, and in app/_headers for the static-hosting one. They are
 * repeated here because the fourth deployment — `php -S docker-router.php`,
 * which is what `npm run dev` runs and what the README recommends for a
 * single-container install — had none of them at all: no CSP, no
 * frame-ancestors, no Referrer-Policy. Set once, in one array, so a header
 * cannot be added in one place and forgotten in another.
 */
function tt_security_headers(): void {
    // The built-in server adds "X-Powered-By: PHP/8.4.20" itself, and it
    // ignores expose_php set from inside the request (measured: ini_set alone
    // leaves the header in place on the CLI server, header_remove takes it out).
    // Under php-fpm the ini below is what does it. Both are done, so the header
    // is gone on every SAPI this app runs on.
    ini_set('expose_php', '0');
    header_remove('X-Powered-By');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    // script-src/style-src stay 'self' with no unsafe-inline, which is why dom.js
    // routes the `style` prop through CSSOM instead of the style attribute.
    // object-src is 'none' rather than left to fall back to default-src: the
    // fallback would be 'self', which still permits a same-origin plugin.

    // `form-action 'none'` becomes `form-action 'self'` for one reason: the Web
    // Share Target is a FORM POST. A manifest share target that can carry
    // `files` is `POST` with `multipart/form-data`, so the browser navigates to
    // /api/share/intake by submitting a form — and `form-action 'none'` blocks
    // the one navigation the app's most-used entry point depends on.
    //
    // `img-src` and `media-src` gain `blob:` because every attachment is shown
    // from a Blob URL built in the page: IndexedDB is the only place a captured
    // photograph exists, so without it every thumbnail renders as an empty box.
    // `media-src` had no declaration at all and was falling back to
    // default-src 'self', which does not include blob: either — which is why the
    // voice memo and video players are named explicitly rather than left to a
    // fallback that never covered them.
    //
    // `camera=(self), microphone=(self)` replaces `camera=(), microphone=()`: the
    // feature that header forbade is the one this release adds, and an empty
    // allowlist is a refusal no page in this origin can lift. Both stay scoped to
    // this origin, so a third-party frame still cannot reach either.
    header(
        "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; "
        . "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; "
        . "connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; "
        . "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
    $hsts = (int)task_timer_config()['hsts_max_age'];
    if ($hsts > 0) {
        header('Strict-Transport-Security: max-age=' . $hsts . '; includeSubDomains');
    }
}

function tt_json(int $status, array $body): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    tt_security_headers();
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function tt_error(int $status, string $code): void {
    tt_json($status, ['ok' => false, 'error' => ['code' => $code]]);
}

/* --------------------------------- CORS ---------------------------------- */

/**
 * The origin to mirror, or '' for "same-origin only".
 *
 * A wildcard is NOT an origin. Returning '*' here produced
 * `Access-Control-Allow-Origin: *` together with
 * `Access-Control-Allow-Credentials: true`, which is a contradiction the spec
 * resolves by rejecting the response — so the effect was a configuration that
 * looks like it allows cross-origin credentialed reads and in fact allows
 * none, plus a wildcard that any page can read non-credentialed responses from.
 * A wildcard is now treated as "not configured": same-origin only, which is
 * what an unset ALLOWED_ORIGIN already means and what a same-origin install
 * actually wants.
 */
function tt_cors_origin(): string {
    $allowed = trim((string)task_timer_config()['allowed_origin']);
    if ($allowed === '' || $allowed === '*') {
        return '';
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    return $origin !== '' && hash_equals($allowed, $origin) ? $allowed : '';
}

function tt_cors_headers(string $origin): void {
    // A specific origin only — never '*'. Credentials are permitted because the
    // comparison above is an equality check against a configured allowlist
    // entry, which is the one case where ACAO + credentials is meaningful.
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin, Access-Control-Request-Headers');
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 600');
}

set_exception_handler(function (Throwable $e): void {
    // The message can name a table and a constraint (never a bound value, so
    // never a password or a token), which is what makes it useful in a log. The
    // caller gets a bare code.
    error_log('[task-timer-sync] ' . get_class($e) . ': ' . $e->getMessage());
    if (!headers_sent()) {
        tt_error(500, 'internal');
    }
});

/* ------------------------- Cookies on cross-origin ----------------------- */

// Cookies work without special handling on the same origin (recommended).
// For a cross-origin frontend, ALLOWED_ORIGIN switches the session cookie to
// SameSite=None + Secure and mirrors the origin, so cookies follow requests.
function tt_apply_cross_origin_cookie_policy(): void {
    $allowed = (string)task_timer_config()['allowed_origin'];
    if ($allowed === '' || $allowed === '*') {
        return;
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && hash_equals($allowed, $origin)) {
        define('TT_SESSION_CROSS_ORIGIN', true);
    }
}

function tt_cookie_is_cross_origin(): bool {
    return defined('TT_SESSION_CROSS_ORIGIN') && TT_SESSION_CROSS_ORIGIN;
}

/* ------------------------------- Routing -------------------------------- */

/**
 * The request path, normalized to a canonical form.
 *
 * Percent-decoding happens here and nowhere else, and it happens BEFORE the
 * route is matched — so a handler can never be reached through an encoded path
 * that reads one way to a proxy in front of it and another way to the app.
 *
 * A `..` segment is REJECTED rather than resolved. Collapsing it would be the
 * usual, and defensible, behaviour, and it would make
 * `/public/../api/sync/pull` arrive as `/api/sync/pull` — correct in isolation,
 * but the whole point of the check is that an operator's reverse proxy sees the
 * raw string `/public/../api/sync/pull` and may not consider it to be under
 * `/api/`. The API has no legitimate use for `..` anywhere, so refusing it
 * removes the possibility of the two parsers disagreeing instead of relying on
 * them to agree.
 */
function tt_request_path(): string {
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    $path = parse_url($uri, PHP_URL_PATH);
    if (!is_string($path) || $path === '') {
        return '/';
    }
    // Control characters and NUL are never a path this app serves, and they are
    // the raw shape most likely to slip past a proxy's own filter.
    if (preg_match('/[\x00-\x1F\x7F]/', $path)) {
        return '';
    }
    // An encoded path separator is refused before decoding, not resolved by it.
    // Decoding %2f into / would make /api/auth%2fstatus reach the same handler as
    // /api/auth/status, which is defensible in isolation but is precisely the
    // shape where an operator's proxy and this app can disagree about what the
    // path is. No legitimate request to this API contains one.
    if (preg_match('/%(?:2f|5c)/i', $path)) {
        return '';
    }
    $decoded = rawurldecode($path);
    $segments = [];
    foreach (explode('/', $decoded) as $seg) {
        if ($seg === '..') {
            return '';
        }
        if ($seg === '' || $seg === '.') {
            continue;
        }
        $segments[] = $seg;
    }
    $clean = '/' . implode('/', $segments);
    return $clean === '/' ? '/' : rtrim($clean, '/');
}

// EXACT match, not a suffix. `str_ends_with($path, '/auth/open')` meant that
// /whatever/auth/open, /index.html/auth/open and /api/../api/auth/open all
// reached the same handler (confirmed for each). Nothing in the app needs that
// flexibility, and it defeats any path-based rule a reverse proxy in front of
// the app might apply — a proxy that allowed only /api/ would have been
// bypassable through any prefix at all.
function tt_route(string $path): string {
    $routes = [
        '/api/health'       => 'health',
        '/api/auth/create' => 'create',
        '/api/auth/open'   => 'open',
        '/api/auth/rotate' => 'rotate',
        '/api/auth/logout' => 'logout',
        '/api/auth/status' => 'status',
        '/api/sync/push'   => 'push',
        '/api/sync/pull'   => 'pull',
        // The share intake. Three methods on one path — POST parks what the OS
        // shared, GET reads it back in two shapes (the metadata, and one file's
        // bytes at a time), DELETE forgets it — so it is dispatched before the
        // "a real path with the wrong verb is a 405" rule below, which is about
        // the single-method JSON API.
        '/api/share/intake' => 'share_intake',
    ];
    return $routes[$path] ?? '';
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = tt_request_path();

if ($path === '') {
    // A path this app refuses to serve at all: a traversal segment, or a control
    // character. Answered the same way as any other unroutable request, so the
    // response says nothing about what the path was.
    tt_error(400, 'bad_request');
}

$origin = tt_cors_origin();
if ($origin !== '') {
    tt_cors_headers($origin);
    tt_apply_cross_origin_cookie_policy();
}

if ($method === 'OPTIONS') {
    if ($origin !== '') {
        http_response_code(204);
        tt_security_headers();
        exit;
    }
    tt_error(404, 'not_found');
}

$route = tt_route($path);

// The request-size ceiling, applied to EVERY request before anything else runs:
// before routing to a handler, before authentication, and before a body is
// read. It used to live inside the body parser, which meant the three handlers
// that never parse a body (auth/status, auth/logout, auth/rotate) accepted a
// 200,000-byte body with REQUEST_MAX_BYTES set to 2,048 — and meant the
// unauthenticated sync endpoints buffered a body up to post_max_bytes before
// the app's own limit was ever consulted. One check, first, closes both.
// The share intake is exempt, and the exemption is stated rather than implicit:
// it is the one endpoint whose legitimate body is larger than a JSON push — a
// photograph off a phone is megabytes — so it carries its own ceiling, applied
// inside tt_share_intake_post() and bounded by SHARE_MAX_BYTES. Every other POST
// is held to request_max_bytes, which is what keeps an unauthenticated caller
// from allocating a large body here.
if ($method === 'POST' && $route !== 'share_intake') {
    $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declared > task_timer_config()['request_max_bytes']) {
        tt_error(413, 'payload_too_large');
    }
}

// A wrong method on a real path is a 405, not a 404: it tells the caller the
// difference between "no such endpoint" and "wrong verb", which is a routing
// fact and not a secret.
if ($route === 'health' && $method === 'GET') {
    tt_json(200, ['ok' => true, 'time' => time()]);
}

// The share intake answers its own methods and carries its own size ceiling, so
// it is dispatched before the two checks below — the 1 MiB REQUEST_MAX_BYTES
// preamble (a shared video is legitimately larger, and this endpoint is
// unauthenticated, which is exactly why it has a separate and explicit budget)
// and the POST-only rule.
if ($route === 'share_intake') {
    if ($method === 'POST') {
        tt_share_intake_post();
    }
    if ($method === 'GET') {
        // Two shapes on one path, told apart by the index: no `i` is the
        // metadata (what the chooser asks for), `i` is one file's bytes. The
        // distinction is a query parameter rather than a second route because
        // the manifest names one action, and a second path here would be a
        // second thing for an operator's proxy to allow or block.
        if (isset($_GET['i'])) {
            tt_share_intake_part();
        }
        tt_share_intake_meta();
    }
    if ($method === 'DELETE') {
        tt_share_intake_delete();
    }
    http_response_code(405);
    header('Allow: POST, GET, DELETE');
    tt_json(405, ['ok' => false, 'error' => ['code' => 'method_not_allowed']]);
}

if ($route !== '' && $method !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    tt_json(405, ['ok' => false, 'error' => ['code' => 'method_not_allowed']]);
}

switch ($route) {
    case 'create':
        tt_json(200, task_timer_auth_create(tt_body()));
        // no break — tt_json exits
    case 'open':
        tt_json(200, task_timer_auth_open(tt_body()));
    case 'rotate':
        tt_assert_body_within_limit();
        tt_json(200, task_timer_auth_rotate());
    case 'logout':
        tt_assert_body_within_limit();
        tt_json(200, task_timer_auth_logout());
    case 'status':
        tt_assert_body_within_limit();
        tt_json(200, task_timer_auth_status());
    case 'push':
        $spaceId = tt_require_session();
        tt_json(200, task_timer_push($spaceId, tt_body()));
    case 'pull':
        $spaceId = tt_require_session();
        tt_json(200, task_timer_pull($spaceId, tt_body()));
}
tt_error(404, 'not_found');

/* ------------------------------- Body ----------------------------------- */

/**
 * Read, size-check and parse the JSON body.
 *
 * Three things are checked, in this order, and each one closes a hole the
 * previous version of this function had:
 *
 *  1. The declared Content-Length, BEFORE the body is read. It used to be read
 *     into memory first and compared afterwards, so the ceiling was applied to
 *     a body that had already been allocated.
 *  2. The size ceiling for EVERY POST, including the endpoints whose handler
 *     ignores the body. `auth/status`, `auth/logout` and `auth/rotate` never
 *     called this function at all, so a 200,000-byte body was accepted with
 *     REQUEST_MAX_BYTES set to 2,048.
 *  3. The Content-Type, which must be JSON. This is the CSRF boundary and the
 *     reason is worth stating: `text/plain` is a CORS-safelisted content type,
 *     so a cross-origin page can POST it with a plain <form enctype="text/plain">
 *     and NO preflight. A form can therefore reach auth/create and auth/open —
 *     the two endpoints that need no cookie — and the browser will store the
 *     Set-Cookie the response sends back. That is login CSRF: the victim's
 *     device ends up holding a session for a space the attacker chose, and
 *     from then on its records sync into the attacker's space. Requiring
 *     application/json makes every such request a preflighted one, which the
 *     server refuses for any origin but the configured one. The cookie-based
 *     endpoints stay protected by SameSite=Lax on top of this.
 */
function tt_body(): array {
    $cfg = task_timer_config();

    $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declared > $cfg['request_max_bytes']) {
        tt_error(413, 'payload_too_large');
    }

    $type = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
    if ($type !== 'application/json') {
        tt_error(415, 'unsupported_media_type');
    }

    // A cross-site request that reached this far still has to be a preflighted
    // one, but the browser is not the only thing that can send a request. This
    // is a second, free layer: any state-changing request the browser labels
    // as cross-site or same-site-to-different-origin is refused regardless of
    // what it claimed to be.
    $fetchSite = strtolower((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? ''));
    if ($fetchSite !== '' && $fetchSite !== 'same-origin' && $fetchSite !== 'none') {
        tt_error(403, 'cross_site_blocked');
    }

    $raw = file_get_contents('php://input');
    if ($raw === false) {
        tt_error(400, 'invalid_json');
    }
    if (strlen($raw) > $cfg['request_max_bytes']) {
        tt_error(413, 'payload_too_large');
    }
    // An empty body is not JSON. json_decode('') is null, which the
    // is_array() check below also catches, but saying so directly keeps the
    // 400 the same for '' and for whitespace.
    if (trim($raw) === '') {
        tt_error(400, 'invalid_json');
    }
    $data = json_decode($raw, true, 64);
    if (!is_array($data)) {
        tt_error(400, 'invalid_json');
    }
    // A JSON document must be an object, not a list. `[1,2,3]` decoded to an
    // array too, and every field lookup on it fell through to its default.
    if (array_is_list($data) && $data !== []) {
        tt_error(400, 'invalid_json');
    }
    return $data;
}

/**
 * The size ceiling, for a request whose handler does not read the body.
 *
 * Called by the bodyless POST handlers so that the limit in (1) and (2) above
 * applies to them too, without giving them a parsed body they would ignore.
 */
function tt_assert_body_within_limit(): void {
    $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declared > task_timer_config()['request_max_bytes']) {
        tt_error(413, 'payload_too_large');
    }
    // Drain it rather than leaving a large body unread in the SAPI buffer.
    $raw = file_get_contents('php://input');
    if ($raw !== false && strlen($raw) > task_timer_config()['request_max_bytes']) {
        tt_error(413, 'payload_too_large');
    }
}
