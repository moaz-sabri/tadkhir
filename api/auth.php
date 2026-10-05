<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';

/**
 * Authentication for Private Sync Spaces.
 *
 * Model:
 *   - A "space" is created once with a code + password. The password is
 *     hashed server-side (Argon2id where the build has it, bcrypt otherwise)
 *     and is never usable as an API credential — the client only sends it
 *     during create/open.
 *   - Successful auth opens a server-side session (24h live). The browser
 *     holds an HttpOnly, SameSite=Lax, Secure-in-prod cookie; JavaScript can
 *     never read it, so no credential is shipped in JS or stored in IndexedDB.
 *   - Each device registers an identity (id + optional label). Identities are
 *     informational only; authentication is always the session.
 *   - No recovery / password reset exists by design. A lost password means the
 *     space cannot be opened from new devices; existing cloned/backup data and
 *     other devices that still hold a live session are unaffected.
 *
 * Every state-changing entry point below re-derives the space from the session
 * cookie. No handler accepts a space id, a device id, or any other owner
 * reference from the request, so there is no identifier for a caller to swap
 * and no IDOR surface to close.
 */

function tt_cookie_name(): string {
    return task_timer_config()['cookie_name'];
}

function tt_cookie_options(): array {
    $cfg = task_timer_config();
    $cross = defined('TT_SESSION_CROSS_ORIGIN') && TT_SESSION_CROSS_ORIGIN;
    return [
        'expires'  => time() + $cfg['session_lifetime'],
        'path'     => '/',
        'secure'   => $cross || $cfg['cookie_secure'],
        'httponly' => true,
        'samesite' => $cross ? 'None' : 'Lax',
    ];
}

/**
 * A hash to run password_verify() against when the submitted code does not
 * exist, so that "no such space" and "wrong password" cost the same.
 *
 * This is a real constant, not a random string: it must never match, and it
 * must be a valid hash of the right algorithm so the verify itself is as
 * expensive as the real one. Generated once per process from a value nobody
 * can guess.
 */
function tt_decoy_hash(): string {
    static $hash = null;
    if ($hash === null) {
        $hash = password_hash(bin2hex(random_bytes(16)), task_timer_password_algo());
    }
    return $hash;
}

/** Hash a password with the algorithm this build resolved to. */
function tt_hash_password(string $password): string {
    return password_hash($password, task_timer_password_algo());
}

function tt_set_session_cookie(string $token): void {
    setcookie(tt_cookie_name(), $token, tt_cookie_options());
}

function tt_clear_session_cookie(): void {
    $opts = tt_cookie_options();
    $opts['expires'] = time() - 3600;
    setcookie(tt_cookie_name(), '', $opts);
}

function tt_session_token(): string {
    return (string)($_COOKIE[tt_cookie_name()] ?? '');
}

/** Resolve a session cookie to a space id (or null when invalid/expired). */
function tt_session_space_id(): ?int {
    $token = tt_session_token();
    if ($token === '') {
        return null;
    }
    $hash = hash('sha256', $token);
    $f = task_timer_db()->prepare('SELECT space_id, expires_at FROM sessions WHERE token_hash = ?');
    $f->execute([$hash]);
    $row = $f->fetch();
    if ($row === false) {
        return null;
    }
    if ((int)$row['expires_at'] <= time()) {
        task_timer_db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$hash]);
        return null;
    }
    return (int)$row['space_id'];
}

function tt_require_session(): int {
    $sid = tt_session_space_id();
    if ($sid === null) {
        tt_error(401, 'unauthorized');
    }
    return $sid;
}

/* ------------------------------ Rate limiting ---------------------------- */

/**
 * Per-IP counters, one budget per scope.
 *
 * The scope is part of the key because the two authentication endpoints have
 * genuinely different abuse shapes and must not share a budget: `open` is
 * expensive only when the space exists (so it is metered by FAILURES, and a
 * success clears the counter), while `create` hashes a password on every call
 * whether or not the space exists (so it is metered by ATTEMPTS, and a success
 * clears nothing). Sharing one counter let a script that only ever called
 * `create` lock the owner of a space out of their own login.
 */
function tt_request_ip(): string {
    // REMOTE_ADDR only. The proxy headers that would let a client choose its own
    // identity (X-Forwarded-For and friends) are deliberately NOT consulted: if
    // the app is deployed behind a proxy that sets them, trusting them hands
    // every attacker an unlimited supply of "IP addresses" to rate-limit
    // against. Behind the bundled nginx, fastcgi_params already sets REMOTE_ADDR
    // to the real peer address, so nothing is lost.
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function tt_rate_bump(string $ip, string $scope): void {
    $cfg = task_timer_config();
    $now = time();
    // When the window has expired the counter restarts from 1; otherwise it
    // increments. window_start is only advanced once the window is stale, so a
    // burst within a window keeps counting and a fresh window starts clean.
    //
    // The `? - window_start > ?` comparisons must bind real integers: PDO binds
    // plain execute() arrays as strings, and in SQLite an INTEGER never
    // compares greater than TEXT, so the expiry branch would never fire.
    $st = task_timer_db()->prepare(
        'INSERT INTO auth_failures (ip, scope, count, window_start)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(ip, scope) DO UPDATE SET
            count = CASE WHEN ? - window_start > ? THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN ? - window_start > ? THEN ? ELSE window_start END'
    );
    $window = $cfg['rate_window'];
    $st->bindValue(1, $ip, PDO::PARAM_STR);
    $st->bindValue(2, $scope, PDO::PARAM_STR);
    $st->bindValue(3, $now, PDO::PARAM_INT);
    $st->bindValue(4, $now, PDO::PARAM_INT);
    $st->bindValue(5, $window, PDO::PARAM_INT);
    $st->bindValue(6, $now, PDO::PARAM_INT);
    $st->bindValue(7, $window, PDO::PARAM_INT);
    $st->bindValue(8, $now, PDO::PARAM_INT);
    $st->execute();
}

function tt_rate_clear(string $ip, string $scope): void {
    task_timer_db()->prepare('DELETE FROM auth_failures WHERE ip = ? AND scope = ?')
        ->execute([$ip, $scope]);
}

function tt_check_rate_limit(string $ip, string $scope, int $max): void {
    $cfg = task_timer_config();
    $db = task_timer_db();
    $row = $db->prepare('SELECT count, window_start FROM auth_failures WHERE ip = ? AND scope = ?');
    $row->execute([$ip, $scope]);
    $f = $row->fetch();
    if ($f === false) {
        return;
    }
    if (time() - (int)$f['window_start'] > $cfg['rate_window']) {
        tt_rate_clear($ip, $scope);
        return;
    }
    if ((int)$f['count'] >= $max) {
        tt_error(429, 'rate_limited');
    }
}

function tt_rate_check_open(string $ip): void {
    tt_check_rate_limit($ip, 'open', (int)task_timer_config()['rate_max']);
}

/**
 * The auth/create budget: check it, then charge one unit.
 *
 * Charge-and-check in one place, called immediately before the password hash,
 * so the budget bounds the only expensive step in the handler. Everything
 * before it is a regex and an indexed SELECT: a caller sending a million
 * malformed bodies costs almost nothing and should not be able to spend the
 * budget of the people behind the same address.
 */
function tt_rate_take_create(string $ip): void {
    tt_check_rate_limit($ip, 'create', (int)task_timer_config()['rate_max_create']);
    tt_rate_bump($ip, 'create');
}

/* ------------------------------- Sessions -------------------------------- */

/**
 * Drop the space's oldest sessions until it is back under its cap.
 *
 * Without a cap the sessions table grows without bound from a single valid
 * password: `open` inserts a row on every successful login and nothing removes
 * one except the caller's own logout or a 24h expiry, and the device cap does
 * not help because one device may log in repeatedly (measured: 30 logins from
 * one device id produced 31 live sessions). Each live row is a cookie granting
 * full access to the space, so this bounds both storage and the number of
 * credentials in circulation.
 *
 * Only the space being logged into is touched, and only the excess is removed.
 */
function tt_enforce_session_cap(int $spaceId): void {
    $cap = (int)task_timer_config()['max_auth_sessions_per_space'];
    $db = task_timer_db();
    $st = $db->prepare('SELECT COUNT(*) FROM sessions WHERE space_id = ?');
    $st->execute([$spaceId]);
    $live = (int)$st->fetchColumn();
    // Trim to one BELOW the cap, because the caller inserts immediately after
    // this returns. Trimming to exactly the cap left the count one over: a
    // check of `live <= cap` on a full space skipped the trim, and the insert
    // then made it cap+1 — measured 9 live sessions against a cap of 8.
    if ($live < $cap) {
        return;
    }
    $drop = $db->prepare(
        'DELETE FROM sessions WHERE id IN (
             SELECT id FROM sessions WHERE space_id = ? ORDER BY created_at ASC, id ASC LIMIT ?
         )'
    );
    $drop->execute([$spaceId, $live - $cap + 1]);
}

function tt_start_session(int $spaceId): void {
    $cfg = task_timer_config();
    $token = bin2hex(random_bytes(32));
    $now = time();
    tt_enforce_session_cap($spaceId);
    task_timer_db()->prepare(
        'INSERT INTO sessions (space_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)'
    )->execute([$spaceId, hash('sha256', $token), $now, $now + $cfg['session_lifetime']]);
    tt_set_session_cookie($token);
}

/**
 * The expiry of the caller's own session, in milliseconds, or null when there
 * is no valid session.
 *
 * Read from the stored row rather than recomputed as now()+lifetime: the two
 * disagree for any session that was not created in this very request, and a
 * client painting a countdown from a freshly invented "now + 24h" would keep
 * showing a live session after the server had already expired it.
 */
function tt_session_expiry(): ?int {
    $token = tt_session_token();
    if ($token === '') {
        return null;
    }
    $f = task_timer_db()->prepare('SELECT expires_at FROM sessions WHERE token_hash = ?');
    $f->execute([hash('sha256', $token)]);
    $row = $f->fetch();
    return $row === false ? null : (int)$row['expires_at'] * 1000;
}

/* ------------------------------ Devices ---------------------------------- */

/**
 * Per-space device cap: the space can be opened from at most
 * max_devices_per_space distinct devices. Existing devices are always allowed
 * back in (identity refresh); only brand-new identities are limited. Stale
 * devices (no push/pull for DEVICE_GC_AGE, 90 days default) are removed by
 * api/gc.php, which frees a slot.
 */
function tt_enforce_device_cap(int $spaceId): void {
    $cfg = task_timer_config();
    $st = task_timer_db()->prepare('SELECT COUNT(*) AS c FROM devices WHERE space_id = ?');
    $st->execute([$spaceId]);
    if ((int)$st->fetchColumn() >= (int)$cfg['max_devices_per_space']) {
        tt_error(409, 'device_limit');
    }
}

function tt_register_device(int $spaceId, string $deviceId, string $deviceLabel): void {
    $now = time();
    $db = task_timer_db();
    $label = $deviceLabel !== '' ? $deviceLabel : null;

    $stSel = $db->prepare('SELECT 1 FROM devices WHERE space_id = ? AND device_id = ?');
    $stSel->execute([$spaceId, $deviceId]);
    if ($stSel->fetch() !== false) {
        // last_seen_at only, and deliberately NOT the label. A device id is an
        // identifier the client picks for itself and carries no proof, so any
        // member of the space can claim any id. Writing the label here let one
        // member rename another's device just by logging in with that id
        // (confirmed: a second device's "My Phone" became
        // "RENAMED-BY-ATTACKER"). The first label to claim an id keeps it — a
        // display name, not a security boundary, and nothing that can be
        // trusted to identify a device.
        $db->prepare('UPDATE devices SET last_seen_at = ? WHERE space_id = ? AND device_id = ?')
            ->execute([$now, $spaceId, $deviceId]);
        return;
    }

    tt_enforce_device_cap($spaceId);
    $db->prepare(
        'INSERT INTO devices (space_id, device_id, label, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)'
    )->execute([$spaceId, $deviceId, $label, $now, $now]);
}

/* ------------------------------ Handlers --------------------------------- */

/**
 * Read and validate the shared auth body.
 *
 * Every field is checked for TYPE first, and a wrong type is refused rather
 * than cast. `(string)['a']` is "Array" in PHP, and "Array" passes the space
 * code regex — so before this, a body of {"code":["a"],"password":...} created
 * a space whose code was literally the word "Array", and any two callers
 * sending an array collided on the one row that name maps to.
 */
function tt_read_auth_body(array $body): array {
    $code = $body['code'] ?? null;
    $password = $body['password'] ?? null;
    $device = $body['device'] ?? null;
    $deviceId = is_array($device) ? ($device['id'] ?? null) : null;
    $deviceLabel = is_array($device) ? ($device['label'] ?? null) : null;

    if (!is_string($code) || !preg_match('/^[A-Za-z0-9_-]{3,64}$/', $code)) {
        tt_error(400, 'invalid_code');
    }
    if (!is_string($password)) {
        tt_error(400, 'invalid_credentials_shape');
    }
    $maxPassword = (int)task_timer_config()['max_password_bytes'];
    // A ceiling, not a policy: Argon2id has no input limit, but the bcrypt
    // fallback this build may resolve to silently ignores everything past byte
    // 72, so a 500-character password whose first 72 bytes are right would
    // authenticate against a completely different one. Rejecting the absurd
    // length is what makes the two algorithms behave the same way.
    if (strlen($password) > $maxPassword) {
        tt_error(400, 'password_too_long');
    }
    if (strlen($password) < 8) {
        tt_error(400, 'password_too_short');
    }
    if (!is_string($deviceId) || $deviceId === '' || strlen($deviceId) > 128
        || preg_match('/[\x00-\x1F\x7F]/', $deviceId)) {
        tt_error(400, 'invalid_device');
    }
    // The label is stored verbatim, so it needs the same ceiling the id has.
    // Without one a 1-byte request could park megabytes in `devices`.
    $maxLabel = (int)task_timer_config()['max_device_label_len'];
    if ($deviceLabel !== null && !is_string($deviceLabel)) {
        tt_error(400, 'invalid_device');
    }
    $deviceLabel = (string)$deviceLabel;
    if (strlen($deviceLabel) > $maxLabel) {
        tt_error(400, 'invalid_device');
    }
    return [$code, $password, $deviceId, $deviceLabel];
}

/** POST /api/auth/create — first device of a space. */
function task_timer_auth_create(array $body): array {
    $ip = tt_request_ip();

    [$code, $password, $deviceId, $deviceLabel] = tt_read_auth_body($body);
    $db = task_timer_db();
    $count = $db->query('SELECT COUNT(*) FROM spaces')->fetchColumn();
    if ((int)$count >= (int)task_timer_config()['max_spaces']) {
        tt_error(503, 'space_limit');
    }

    $exists = $db->prepare('SELECT id FROM spaces WHERE code = ?');
    $exists->execute([$code]);
    if ($exists->fetch() !== false) {
        tt_error(409, 'space_exists');
    }

    // Charged immediately before the hash. `create` is the one endpoint that
    // computes a full password hash on every call, unauthenticated, and it was
    // metered by nothing at all: measured at ~17x the cost of a trivial request
    // with no failure mode that ever trips the `open` budget, so a script that
    // only ever called `create` could saturate every php-fpm worker and add a
    // permanent row to `spaces` per request.
    tt_rate_take_create($ip);

    // The UNIQUE constraint on spaces.code is the real arbiter; this try/catch
    // turns the losing side of a race between two simultaneous creates of the
    // same code into the same 409 the loser would have got from the SELECT, and
    // spares the global exception handler from logging a constraint violation.
    try {
        $db->prepare('INSERT INTO spaces (code, password_hash, created_at) VALUES (?, ?, ?)')
            ->execute([$code, tt_hash_password($password), time()]);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'UNIQUE')) {
            tt_error(409, 'space_exists');
        }
        throw $e;
    }

    $spaceId = (int)$db->lastInsertId();
    tt_register_device($spaceId, $deviceId, $deviceLabel);
    tt_start_session($spaceId);

    $cfg = task_timer_config();
    return ['ok' => true, 'spaceId' => $spaceId, 'expiresAt' => (time() + $cfg['session_lifetime']) * 1000];
}

/** POST /api/auth/open — subsequent devices (or a fresh session). */
function task_timer_auth_open(array $body): array {
    $ip = tt_request_ip();
    tt_rate_check_open($ip);

    [$code, $password, $deviceId, $deviceLabel] = tt_read_auth_body($body);

    $f = task_timer_db()->prepare('SELECT id, password_hash FROM spaces WHERE code = ?');
    $f->execute([$code]);
    $row = $f->fetch();

    // Same 401 for unknown code and wrong password: no enumeration in the
    // RESPONSE. It was still enumerable in the TIMING, because the real hash
    // was only ever computed when the code existed — measured 19ms for an
    // unknown code against 130ms for a wrong password, a 6.8x gap that
    // enumerates the whole table of codes for free. Verifying against a decoy
    // hash when the code is unknown makes both paths do the same work.
    $hash = $row === false ? tt_decoy_hash() : (string)$row['password_hash'];
    $verified = password_verify($password, $hash);

    if ($row === false || !$verified) {
        tt_rate_bump($ip, 'open');
        tt_error(401, 'invalid_credentials');
    }

    // An account created before this build hashed with bcrypt, or with an older
    // Argon2id cost. Re-hash now that the password is in hand, so the stored
    // hash follows the current policy without a migration or a forced re-login.
    if (password_needs_rehash($hash, task_timer_password_algo())) {
        task_timer_db()->prepare('UPDATE spaces SET password_hash = ? WHERE id = ?')
            ->execute([tt_hash_password($password), (int)$row['id']]);
    }

    tt_rate_clear($ip, 'open');
    $spaceId = (int)$row['id'];
    tt_register_device($spaceId, $deviceId, $deviceLabel);
    tt_start_session($spaceId);

    $cfg = task_timer_config();
    return ['ok' => true, 'spaceId' => $spaceId, 'expiresAt' => (time() + $cfg['session_lifetime']) * 1000];
}

/** POST /api/auth/rotate — rotate session token every 24h. Validates existing session and issues a new token. */
function task_timer_auth_rotate(): array {
    $spaceId = tt_require_session();
    $token = tt_session_token();
    if ($token !== '') {
        task_timer_db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
    }
    // No tt_clear_session_cookie() here. It used to delete the cookie and then
    // immediately set a new one of the same name, so the response carried two
    // Set-Cookie headers for one cookie: browsers apply the last, but any client
    // that reads the first (including this test suite's own helper) sees the
    // empty expiry value and concludes the rotation issued nothing. The new
    // cookie overwrites the old one on its own.
    tt_start_session($spaceId);
    $cfg = task_timer_config();
    return ['ok' => true, 'expiresAt' => (time() + $cfg['session_lifetime']) * 1000];
}

/** POST /api/auth/logout — drop the session and clear the cookie. */
function task_timer_auth_logout(): array {
    $token = tt_session_token();
    if ($token !== '') {
        task_timer_db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
    }
    tt_clear_session_cookie();
    return ['ok' => true];
}

/** POST /api/auth/status (body irrelevant) — is the current session valid? */
function task_timer_auth_status(): array {
    $spaceId = tt_session_space_id();
    if ($spaceId === null) {
        return ['ok' => true, 'authenticated' => false, 'spaceId' => null, 'expiresAt' => null];
    }
    $st = task_timer_db()->prepare('SELECT COUNT(*) AS c FROM devices WHERE space_id = ?');
    $st->execute([$spaceId]);
    $devices = (int)$st->fetchColumn();
    return [
        'ok'            => true,
        'authenticated' => true,
        'spaceId'       => $spaceId,
        'deviceCount'   => $devices,
        'deviceLimit'   => (int)task_timer_config()['max_devices_per_space'],
        'expiresAt'     => tt_session_expiry(),
    ];
}