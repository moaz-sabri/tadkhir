<?php

declare(strict_types=1);

/**
 * Router script for the PHP built-in web server — single-container deployment.
 *
 *   - /api/*  -> api/index.php  (the Private Sync backend, same origin)
 *   - static  -> served from app/ (built by webpack into app/dist)
 *   - others  -> SPA fallback to app/dist/index.html (the built shell)
 *
 * Run:
 *   php -d enable_post_data_reading=0 -S 0.0.0.0:80 -t /app/app /app/docker-router.php
 *
 * The `-d enable_post_data_reading=0` is not optional for the built-in server,
 * which does not read docker/php/php.ini: it is what lets /api/share/intake read
 * a multipart body out of php://input, and therefore what lets a photo shared
 * from the phone reach the app. Everything else in this router works without it.
 */

ini_set('expose_php', '0');

/**
 * The same security headers the nginx config and api/index.php send.
 *
 * This deployment had none of them, and it is not a development-only path: the
 * README recommends it for a single-container install and `npm run dev` uses
 * it. So the app was served with no CSP, no frame-ancestors and no
 * Referrer-Policy, and every response advertised the exact PHP version.
 *
 * They live in one function so the API responses (api/index.php), the static
 * responses (here) and the container responses (docker/nginx/default.conf)
 * cannot drift into three different policies.
 */
function tt_static_security_headers(): void {
    // Measured: the built-in server emits "X-Powered-By: PHP/8.4.20" itself and
    // ignores expose_php set from inside the request, so header_remove is what
    // actually takes it off here. Both are done.
    ini_set('expose_php', '0');
    header_remove('X-Powered-By');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');

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
    $hsts = (int)(getenv('HSTS_MAX_AGE') ?: 0);
    if ($hsts > 0) {
        header('Strict-Transport-Security: max-age=' . $hsts . '; includeSubDomains');
    }
}

function tt_not_found(): bool {
    http_response_code(404);
    tt_static_security_headers();
    return true;
}

/**
 * The app shell is a BUILD OUTPUT, not a source file.
 *
 * `app/index.html` is the template webpack reads: it carries the markup, the
 * CSP and the iOS tags, and it names no stylesheet and no script. The shell the
 * browser actually receives is `app/dist/index.html`, written by the same build
 * that wrote the hashed asset names into it. Serving the template would hand out
 * a page that loads nothing, so it is refused by name below and every `/` and
 * SPA fallback is answered from the built one.
 */
const TT_SHELL_REL = '/dist/index.html';

/**
 * Whether the app was built at all.
 *
 * A missing shell is not a 404 to shrug at: it is an unbuilt checkout, and the
 * one thing the operator needs to know is that `npm run build` comes first. So
 * it says so, in the page, instead of returning a bare 404 and leaving the
 * browser to report a syntax error pointing at the wrong file.
 */
function tt_not_built(): bool {
    http_response_code(503);
    tt_static_security_headers();
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, must-revalidate');
    header('Retry-After: 30');
    echo '<!doctype html><meta charset="utf-8"><title>Not built</title>'
        . '<h1>This app has not been built</h1>'
        . '<p>The page shell is generated by the build, and it is missing.</p>'
        . '<p>Run <code>npm ci &amp;&amp; npm run build</code> and reload.</p>';
    return true;
}

/**
 * The requested path, percent-decoded and normalized, or null when the request
 * is one this router refuses to serve at all.
 *
 * The traversal check runs on the DECODED path: `%2e%2e` is three ordinary
 * characters to the router and a parent directory to the disk, so decoding
 * first and re-anchoring afterwards is what stops an encoded traversal from
 * reaching a file the plain-text form would have been stopped from reaching.
 * A NUL or control character is refused outright, because is_file() throws on a
 * NUL in PHP 8 and a probe should not become a 500.
 */
function tt_normalize_path(string $uri): ?string {
    $path = parse_url($uri, PHP_URL_PATH);
    if (!is_string($path) || $path === '') {
        return '/';
    }
    if (preg_match('/[\x00-\x1F\x7F]/', $path)) {
        return null;
    }
    $segments = [];
    foreach (explode('/', rawurldecode($path)) as $seg) {
        if ($seg === '' || $seg === '.') {
            continue;
        }
        if ($seg === '..') {
            if ($segments === []) {
                return null;   // climbed above the root
            }
            array_pop($segments);
            continue;
        }
        $segments[] = $seg;
    }
    $clean = '/' . implode('/', $segments);
    return $clean === '/' ? '/' : rtrim($clean, '/');
}

/**
 * Content types this router will serve, as a closed list.
 *
 * A closed list, because the alternative — defaulting anything unrecognised to
 * text/html — turns any future file dropped into app/ into a same-origin
 * document that runs whatever script it contains. An unknown extension is
 * refused rather than guessed at.
 */
function tt_content_type(string $ext): ?string {
    return match ($ext) {
        'js', 'mjs' => 'application/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'html' => 'text/html; charset=utf-8',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'ico' => 'image/x-icon',
        'webmanifest' => 'application/manifest+json; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'txt' => 'text/plain; charset=utf-8',
        'woff2' => 'font/woff2',
        default => null,
    };
}

$path = tt_normalize_path($_SERVER['REQUEST_URI'] ?? '/');
if ($path === null) {
    http_response_code(400);
    tt_static_security_headers();
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['ok' => false, 'error' => ['code' => 'bad_request']]);
    return true;
}

// Same-origin Private Sync API. The handler in api/index.php does its own
// routing and its own header emission; the router only has to get it there.
if ($path === '/api' || str_starts_with($path, '/api/')) {
    require __DIR__ . '/api/index.php';
    return true;
}

// Never hand out platform control files, anything with a dot-segment, or
// anything the server would execute rather than serve.
if ($path === '/_headers' || $path === '/_redirects' || str_contains($path, '/.')) {
    return tt_not_found();
}

// The unbuilt sources are not part of the running app.
//
// `app/js/` and `app/css/` sit in the document root because the image ships
// them, and webpack reads them to produce `app/dist/`. The shell loads nothing
// from them — every reference in the built page is a `/dist/` URL — so serving
// them is handing out readable, unminified, un-hashed source for a deployment
// that gains nothing by it and gives away the shape of the code for free. They
// are refused here and in docker/nginx/default.conf; the tests assert both.
if (str_starts_with($path, '/js/') || str_starts_with($path, '/css/')) {
    return tt_not_found();
}

$APP_ROOT = __DIR__ . '/app';

// `/`, `/index.html` and every SPA fallback resolve to the same built file, and
// it is answered before the static branch below so the template can never be
// reached by accident.
if ($path === '/' || $path === '/index.html' || !is_file($APP_ROOT . $path)) {
    $shell = $APP_ROOT . TT_SHELL_REL;
    if (!is_file($shell)) {
        return tt_not_built();
    }
    tt_static_security_headers();
    header('Content-Type: text/html; charset=utf-8');
    // The shell names the hashed assets, so a stale copy of it is an app
    // running last month's bundle. It is the one file that must never be
    // reused, and the service worker's network-first fetch of it is the layer
    // above this one, not a substitute for it.
    header('Cache-Control: no-store, must-revalidate');
    header('Content-Length: ' . (string)filesize($shell));
    readfile($shell);
    return true;
}

// Serve an existing static asset from app/ by hand rather than handing it back
// to the built-in server with `return false`. That path makes the server emit
// its own headers, which is why the security headers would otherwise be absent
// from every file that is not under /dist/.
$file = $APP_ROOT . $path;
if (is_file($file)) {
    // A second, filesystem-level confirmation that the resolved path is inside
    // the document root. The normalization above already guarantees it; this
    // is the assertion that keeps that guarantee true if the normalization is
    // ever changed, and it costs one call.
    $real = realpath($file);
    $realRoot = realpath($APP_ROOT);
    if ($real === false || $realRoot === false
        || !str_starts_with($real, $realRoot . DIRECTORY_SEPARATOR)) {
        return tt_not_found();
    }

    // Nothing in this document root should ever be executed, on this SAPI or
    // any other. There is no .php under app/ today; refusing the extension
    // keeps a stray one unreachable even if that stops being true.
    $ext = strtolower(pathinfo($real, PATHINFO_EXTENSION));
    if (preg_match('/^(?:php|phtml|phar|cgi|pl|py|sh|htaccess)$/i', $ext)) {
        return tt_not_found();
    }
    $type = tt_content_type($ext);
    if ($type === null) {
        return tt_not_found();
    }

    // CACHE POLICY — the same four rules docker/nginx/default.conf implements,
    // kept in the same order. These two files used to make deliberately
    // OPPOSITE choices about /dist/ (no-store here, `expires 1y` there), and
    // the disagreement was invisible until a fix shipped in a rebuild and
    // reached one deployment and not the other. If you change a rule here,
    // change it there in the same commit; the tests assert the two agree.
    //
    //   1. A content-hashed asset is immutable for a year. The name changes
    //      whenever the bytes change (webpack `[contenthash:8]`), so there is
    //      nothing to revalidate and nothing a stale copy can cost. This is the
    //      rule that only became safe once the names were hashed.
    //   2. The shell and /sw.js are never stored. The shell names the hashed
    //      assets, so a stale shell is an app running an old bundle; a cached
    //      service worker is one the browser stops re-reading, so a new
    //      release's worker never installs. Note what is NOT the reason: the
    //      service worker below is network-first for `/dist/` and can be kept
    //      network-first precisely because these names are immutable.
    //   3. The manifest is revalidated every time. It is what the browser
    //      decides installability and the share target against, and it is
    //      served as `application/octet-stream` when a host has no mapping for
    //      the extension — which fails the install criteria outright.
    //   4. Icons are long-lived. They change only with a release, they are the
    //      one thing a home screen keeps asking for, and 30 days matches nginx.
    if (preg_match('#^/dist/[^/]*\.[0-9a-f]{8}\.(?:js|css)$#', $path) === 1) {
        $cache = 'public, max-age=31536000, immutable';
    } elseif ($path === '/sw.js' || $path === TT_SHELL_REL || $ext === 'html') {
        $cache = 'no-store, must-revalidate';
    } elseif ($path === '/manifest.webmanifest') {
        $cache = 'no-cache, must-revalidate';
    } elseif (str_starts_with($path, '/icons/')) {
        $cache = 'public, max-age=2592000, must-revalidate';
    } else {
        $cache = 'no-cache, must-revalidate';
    }

    tt_static_security_headers();
    header('Content-Type: ' . $type);
    header('Cache-Control: ' . $cache);
    header('Content-Length: ' . (string)filesize($real));
    readfile($real);
    return true;
}

// Nothing on disk matched, so this is an in-app route: the shell decides.
$shell = $APP_ROOT . TT_SHELL_REL;
if (!is_file($shell)) {
    return tt_not_built();
}
tt_static_security_headers();
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store, must-revalidate');
header('Content-Length: ' . (string)filesize($shell));
readfile($shell);
return true;
