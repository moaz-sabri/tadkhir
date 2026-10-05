<?php

declare(strict_types=1);

require_once __DIR__ . '/../db.php';

/**
 * Security regression tests for the Private Sync API.
 *
 * Required from api/tests/run.php just before the runner loop, so it can use the
 * same `it()` registration and the same request/assert helpers. Unlike the
 * functional suite, each group here boots its OWN server, because almost every
 * one of these tests is about a limit whose value has to be set for the test to
 * be able to cross it: a rate limit, a space cap, a session cap, a CORS origin,
 * a body ceiling. Sharing run.php's single server would mean every group
 * inherited one set of limits and none of them could be tested.
 *
 * Every test here is written from the attacker's side. Each one states the
 * property being defended, then tries to break it with a raw HTTP request — not
 * through the client, because the client is not what an attacker has.
 */

/* ----------------------------- harness ----------------------------------- */

$GLOBALS['tt_sec_procs'] = [];

/**
 * Boot a dedicated API server for one test, and point the shared request()
 * helper at it for the duration.
 *
 * A NEW PORT AND A NEW DATABASE PER GROUP. Both matter. Reusing the port meant
 * the second group's server could not bind, so its requests were answered by the
 * first group's still-running server — against the wrong database, with the
 * wrong limits — and every assertion about a limit silently passed or failed for
 * the wrong reason. A fresh port and a fresh file make each group independent.
 *
 * The limits are also set to values a test can actually reach: a rate limit of 3
 * trips after three requests, a space cap of 2 refuses the third. Defaults would
 * make these untestable rather than unimportant.
 */
function sec_server(string $name, array $env = []): void {
    global $port, $dbPath, $php, $nullStream;
    $tag = preg_replace('/[^a-z0-9]+/i', '-', $name) . '-' . bin2hex(random_bytes(3));
    $port = tt_pick_port();
    $dbPath = sys_get_temp_dir() . '/tt-sec-' . $tag . '.sqlite';
    foreach ([$dbPath, $dbPath . '-wal', $dbPath . '-shm'] as $f) @unlink($f);

    $merged = array_merge(getenv(), [
        'DATABASE_PATH'   => $dbPath,
        'ENVIRONMENT'     => 'development',
        // Wide by default so a group that is not about rate limiting is never
        // throttled by accident; a group that IS about it overrides this.
        'RATE_MAX'        => '500',
        'RATE_MAX_CREATE' => '500',
        'PULL_BATCH'      => '200',
        'PUSH_BATCH'      => '200',
        // Pinned rather than inherited, so a test that depends on the clock
        // window is testing the window and not whatever the ambient config is.
        'MAX_UPDATED_AT_FUTURE_MS' => '31536000000',  // 1 year
        'MAX_UPDATED_AT_AGE_MS'    => '946080000000', // 30 years
    ], $env);

    // `-d enable_post_data_reading=0` is the same setting docker/php/php.ini
    // carries, and for the same reason: the Web Share Target intake reads a
    // multipart body out of php://input, which only works when the SAPI has
    // been told not to consume the stream first. Every group here boots its own
    // server through this one function, so without the flag the share tests
    // would be asserting that the ENDPOINT is broken rather than that the
    // server was not configured for it.
    $new = proc_open(
        [$php, '-d', 'enable_post_data_reading=0', '-S', "127.0.0.1:$port", TT_BASE . '/api/index.php'],
        [1 => ['file', $nullStream, 'w'], 2 => ['file', $nullStream, 'w']],
        $pipes,
        TT_BASE,
        $merged
    );
    if (!is_resource($new)) {
        throw new RuntimeException("security test '$name': could not start a server");
    }
    $GLOBALS['tt_sec_procs'][] = [$new, $dbPath];

    for ($i = 0; $i < 120; $i++) {
        $s = @fsockopen('127.0.0.1', $port, $e, $e2, 0.2);
        if ($s) { fclose($s); return; }
        usleep(50000);
    }
    throw new RuntimeException("security test '$name': server did not come up");
}

/** A header value from a response, or '' when absent. */
function sec_header(array $res, string $name): string {
    foreach ($res['headers'] as $h) {
        if (stripos($h, $name . ':') === 0) return trim(substr($h, strlen($name) + 1));
    }
    return '';
}

/**
 * The test database, with the app's own schema applied.
 *
 * The schema is created by the server lazily, on the first request that
 * actually touches the database — and several endpoints deliberately do not
 * touch it (an anonymous sync request is refused before any query runs, and a
 * body that fails validation never reaches the data layer). A test that
 * inspects the database before its first such request would otherwise find an
 * empty file. Calling the app's own task_timer_schema() here means the tests
 * assert against the real schema rather than a copy of it that could drift.
 */
function sec_db(): PDO {
    global $dbPath;
    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    task_timer_schema($pdo);
    return $pdo;
}

function sec_error_code(array $res): string {
    return (string)($res['body']['error']['code'] ?? '');
}

/** Register a security test that runs against its own freshly configured server. */
function sec_it(string $name, array $env, callable $fn): void {
    it($name, function () use ($name, $env, $fn) {
        sec_server($name, $env);
        $fn();
    });
}

/** Stop every server this file started. */
function sec_shutdown(): void {
    global $tt_sec_procs;
    foreach ($tt_sec_procs as [$p, $dbPath]) {
        if (is_resource($p)) { proc_terminate($p); proc_close($p); }
        foreach ([$dbPath, $dbPath . '-wal', $dbPath . '-shm'] as $f) @unlink($f);
    }
    $tt_sec_procs = [];
}

const SEC_PASSWORD = 'a-long-enough-secret';
const SEC_DEVICE   = 'sec-device-1';

/* ================== 1. AUTHENTICATION ==================================== */

sec_it('auth: a valid code and password open a session', [], function () {
    $c = newSpace('sec-valid-open', SEC_PASSWORD, SEC_DEVICE);
    assertTrue($c !== '', 'a session cookie was issued');
    $r = request('POST', '/api/auth/status', [], $c);
    assertStatus($r, 200, 'status with a valid session');
    assertSame($r['body']['authenticated'], true, 'session is authenticated');
});

sec_it('auth: a wrong password is 401 and a wrong code is the same 401', [], function () {
    newSpace('sec-wrong-pw', SEC_PASSWORD, SEC_DEVICE);
    $bad = request('POST', '/api/auth/open',
        ['code' => 'sec-wrong-pw', 'password' => 'not-the-password', 'device' => ['id' => 'd2']]);
    assertStatus($bad, 401, 'wrong password');
    $missing = request('POST', '/api/auth/open',
        ['code' => 'sec-no-such-space', 'password' => 'not-the-password', 'device' => ['id' => 'd3']]);
    assertStatus($missing, 401, 'unknown code');
    // Byte-for-byte the same answer, so the response cannot be used to discover
    // which space codes exist.
    assertSame($bad['body'], $missing['body'], 'unknown code and wrong password are indistinguishable');
});

sec_it('auth: an unknown code and a wrong password cost the same time', [], function () {
    newSpace('sec-timing', SEC_PASSWORD, SEC_DEVICE);
    $time = function (array $body): float {
        $t = microtime(true);
        request('POST', '/api/auth/open', $body);
        return (microtime(true) - $t) * 1000;
    };
    // Warm the decoy hash the server generates once per process.
    $time(['code' => 'sec-nope-warm', 'password' => 'whatever-value', 'device' => ['id' => 'w1']]);

    $unknown = [];
    $wrong = [];
    for ($i = 0; $i < 6; $i++) {
        $unknown[] = $time(['code' => 'sec-nope-' . $i, 'password' => 'wrong-pass-here', 'device' => ['id' => 'u' . $i]]);
        $wrong[]   = $time(['code' => 'sec-timing', 'password' => 'wrong-pass-here', 'device' => ['id' => 'w' . $i]]);
    }
    $mu = array_sum($unknown) / count($unknown);
    $mw = array_sum($wrong) / count($wrong);

    // Before the fix this was 19ms against 130ms, because the password hash was
    // only ever computed when the space existed — a 6.8x gap that enumerates
    // the whole code table for free. The decoy hash closed it.
    assertTrue(
        $mw < $mu * 1.6,
        sprintf(
            'no timing oracle: unknown code %.1fms vs wrong password %.1fms (ratio %.2f, must be < 1.6)',
            $mu, $mw, $mw / max($mu, 0.01)
        )
    );
});

sec_it('auth: passwords are hashed with argon2id, never stored in the clear', [], function () {
    newSpace('sec-hash-algo', SEC_PASSWORD, SEC_DEVICE);
    $hash = (string)sec_db()->query("SELECT password_hash FROM spaces WHERE code = 'sec-hash-algo'")->fetchColumn();
    assertTrue($hash !== '' && $hash !== SEC_PASSWORD, 'the password is not the stored value');
    if (in_array('argon2id', password_algos(), true)) {
        assertTrue(str_starts_with($hash, '$argon2id$'), 'stored as an argon2id hash, got ' . substr($hash, 0, 12));
    }
    assertTrue(!str_contains($hash, SEC_PASSWORD), 'the password does not appear inside the hash');
});

sec_it('auth: a password is never truncated (the bcrypt 72-byte weakness)', [], function () {
    // PASSWORD_DEFAULT was bcrypt, which silently ignores everything past byte
    // 72. Confirmed exploitable before the fix: a 100-character password opened
    // with any other 100-character password sharing the first 72 bytes.
    $pw = str_repeat('A', 100);
    newSpace('sec-truncation', $pw, SEC_DEVICE);

    $same = request('POST', '/api/auth/open',
        ['code' => 'sec-truncation', 'password' => $pw . 'DIFFERENT-TAIL', 'device' => ['id' => 'd2']]);
    assertStatus($same, 401, 'a different tail past byte 72 must not authenticate');

    $right = request('POST', '/api/auth/open',
        ['code' => 'sec-truncation', 'password' => $pw, 'device' => ['id' => 'd3']]);
    assertStatus($right, 200, 'the real password still opens the space');
});

sec_it('auth: an over-long password is refused rather than silently truncated', [], function () {
    $r = request('POST', '/api/auth/create',
        ['code' => 'sec-longpw', 'password' => str_repeat('p', 100000), 'device' => ['id' => 'd1']]);
    assertStatus($r, 400, 'a 100,000-character password');
    assertSame(sec_error_code($r), 'password_too_long', 'refused as too long');
});

sec_it('auth: a legacy bcrypt account still opens and is upgraded on login', [], function () {
    // An account created before this change holds a bcrypt hash, whose 72-byte
    // truncation is exactly the weakness argon2id removes. It must keep working,
    // and be re-hashed the next time the password is in hand.
    $legacy = str_repeat('B', 72);
    $db = sec_db();
    $db->exec(sprintf(
        'INSERT INTO spaces (code, password_hash, created_at) VALUES (%s, %s, %d)',
        $db->quote('sec-legacy-bcrypt'),
        $db->quote(password_hash($legacy, PASSWORD_BCRYPT)),
        time()
    ));

    $r = request('POST', '/api/auth/open',
        ['code' => 'sec-legacy-bcrypt', 'password' => $legacy, 'device' => ['id' => 'd1']]);
    assertStatus($r, 200, 'a bcrypt-hashed account still authenticates');

    if (in_array('argon2id', password_algos(), true)) {
        $after = (string)sec_db()->query("SELECT password_hash FROM spaces WHERE code = 'sec-legacy-bcrypt'")->fetchColumn();
        assertTrue(str_starts_with($after, '$argon2id$'), 'the hash was upgraded to argon2id on login');
    }
    $r = request('POST', '/api/auth/open',
        ['code' => 'sec-legacy-bcrypt', 'password' => $legacy, 'device' => ['id' => 'd2']]);
    assertStatus($r, 200, 'and still authenticates after the upgrade');
});

sec_it('auth: failed logins are rate limited per IP', ['RATE_MAX' => '3', 'RATE_WINDOW' => '900'], function () {
    newSpace('sec-rl-space', SEC_PASSWORD, SEC_DEVICE);
    $codes = [];
    for ($i = 0; $i < 6; $i++) {
        $codes[] = request('POST', '/api/auth/open',
            ['code' => 'sec-rl-space', 'password' => 'wrong-pass-here', 'device' => ['id' => 'd' . $i]])['status'];
    }
    assertTrue(in_array(429, $codes, true), 'the limiter fires: ' . implode(',', $codes));
    assertSame(count(array_keys($codes, 401, true)), 3, 'exactly the budget is answered 401, the rest 429');
});

sec_it('auth: auth/create is rate limited by attempts (unauthenticated CPU cost)', ['RATE_MAX_CREATE' => '3'], function () {
    // auth/create computes a password hash on EVERY call and is unauthenticated.
    // Measured before the fix at ~17x the cost of a trivial request, metered by
    // nothing at all, and it added a permanent row to `spaces` per request.
    $codes = [];
    for ($i = 0; $i < 6; $i++) {
        $codes[] = request('POST', '/api/auth/create',
            ['code' => 'sec-create-rl-' . $i, 'password' => SEC_PASSWORD, 'device' => ['id' => 'd' . $i]])['status'];
    }
    assertTrue(in_array(429, $codes, true), 'the limiter fires: ' . implode(',', $codes));
    assertSame(count(array_keys($codes, 200, true)), 3, 'only the budget is served');
    assertSame(count(sec_db()->query("SELECT id FROM spaces WHERE code LIKE 'sec-create-rl-%'")->fetchAll()), 3,
        'and no space row is written past the budget');
});

sec_it('auth: the create budget and the open budget do not share a counter', ['RATE_MAX' => '2', 'RATE_MAX_CREATE' => '5'], function () {
    // One budget for both endpoints let a script that only ever called `create`
    // lock the owner of a space out of their own login.
    for ($i = 0; $i < 3; $i++) {
        request('POST', '/api/auth/create',
            ['code' => 'sec-scoped-' . $i, 'password' => SEC_PASSWORD, 'device' => ['id' => 'c' . $i]]);
    }
    // The create budget is now spent; the open budget has never been touched.
    $r = request('POST', '/api/auth/open',
        ['code' => 'sec-scoped-0', 'password' => SEC_PASSWORD, 'device' => ['id' => 'opener']]);
    assertStatus($r, 200, 'a correct login still works after the create budget is spent');
    // And the reverse: failures against `open` must not eat the create budget.
    for ($i = 0; $i < 4; $i++) {
        request('POST', '/api/auth/open',
            ['code' => 'sec-scoped-0', 'password' => 'wrong-pass-here', 'device' => ['id' => 'o' . $i]]);
    }
    $r = request('POST', '/api/auth/create',
        ['code' => 'sec-scoped-after', 'password' => SEC_PASSWORD, 'device' => ['id' => 'c9']]);
    assertStatus($r, 200, 'create still works after the open budget is spent');
});

sec_it('auth: the instance refuses to create spaces past MAX_SPACES', ['MAX_SPACES' => '2'], function () {
    $codes = [];
    for ($i = 0; $i < 4; $i++) {
        $codes[] = request('POST', '/api/auth/create',
            ['code' => 'sec-spaces-' . $i, 'password' => SEC_PASSWORD, 'device' => ['id' => 'd' . $i]])['status'];
    }
    assertTrue(in_array(503, $codes, true), 'the cap is enforced: ' . implode(',', $codes));
    assertSame(count(sec_db()->query('SELECT id FROM spaces')->fetchAll()), 2, 'no more than the cap is stored');
});

/* ================== 2. SESSIONS ========================================= */

sec_it('session: the cookie is HttpOnly, SameSite=Lax, Secure in production, Path=/', ['ENVIRONMENT' => 'production'], function () {
    $r = request('POST', '/api/auth/create',
        ['code' => 'sec-cookie', 'password' => SEC_PASSWORD, 'device' => ['id' => 'd1']]);
    assertStatus($r, 200, 'create');
    assertTrue($r['cookie']['httponly'], 'HttpOnly is set, so JavaScript cannot read the session');
    assertSame($r['cookie']['samesite'], 'Lax', 'SameSite=Lax');
    $raw = '';
    foreach ($r['headers'] as $h) if (stripos($h, 'Set-Cookie:') === 0) $raw = $h;
    assertTrue(stripos($raw, 'secure') !== false, 'Secure in production');
    assertTrue(stripos($raw, 'path=/') !== false, 'Path=/');
});

sec_it('session: the token is 64 hex characters of entropy, not a guessable id', [], function () {
    $r = request('POST', '/api/auth/create',
        ['code' => 'sec-entropy', 'password' => SEC_PASSWORD, 'device' => ['id' => 'd1']]);
    $token = (string)$r['cookie']['value'];
    assertSame(strlen($token), 64, '256 bits of hex');
    assertTrue((bool)preg_match('/^[0-9a-f]{64}$/', $token), 'hex only');
});

sec_it('session: only the hash of the token is stored, never the token', [], function () {
    $c = newSpace('sec-token-storage', SEC_PASSWORD, SEC_DEVICE);
    $rows = sec_db()->query('SELECT token_hash FROM sessions')->fetchAll();
    $hit = false;
    foreach ($rows as $row) $hit = $hit || $row['token_hash'] === $c;
    assertTrue(!$hit, 'the raw cookie value is not in the sessions table');
    foreach ($rows as $row) {
        assertTrue((bool)preg_match('/^[0-9a-f]{64}$/', $row['token_hash']), 'a sha256 digest is stored instead');
    }
});

sec_it('session: logout invalidates the session it was called with', [], function () {
    $c = newSpace('sec-logout', SEC_PASSWORD, SEC_DEVICE);
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $c), 200, 'works before logout');
    assertStatus(request('POST', '/api/auth/logout', [], $c), 200, 'logout');
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $c), 401, 'the same token is dead afterwards');
});

sec_it('session: rotation invalidates the token it replaced', [], function () {
    $c = newSpace('sec-rotate', SEC_PASSWORD, SEC_DEVICE);
    $r = request('POST', '/api/auth/rotate', [], $c);
    assertStatus($r, 200, 'rotate');
    $new = (string)$r['cookie']['value'];
    assertTrue($new !== $c, 'a different token is issued');
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $c), 401, 'the old token is dead');
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $new), 200, 'the new token works');
});

sec_it('session: forged, empty and truncated tokens are all rejected', [], function () {
    newSpace('sec-forged', SEC_PASSWORD, SEC_DEVICE);
    foreach ([
        'all f'         => str_repeat('f', 64),
        'short'         => 'abc',
        'empty'         => '',
        'truncated'     => str_repeat('0', 63),
        'one char long' => 'x',
    ] as $label => $token) {
        assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $token), 401, "forged token: $label");
    }
});

sec_it('session: an expired session is rejected', [], function () {
    $db = sec_db();
    $db->exec(sprintf(
        'INSERT INTO spaces (code, password_hash, created_at) VALUES (%s, %s, %d)',
        $db->quote('sec-expired'), $db->quote('x'), time()
    ));
    $space = (int)$db->query("SELECT id FROM spaces WHERE code = 'sec-expired'")->fetchColumn();
    $db->prepare('INSERT INTO sessions (space_id, token_hash, created_at, expires_at) VALUES (?, ?, 0, 0)')
        ->execute([$space, hash('sha256', 'sec-expired-token')]);
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], 'sec-expired-token'), 401, 'expired');
});

sec_it('session: a space cannot hold an unbounded number of live sessions', ['MAX_AUTH_SESSIONS_PER_SPACE' => '5'], function () {
    // 30 logins from ONE device used to leave 31 live sessions: open() inserted
    // a row every time and nothing ever removed one, and the device cap did not
    // help because one device may log in repeatedly.
    newSpace('sec-sess-cap', SEC_PASSWORD, SEC_DEVICE);
    for ($i = 0; $i < 30; $i++) {
        request('POST', '/api/auth/open',
            ['code' => 'sec-sess-cap', 'password' => SEC_PASSWORD, 'device' => ['id' => SEC_DEVICE]]);
    }
    $live = (int)sec_db()->query('SELECT COUNT(*) FROM sessions')->fetchColumn();
    assertTrue($live <= 5, "live sessions are capped, got $live");
});

sec_it('session: one member of a space cannot rename another member device', [], function () {
    newSpace('sec-devices', SEC_PASSWORD, 'sec-victim-device');
    request('POST', '/api/auth/open',
        ['code' => 'sec-devices', 'password' => SEC_PASSWORD, 'device' => ['id' => 'sec-attacker-device', 'label' => 'attacker']]);
    // A device id carries no proof, so any member can claim any id. The label is
    // a display name, and the first registration of an id keeps it.
    request('POST', '/api/auth/open',
        ['code' => 'sec-devices', 'password' => SEC_PASSWORD, 'device' => ['id' => 'sec-victim-device', 'label' => 'RENAMED']]);
    $label = sec_db()->query("SELECT label FROM devices WHERE device_id = 'sec-victim-device'")->fetchColumn();
    assertSame($label, null, 'the claimed label was not applied to the existing identity');
});

sec_it('session: an over-long device label is refused instead of stored', ['MAX_DEVICE_LABEL_LEN' => '64'], function () {
    // The ceiling is set low and the label sized above it, so this exercises the
    // label rule rather than the request-size rule.
    $r = request('POST', '/api/auth/create', [
        'code' => 'sec-label', 'password' => SEC_PASSWORD,
        'device' => ['id' => 'd1', 'label' => str_repeat('A', 5000)],
    ]);
    assertStatus($r, 400, 'a device label above MAX_DEVICE_LABEL_LEN');
    assertSame(sec_error_code($r), 'invalid_device', 'refused as an invalid device');
    $row = sec_db()->query("SELECT label FROM devices WHERE device_id = 'd1'")->fetchColumn();
    assertTrue($row === false || $row === null, 'nothing oversized reached the devices table');
    // A label within the ceiling still works.
    $r = request('POST', '/api/auth/create', [
        'code' => 'sec-label-ok', 'password' => SEC_PASSWORD,
        'device' => ['id' => 'd2', 'label' => 'My Phone'],
    ]);
    assertStatus($r, 200, 'a normal device label');
});

sec_it('session: the device id may not contain control characters', [], function () {
    foreach (["bad\x00id", "bad\nid", "bad\rid"] as $bad) {
        $r = request('POST', '/api/auth/create',
            ['code' => 'sec-ctl-' . bin2hex(random_bytes(3)), 'password' => SEC_PASSWORD, 'device' => ['id' => $bad]]);
        assertStatus($r, 400, 'control characters in a device id: ' . bin2hex($bad));
    }
});

/* ================== 3. AUTHORIZATION ===================================== */

sec_it('authz: every sync endpoint refuses an unauthenticated request', [], function () {
    foreach (['/api/sync/push', '/api/sync/pull'] as $ep) {
        assertStatus(request('POST', $ep, ['cursor' => 0, 'changes' => []], null), 401, "$ep without a cookie");
    }
});

sec_it('authz: one space cannot read, overwrite or delete another space records', [], function () {
    $alpha = newSpace('sec-space-alpha', SEC_PASSWORD, 'dev-alpha');
    $bravo = newSpace('sec-space-bravo', SEC_PASSWORD, 'dev-bravo');
    $now  = time() * 1000;

    request('POST', '/api/sync/push', [
        'device' => ['id' => 'dev-alpha'],
        'changes' => [['type' => 'task', 'id' => 'alpha-private', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'ALPHA-SECRET']]],
    ], $alpha);

    // Read.
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $bravo);
    assertTrue(!str_contains(json_encode($r['body']), 'ALPHA-SECRET'), "bravo cannot read alpha's records");

    // Every shape of forged owner reference the client could send.
    foreach (['spaceId' => 1, 'space_id' => 1, 'space' => 'sec-space-alpha', 'ownerSpace' => 1] as $forged) {
        $r = request('POST', '/api/sync/pull', ['cursor' => 0, $forged => $forged === 'space' ? 'sec-space-alpha' : 1], $bravo);
        assertTrue(!str_contains(json_encode($r['body']), 'ALPHA-SECRET'),
            'a forged ' . $forged . ' in the body does not widen access');
    }

    // Overwrite.
    request('POST', '/api/sync/push', [
        'device' => ['id' => 'dev-bravo'], 'spaceId' => 1,
        'changes' => [['type' => 'task', 'id' => 'alpha-private', 'op' => 'upsert', 'updatedAt' => $now + 1, 'data' => ['c' => 'HIJACKED']]],
    ], $bravo);
    // Delete.
    request('POST', '/api/sync/push', [
        'device' => ['id' => 'dev-bravo'], 'spaceId' => 1,
        'changes' => [['type' => 'task', 'id' => 'alpha-private', 'op' => 'delete', 'updatedAt' => $now + 2]],
    ], $bravo);

    // None of that touched alpha.
    $rows = [];
    $cursor = 0;
    for (;;) {
        $r = request('POST', '/api/sync/pull', ['cursor' => $cursor], $alpha);
        foreach ($r['body']['changes'] ?? [] as $ch) $rows[] = $ch;
        $cursor = $r['body']['nextCursor'] ?? 0;
        if (($r['body']['more'] ?? false) !== true) break;
    }
    assertSame(count($rows), 1, "alpha still has exactly its own record, got " . count($rows));
    assertSame($rows[0]['op'], 'upsert', "alpha's record is not tombstoned");
    assertSame($rows[0]['data']['c'], 'ALPHA-SECRET', "alpha's record content is unchanged");
});

sec_it('authz: the space is derived from the session, never from the request', [], function () {
    // The design property itself: the protocol carries no owner identifier at
    // all. There is no space id, no owner id and no device credential in any
    // request the client can make, so there is nothing for an attacker to swap.
    // A space is reachable only through the session cookie, and a session
    // resolves to exactly one space server-side.
    $a = newSpace('sec-derived-a', SEC_PASSWORD, 'dev-a');
    $b = newSpace('sec-derived-b', SEC_PASSWORD, 'dev-b');
    $now = time() * 1000;
    request('POST', '/api/sync/push', ['device' => ['id' => 'dev-a'], 'changes' => [
        ['type' => 'task', 'id' => 'same-id', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'A']],
    ]], $a);
    // The identical record id in the other space is a different row.
    request('POST', '/api/sync/push', ['device' => ['id' => 'dev-b'], 'changes' => [
        ['type' => 'task', 'id' => 'same-id', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'B']],
    ]], $b);
    $rows = sec_db()->query('SELECT space_id, data FROM records ORDER BY space_id')->fetchAll();
    assertSame(count($rows), 2, 'the same record id is stored as two scoped rows');
    assertSame(count(array_unique(array_column($rows, 'space_id'))), 2, 'in two different spaces');
    // Both sessions still work, and neither sees the other's row.
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $a), 200, 'space a pulls');
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $b), 200, 'space b pulls');
});

sec_it('authz: a device id cannot be used to read another device data', [], function () {
    // Devices carry no data of their own, but the property is worth pinning: the
    // device field is telemetry, and a forged one changes nothing about access.
    $a = newSpace('sec-dev-access', SEC_PASSWORD, 'dev-real');
    $now = time() * 1000;
    request('POST', '/api/sync/push', [
        'device' => ['id' => 'dev-real'],
        'changes' => [['type' => 'task', 'id' => 'owned', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'DATA']]],
    ], $a);
    $r = request('POST', '/api/sync/pull', ['cursor' => 0, 'device' => ['id' => 'someone-elses-device']], $a);
    assertStatus($r, 200, 'the pull still succeeds');
    assertSame(count($r['body']['changes'] ?? []), 1, 'and returns the same session-owned data, nothing more');
});

/* ================== 4. INPUT VALIDATION ================================== */

sec_it('input: a non-string field is refused, not cast', [], function () {
    // PHP casts (string)['a'] to "Array", and "Array" passes the space-code
    // regex — so {"code":["a"]} used to create a space whose code was literally
    // the word "Array", and any two such callers collided on one row.
    $cases = [
        'code is an array'       => '{"code":["a"],"password":"a-long-enough-secret","device":{"id":"d"}}',
        'code is an int'         => '{"code":12345,"password":"a-long-enough-secret","device":{"id":"d"}}',
        'code is a bool'         => '{"code":true,"password":"a-long-enough-secret","device":{"id":"d"}}',
        'code is null'           => '{"code":null,"password":"a-long-enough-secret","device":{"id":"d"}}',
        'password is an int'     => '{"code":"sec-cast-1","password":12345678,"device":{"id":"d"}}',
        'password is an array'   => '{"code":"sec-cast-2","password":["x"],"device":{"id":"d"}}',
        'device.id is an array'  => '{"code":"sec-cast-3","password":"a-long-enough-secret","device":{"id":["a"]}}',
        'device.id is an int'    => '{"code":"sec-cast-4","password":"a-long-enough-secret","device":{"id":7}}',
        'device is a string'     => '{"code":"sec-cast-5","password":"a-long-enough-secret","device":"nope"}',
        'body is a JSON array'   => '[1,2,3]',
        'body is a JSON string'  => '"hello"',
        'body is JSON null'      => 'null',
    ];
    foreach ($cases as $label => $raw) {
        $r = request('POST', '/api/auth/create', null, null, $raw);
        assertStatus($r, 400, "refused: $label");
    }
    // A well-formed body with unknown extra fields is still accepted: rejecting
    // unknown keys would break every future client that sends a new field.
    $r = request('POST', '/api/auth/create', null, null,
        '{"code":"sec-extra-ok","password":"a-long-enough-secret","device":{"id":"d"},"futureField":123}');
    assertStatus($r, 200, 'a real object with extra fields is accepted');
});

sec_it('input: malformed and empty bodies are 400, never 500', [], function () {
    $c = newSpace('sec-malformed', SEC_PASSWORD, SEC_DEVICE);
    foreach ([
        'empty'          => '',
        'whitespace'     => "   \n ",
        'not json'       => 'not json at all',
        'truncated json' => '{"code":"a","pass',
        'trailing junk'  => '{"a":1} trailing',
        'bare scalar'    => '42',
    ] as $label => $raw) {
        $r = request('POST', '/api/sync/pull', null, $c, $raw);
        assertTrue(in_array($r['status'], [400, 415], true), "refused with 400/415: $label (got {$r['status']})");
    }
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $c), 200, 'the endpoint still works');
});

sec_it('input: deeply nested JSON is refused rather than parsed', [], function () {
    $c = newSpace('sec-deep', SEC_PASSWORD, SEC_DEVICE);
    $deep = str_repeat('{"a":', 400) . '1' . str_repeat('}', 400);
    $r = request('POST', '/api/sync/pull', null, $c, $deep);
    assertTrue(in_array($r['status'], [400, 413], true), 'deep nesting is refused, got ' . $r['status']);
});

sec_it('input: the request size ceiling applies to every POST', ['REQUEST_MAX_BYTES' => '2048'], function () {
    // auth/status, auth/logout and auth/rotate never parse a body, so the limit
    // used to be skipped for them entirely: a 200,000-byte body was accepted
    // with the ceiling set to 2,048.
    $c = newSpace('sec-size', SEC_PASSWORD, SEC_DEVICE);
    $big = str_repeat('x', 200000);
    foreach (['/api/auth/status', '/api/auth/logout', '/api/auth/rotate', '/api/auth/create', '/api/sync/pull'] as $ep) {
        assertStatus(request('POST', $ep, null, $c, $big), 413, "$ep refuses an oversized body");
    }
});

sec_it('input: the record-type allowlist stays closed', [], function () {
    $c = newSpace('sec-types', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    foreach ([
        'passwordHash', 'spaces', 'sessions', 'devices', 'auth_failures', 'records',
        'TASK', 'Task', 'task ', ' task', 'task;drop', '../task', 'task/../task',
    ] as $type) {
        $r = request('POST', '/api/sync/push', [
            'device' => ['id' => SEC_DEVICE],
            'changes' => [['type' => $type, 'id' => 'x', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'y']]],
        ], $c);
        assertSame($r['body']['invalid'] ?? 0, 1, "rejected as invalid: type '$type'");
        assertSame($r['body']['accepted'] ?? 0, 0, "not stored: type '$type'");
    }
});

sec_it('input: invalid timestamps and revisions are counted invalid, not stored', ['MAX_UPDATED_AT_FUTURE_MS' => '3600000', 'MAX_UPDATED_AT_AGE_MS' => '31536000000'], function () {
    // A one-hour window in each direction, set explicitly: the point is that a
    // client whose clock is far out is refused rather than allowed to corrupt
    // last-write-wins ordering for every other device.
    $c = newSpace('sec-ts', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    foreach ([
        'zero'       => 0,
        'negative'   => -1,
        'a string'   => '123',
        'null'       => null,
        'a float'    => 1.5,
        'an object'  => ['at' => 1],
        'an array'   => [1, 2],
        'far future' => $now + 400 * 24 * 3600 * 1000,
        'far past'   => $now - 400 * 24 * 3600 * 1000,
    ] as $label => $at) {
        $r = request('POST', '/api/sync/push', [
            'device' => ['id' => SEC_DEVICE],
            'changes' => [['type' => 'task', 'id' => 'ts-' . md5((string)$label), 'op' => 'upsert', 'updatedAt' => $at, 'data' => ['c' => 'z']]],
        ], $c);
        assertSame($r['body']['invalid'] ?? 0, 1, "counted invalid: updatedAt $label");
        assertSame($r['body']['accepted'] ?? 0, 0, "not stored: updatedAt $label");
    }
    // A timestamp inside the window is accepted, so the rule is a window and
    // not a blanket refusal.
    $r = request('POST', '/api/sync/push', [
        'device' => ['id' => SEC_DEVICE],
        'changes' => [['type' => 'task', 'id' => 'ts-ok', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'z']]],
    ], $c);
    assertSame($r['body']['accepted'] ?? 0, 1, 'a current timestamp is accepted');
    // A pull cursor is bounds-checked rather than cast.
    foreach ([-1, 'x', null, 1.5, PHP_INT_MAX, ['a']] as $cursor) {
        assertStatus(request('POST', '/api/sync/pull', ['cursor' => $cursor], $c), 200,
            'a pull with cursor ' . json_encode($cursor) . ' is handled');
    }
});

sec_it('input: an over-long record id is refused', [], function () {
    $c = newSpace('sec-longid', SEC_PASSWORD, SEC_DEVICE);
    $r = request('POST', '/api/sync/push', [
        'device' => ['id' => SEC_DEVICE],
        'changes' => [['type' => 'task', 'id' => str_repeat('A', 300), 'op' => 'upsert', 'updatedAt' => time() * 1000, 'data' => ['c' => 'z']]],
    ], $c);
    assertSame($r['body']['invalid'] ?? 0, 1, 'a 300-character record id is refused');
});

/* ================== 5. INJECTION ========================================= */

sec_it('sqli: every parameter is bound, and payloads are stored as data', [], function () {
    $payloads = [
        "' OR '1'='1", "'; DROP TABLE records;--", '" OR 1=1--',
        "1' UNION SELECT password_hash FROM spaces--", "admin'--", "') OR ('1'='1",
        "'; UPDATE spaces SET password_hash = 'x'; --", "/*", "%00", "\\",
    ];
    foreach ($payloads as $i => $p) {
        // As a space code: the allowlist rejects it outright.
        $r = request('POST', '/api/auth/create',
            ['code' => $p, 'password' => SEC_PASSWORD, 'device' => ['id' => $p]]);
        assertStatus($r, 400, "space code refused: " . substr($p, 0, 28));
    }

    // As a record id and a device id, where no allowlist applies: the value has
    // to survive as literal text. If anything were concatenated into SQL, the
    // tables would be gone or the password hash would have changed.
    $c = newSpace('sec-sqli', SEC_PASSWORD, 'seed');
    $before = (string)sec_db()->query("SELECT password_hash FROM spaces WHERE code = 'sec-sqli'")->fetchColumn();
    $now = time() * 1000;
    foreach ($payloads as $i => $p) {
        $r = request('POST', '/api/sync/push', [
            'device' => ['id' => 'seed'],
            'changes' => [['type' => 'task', 'id' => $p, 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'x']]],
        ], $c);
        assertStatus($r, 200, "record id accepted as data: " . substr($p, 0, 28));
    }
    $db = sec_db();
    assertTrue((int)$db->query("SELECT COUNT(*) FROM sqlite_master WHERE name = 'records'")->fetchColumn() === 1,
        'the records table still exists');
    assertTrue((int)$db->query("SELECT COUNT(*) FROM sqlite_master WHERE name = 'spaces'")->fetchColumn() === 1,
        'the spaces table still exists');
    assertSame((string)$db->query("SELECT password_hash FROM spaces WHERE code = 'sec-sqli'")->fetchColumn(), $before,
        'the stored password hash is byte-identical');

    // Every payload that reached the store is there verbatim, as an opaque id.
    $stored = array_column($db->query('SELECT id FROM records ORDER BY rev')->fetchAll(), 'id');
    sort($stored);
    $expected = array_values($payloads);
    sort($expected);
    assertSame($stored, $expected, 'every payload is stored verbatim, exactly as sent');
});

sec_it('xss: script payloads round-trip as inert strings', [], function () {
    // The server is a documented dumb store: it holds ciphertext. This test
    // pins that it does not execute, interpret, or reject markup — the client
    // renders through a factory that can only build text nodes, so the payload
    // is five characters the user typed (see tests/rich-text.test.mjs).
    $c = newSpace('sec-xss', SEC_PASSWORD, SEC_DEVICE);
    $payloads = [
        '<script>alert(1)</script>',
        '"><img src=x onerror=alert(1)>',
        "javascript:alert(1)",
        '<svg/onload=alert(1)>',
        "'); alert(1); //",
        '<iframe src="//evil"></iframe>',
    ];
    $now = time() * 1000;
    $changes = [];
    foreach ($payloads as $i => $p) {
        $changes[] = ['type' => 'task', 'id' => 'xss-' . $i, 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => $p, 'title' => $p]];
    }
    $r = request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => $changes], $c);
    assertSame($r['body']['accepted'], count($payloads), 'every payload is stored as data');
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $c);
    $body = json_encode($r['body']);
    assertTrue(str_contains($body, '&lt;script&gt;') || str_contains($body, '<script>'),
        'the payload came back exactly as stored, uninterpreted');
    assertTrue(!str_contains($body, 'eval('), 'nothing evaluated anything');
});

sec_it('path traversal: no request can reach the database or a source file', [], function () {
    $paths = [
        '/api/var/sync.sqlite', '/api/../api/var/sync.sqlite', '/api/var/../var/sync.sqlite',
        '/%2e%2e/api/var/sync.sqlite', '/api/%2e%2e%2fvar%2fsync.sqlite',
        '/../api/var/sync.sqlite', '/..%2fapi%2fvar%2fsync.sqlite', '/....//api/var/sync.sqlite',
        '/api/./var/sync.sqlite', '/api/index.php', '/api/auth.php', '/api/db.php',
        '/api/config.php', '/api/config.local.php', '/api/sync.php', '/api/gc.php',
        '/api/tests/run.php', '/api/tests/rate-window-check.php',
        '/api/var/.htaccess', '/api/var/', '/../package.json', '/../Dockerfile',
        '/../docker-compose.yml', '/../.gitignore', '/../.env', '/../composer.json',
        '/_headers', '/_redirects', '/../api/var/sync.sqlite-wal', '/../api/var/sync.sqlite-shm',
    ];
    foreach ($paths as $path) {
        foreach (['GET', 'POST'] as $method) {
            $r = request($method, $path, ['cursor' => 0]);
            assertTrue(
                in_array($r['status'], [400, 404], true),
                sprintf('%s %s is refused, got %d', $method, $path, $r['status'])
            );
            $body = (string)json_encode($r['body']);
            assertTrue(!str_contains($body, 'SQLite format 3'), "no database header leaks from $path");
            assertTrue(!str_contains($body, '<?php'), "no PHP source leaks from $path");
        }
    }
});

/* ================== 6. SYNC ============================================== */

sec_it('sync: a forged space identifier in the body changes nothing', [], function () {
    $a = newSpace('sec-sync-a', SEC_PASSWORD, 'dev-a');
    $b = newSpace('sec-sync-b', SEC_PASSWORD, 'dev-b');
    $now = time() * 1000;
    request('POST', '/api/sync/push', [
        'device' => ['id' => 'dev-a'],
        'changes' => [['type' => 'task', 'id' => 'shared-id', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'FROM-A']]],
    ], $a);
    // The same record id in the other space must not collide with it.
    $r = request('POST', '/api/sync/push', [
        'device' => ['id' => 'dev-b'],
        'changes' => [['type' => 'task', 'id' => 'shared-id', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'FROM-B']]],
    ], $b);
    assertSame($r['body']['accepted'], 1, "bravo's own record with the same id is accepted");

    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $b);
    $found = array_values(array_filter($r['body']['changes'] ?? [], fn($c) => $c['id'] === 'shared-id'));
    assertSame($found[0]['data']['c'] ?? '', 'FROM-B', 'bravo sees only its own record');
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $a);
    $found = array_values(array_filter($r['body']['changes'] ?? [], fn($c) => $c['id'] === 'shared-id'));
    assertSame($found[0]['data']['c'] ?? '', 'FROM-A', 'alpha sees only its own record');
});

sec_it('sync: last-write-wins cannot be walked backwards with a stale write', [], function () {
    $c = newSpace('sec-lww', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'lww', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'NEWER']],
    ]], $c);
    // An older write must not overwrite the newer stored version.
    $r = request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'lww', 'op' => 'upsert', 'updatedAt' => $now - 60000, 'data' => ['c' => 'OLDER']],
    ]], $c);
    assertSame($r['body']['rejected'], 1, 'the older write is rejected');
    // An older tombstone must not resurrect-remove a newer record.
    $r = request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'lww', 'op' => 'delete', 'updatedAt' => $now - 60000],
    ]], $c);
    assertSame($r['body']['rejected'], 1, 'a stale delete is rejected');
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $c);
    $found = array_values(array_filter($r['body']['changes'] ?? [], fn($x) => $x['id'] === 'lww'));
    assertSame($found[0]['data']['c'] ?? '', 'NEWER', 'the newer version survives');
    assertSame($found[0]['op'], 'upsert', 'and was not tombstoned');
});

sec_it('sync: replaying the same push is idempotent and cannot duplicate', [], function () {
    $c = newSpace('sec-replay', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    $push = ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'once', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'V']],
    ]];
    for ($i = 0; $i < 5; $i++) request('POST', '/api/sync/push', $push, $c);
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $c);
    $matches = array_filter($r['body']['changes'] ?? [], fn($x) => $x['id'] === 'once');
    assertSame(count($matches), 1, 'the record exists exactly once after five identical pushes');
});

sec_it('sync: a stale cursor returns nothing rather than everything', [], function () {
    $c = newSpace('sec-cursor', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'cur', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'V']],
    ]], $c);
    $first = request('POST', '/api/sync/pull', ['cursor' => 0], $c);
    $head = (int)$first['body']['nextCursor'];
    assertTrue($head > 0, 'the pull returned a cursor');
    $again = request('POST', '/api/sync/pull', ['cursor' => $head], $c);
    assertSame(count($again['body']['changes'] ?? []), 0, 'pulling from the head returns nothing');
    $ahead = request('POST', '/api/sync/pull', ['cursor' => $head + 100000], $c);
    assertSame(count($ahead['body']['changes'] ?? []), 0, 'a cursor past the head returns nothing');
});

sec_it('sync: a malformed record does not poison the batch around it', [], function () {
    $c = newSpace('sec-batch', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    $r = request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'good-1', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'A']],
        ['type' => 'not-a-type', 'id' => 'bad-1', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'B']],
        ['type' => 'task', 'id' => 'good-2', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'C']],
        ['type' => 'task', 'id' => 'bad-2', 'op' => 'teleport', 'updatedAt' => $now, 'data' => ['c' => 'D']],
        'a bare string, not a change',
        ['type' => 'task', 'id' => 'good-3', 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'E']],
    ]], $c);
    assertSame($r['body']['accepted'], 3, 'the three well-formed changes are accepted');
    assertSame($r['body']['invalid'], 3, 'the three malformed ones are counted invalid');
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], $c);
    $ids = array_map(fn($x) => $x['id'], $r['body']['changes'] ?? []);
    sort($ids);
    assertSame($ids, ['good-1', 'good-2', 'good-3'], 'only the well-formed records are stored');
});

sec_it('sync: a change with no data envelope is refused for an upsert', [], function () {
    $c = newSpace('sec-noenv', SEC_PASSWORD, SEC_DEVICE);
    $r = request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => [
        ['type' => 'task', 'id' => 'nodata', 'op' => 'upsert', 'updatedAt' => time() * 1000],
    ]], $c);
    assertSame($r['body']['invalid'], 1, 'an upsert with no payload is refused');
});

sec_it('sync: a batch larger than the server accepts is truncated, not processed whole', ['PUSH_BATCH' => '2'], function () {
    $c = newSpace('sec-batchlimit', SEC_PASSWORD, SEC_DEVICE);
    $now = time() * 1000;
    $changes = [];
    for ($i = 0; $i < 10; $i++) {
        $changes[] = ['type' => 'task', 'id' => 'bl-' . $i, 'op' => 'upsert', 'updatedAt' => $now, 'data' => ['c' => 'V']];
    }
    $r = request('POST', '/api/sync/push', ['device' => ['id' => SEC_DEVICE], 'changes' => $changes], $c);
    assertSame($r['body']['accepted'] + $r['body']['invalid'], 10, 'every change is accounted for');
    assertTrue($r['body']['invalid'] > 0, 'the overflow is reported as invalid, not silently dropped');
});

sec_it('sync: a forged device id updates nothing outside its own space', [], function () {
    $a = newSpace('sec-dev-a', SEC_PASSWORD, 'dev-a');
    $b = newSpace('sec-dev-b', SEC_PASSWORD, 'dev-b');
    request('POST', '/api/sync/push', ['device' => ['id' => 'nobody'], 'changes' => [
        ['type' => 'task', 'id' => 'ghost', 'op' => 'upsert', 'updatedAt' => time() * 1000, 'data' => ['c' => 'V']],
    ]], $a);
    $db = sec_db();
    assertSame((int)$db->query("SELECT COUNT(*) FROM devices WHERE device_id = 'nobody'")->fetchColumn(), 0,
        'a device that was never registered cannot be updated by id');
    assertStatus(request('POST', '/api/sync/pull', ['cursor' => 0], $b), 200, 'the other space is unaffected');
});

/* ================== 7. CSRF ============================================== */

sec_it('csrf: a form-simple content type cannot reach the auth endpoints', [], function () {
    // `text/plain` is CORS-safelisted, so a cross-origin page can POST it with a
    // plain <form enctype="text/plain"> and NO preflight. With the endpoint
    // accepting any content type, that was login CSRF: the browser stored the
    // attacker's Set-Cookie and the victim's device synced into a space the
    // attacker chose. Requiring application/json makes it a preflighted request
    // that the server refuses for any origin but a configured one.
    $payload = json_encode(['code' => 'sec-csrf-space', 'password' => SEC_PASSWORD, 'device' => ['id' => 'attacker-device']]);

    foreach ([
        'text/plain'    => 'text/plain',
        'no content type' => '',
        'form-urlencoded' => 'application/x-www-form-urlencoded',
        'multipart'     => 'multipart/form-data; boundary=x',
        'text/html'     => 'text/html',
    ] as $label => $type) {
        $r = request('POST', '/api/auth/create', null, null, $payload, ['Content-Type' => $type]);
        assertStatus($r, 415, "refused with 415: Content-Type $label");
        assertTrue(sec_header($r, 'Set-Cookie') === '', "no session cookie is issued for: $label");
    }

    // The same payload that was refused as text/plain must never have created
    // the space, so the real request below is a fresh create rather than a 409
    // against something the refused ones left behind.
    assertSame((int)sec_db()->query("SELECT COUNT(*) FROM spaces WHERE code = 'sec-csrf-space'")->fetchColumn(), 0,
        'no space was created by any of the refused requests');

    // And the real client, which always sends JSON, is unaffected.
    $r = request('POST', '/api/auth/create', null, null, $payload, ['Content-Type' => 'application/json']);
    assertStatus($r, 200, 'application/json still works');
    assertSame((int)sec_db()->query("SELECT COUNT(*) FROM spaces WHERE code = 'sec-csrf-space'")->fetchColumn(), 1,
        'and the space is created exactly once, by the JSON request');
    // A charset parameter is the normal thing to send and must be tolerated.
    $r = request('POST', '/api/auth/create', null, null,
        json_encode(['code' => 'sec-csrf-space-2', 'password' => SEC_PASSWORD, 'device' => ['id' => 'd']]),
        ['Content-Type' => 'application/json; charset=utf-8']);
    assertStatus($r, 200, 'application/json with a charset parameter works');
});

sec_it('csrf: a browser-labelled cross-site request is refused', [], function () {
    $n = 0;
    $create = function (string $code) use (&$n): string {
        $n++;
        return json_encode(['code' => $code, 'password' => SEC_PASSWORD, 'device' => ['id' => 'd' . $n]]);
    };
    foreach (['cross-site' => 403, 'same-site' => 403, 'none' => 200] as $site => $expected) {
        $r = request('POST', '/api/auth/create', null, null, $create('sec-fs-' . $site),
            ['Content-Type' => 'application/json', 'Sec-Fetch-Site' => $site]);
        assertStatus($r, $expected, "Sec-Fetch-Site: $site");
    }
    $r = request('POST', '/api/auth/create', null, null, $create('sec-fs-same-origin'),
        ['Content-Type' => 'application/json', 'Sec-Fetch-Site' => 'same-origin']);
    assertStatus($r, 200, 'same-origin is allowed');
});

sec_it('csrf: no preflight is answered for an unconfigured origin', [], function () {
    $r = request('OPTIONS', '/api/auth/open', null, null, null, ['Origin' => 'https://evil.example']);
    assertStatus($r, 404, 'a preflight from an arbitrary origin fails');
    assertTrue(sec_header($r, 'Access-Control-Allow-Origin') === '', 'and gets no ACAO header');
});

/* ================== 8. CORS ============================================== */

sec_it('cors: a wildcard ALLOWED_ORIGIN does not reflect a wildcard', ['ALLOWED_ORIGIN' => '*'], function () {
    // Before: Access-Control-Allow-Origin: * together with
    // Access-Control-Allow-Credentials: true — a contradiction the spec resolves
    // by rejecting the response, so the setting only ever looked permissive.
    $r = request('POST', '/api/auth/status', [], null, null, ['Origin' => 'https://evil.example']);
    assertTrue(sec_header($r, 'Access-Control-Allow-Origin') === '',
        'no ACAO: ' . sec_header($r, 'Access-Control-Allow-Origin'));
    assertTrue(sec_header($r, 'Access-Control-Allow-Credentials') === '', 'no ACAC');
});

sec_it('cors: a configured origin is matched exactly', ['ALLOWED_ORIGIN' => 'https://good.example'], function () {
    $r = request('POST', '/api/auth/status', [], null, null, ['Origin' => 'https://good.example']);
    assertSame(sec_header($r, 'Access-Control-Allow-Origin'), 'https://good.example', 'the exact origin is mirrored');
    assertSame(sec_header($r, 'Access-Control-Allow-Credentials'), 'true', 'credentials are allowed for it');
    assertTrue(str_contains(sec_header($r, 'Vary'), 'Origin'), 'Vary: Origin is set');

    foreach ([
        'https://evil.example',
        'https://good.example.evil.com',
        'https://good.example:8443',
        'HTTPS://good.example',
        'null',
        '',
    ] as $bad) {
        $r = request('POST', '/api/auth/status', [], null, null, $bad === '' ? [] : ['Origin' => $bad]);
        assertTrue(sec_header($r, 'Access-Control-Allow-Origin') === '',
            "not mirrored: " . ($bad === '' ? '(no Origin header)' : $bad));
    }
});

/* ================== 9. ROUTING =========================================== */

sec_it('routing: a handler is reachable only at its exact path', [], function () {
    // `str_ends_with($path, '/auth/open')` meant /whatever/auth/open,
    // /index.html/auth/open and /api/../api/auth/open all reached the same
    // handler, which defeats any path-based allowlist a reverse proxy applies.
    // 400 and 404 are both refusals: 400 is a path the router declines to
    // interpret at all (a `..` segment), 404 is a path it interprets and finds
    // no handler for.
    $prefixes = [
        '/whatever/auth/status'     => [400, 404],
        '/index.html/auth/status'    => [400, 404],
        '/api/../api/auth/status'    => [400, 404],
        '/x/y/z/auth/open'           => [400, 404],
        '/api/auth/status/extra'     => [400, 404],
        '/api/auth/statusx'          => [400, 404],
        '/static/../api/auth/status' => [400, 404],
        '/api/%2e%2e/api/auth/status' => [400, 404],
        '/api/auth%2fstatus'         => [400, 404],
    ];
    foreach ($prefixes as $path => $allowed) {
        $r = request('POST', $path, []);
        assertTrue(in_array($r['status'], $allowed, true), "no handler at $path (got {$r['status']})");
    }
    // Two normalizations reach the same handler, and neither is a way to reach a
    // DIFFERENT one: a trailing slash, and an empty segment. Both are collapse-
    // to-canonical, which is what every server in front of this one does too.
    foreach (['/api/auth/status/', '/api//auth//status', '/./api/auth/status'] as $normalizes) {
        assertStatus(request('POST', $normalizes, []), 200, "$normalizes reaches the same handler");
    }
    // The real paths still work.
    assertStatus(request('POST', '/api/auth/status', []), 200, '/api/auth/status');
    assertStatus(request('GET', '/api/health'), 200, '/api/health');
});

sec_it('routing: health is not reachable at an arbitrary path suffix', [], function () {
    foreach (['/health', '/anything/health', '/etc/health', '/api/sync/health'] as $path) {
        assertStatus(request('GET', $path), 404, "no health at $path");
    }
    // A traversal that would resolve to /api/health is refused outright rather
    // than resolved, so the app and a proxy in front of it cannot disagree.
    assertStatus(request('GET', '/api/health/../health'), 400, 'no health via a traversal');
});

sec_it('routing: a wrong method is 405 with an Allow header, not 404', [], function () {
    foreach ([
        ['GET', '/api/auth/status'], ['GET', '/api/sync/pull'], ['GET', '/api/sync/push'],
        ['PUT', '/api/auth/open'], ['DELETE', '/api/sync/pull'], ['PATCH', '/api/sync/push'],
    ] as [$method, $path]) {
        $r = request($method, $path, []);
        assertStatus($r, 405, "$method $path");
        assertSame(sec_header($r, 'Allow'), 'POST', "$method $path sends Allow: POST");
    }
    // No state change is reachable by any other verb.
    assertStatus(request('GET', '/api/auth/logout'), 405, 'GET cannot log out');
});

/* ================== 10. SECURITY HEADERS ================================= */

sec_it('headers: every response carries the security headers', ['HSTS_MAX_AGE' => '31536000'], function () {
    $c = newSpace('sec-headers', SEC_PASSWORD, SEC_DEVICE);
    $responses = [
        'GET /api/health'    => request('GET', '/api/health'),
        'POST /api/auth/status (no session)' => request('POST', '/api/auth/status', []),
        'POST /api/auth/status (session)'    => request('POST', '/api/auth/status', [], $c),
        'POST /api/sync/pull (session)'      => request('POST', '/api/sync/pull', ['cursor' => 0], $c),
        'POST /api/sync/pull (401)'          => request('POST', '/api/sync/pull', ['cursor' => 0]),
        'GET /api/nonexistent (404)'        => request('GET', '/api/nonexistent'),
        'POST /api/auth/open (400)'          => request('POST', '/api/auth/open', ['code' => 'x', 'password' => 'y', 'device' => ['id' => 'd']]),
    ];
    foreach ($responses as $label => $r) {
        assertSame(sec_header($r, 'X-Content-Type-Options'), 'nosniff', "$label nosniff");
        assertSame(sec_header($r, 'X-Frame-Options'), 'DENY', "$label DENY");
        assertSame(sec_header($r, 'Referrer-Policy'), 'strict-origin-when-cross-origin', "$label referrer");
        // camera and microphone are scoped to this origin rather than refused:
        // the note form records audio and video through getUserMedia, and
        // `camera=()` is a refusal no page here could ever lift. The other four
        // are still refused outright, which is what this assertion is really
        // about — an allowlist that grows is only safe while the things it does
        // not name stay closed.
        $pp = sec_header($r, 'Permissions-Policy');
        assertTrue(str_contains($pp, 'camera=(self)'), "$label camera is same-origin");
        assertTrue(str_contains($pp, 'microphone=(self)'), "$label microphone is same-origin");
        foreach (['geolocation', 'payment', 'usb'] as $refused) {
            assertTrue(str_contains($pp, "$refused=()"), "$label $refused stays refused");
        }

        $csp = sec_header($r, 'Content-Security-Policy');
        assertTrue(str_contains($csp, "object-src 'none'"), "$label object-src 'none' (not the default-src fallback)");
        assertTrue(str_contains($csp, "frame-ancestors 'none'"), "$label frame-ancestors");
        assertTrue(str_contains($csp, "base-uri 'none'"), "$label base-uri");
        assertTrue(str_contains($csp, "script-src 'self'"), "$label script-src");
        assertTrue(str_contains($csp, "style-src 'self'"), "$label style-src");
        assertTrue(str_contains($csp, "connect-src 'self'"), "$label connect-src");
        assertTrue(str_contains($csp, "worker-src 'self'"), "$label worker-src");
        // 'self', not 'none': the Web Share Target is a form POST, and 'none'
        // would block the one navigation the app's main entry point depends on.
        // 'self' is still a closed list — a form cannot post to another origin.
        assertTrue(str_contains($csp, "form-action 'self'"), "$label form-action");
        // blob: in the media directives, because every attachment is rendered
        // from a Blob URL built in the page. Without it every thumbnail is an
        // empty box and every voice memo player is a dead control.
        assertTrue(str_contains($csp, "img-src 'self' data: blob:"), "$label img-src allows blob:");
        assertTrue(str_contains($csp, "media-src 'self' blob:"), "$label media-src allows blob:");
        assertTrue(!str_contains($csp, 'unsafe-inline'), "$label no unsafe-inline");
        assertTrue(!str_contains($csp, 'unsafe-eval'), "$label no unsafe-eval");
        assertTrue(!str_contains($csp, '*'), "$label no wildcard source");

        assertTrue(sec_header($r, 'X-Powered-By') === '', "$label does not advertise the PHP version");
        assertTrue(str_contains(sec_header($r, 'Strict-Transport-Security'), 'max-age=31536000'),
            "$label HSTS when configured");
        assertTrue(str_contains(strtolower(sec_header($r, 'Cache-Control')), 'no-store'),
            "$label responses are not cacheable");
    }
});

sec_it('headers: HSTS is absent by default, because the container serves plain HTTP', [], function () {
    // Strict-Transport-Security is cached by the browser for its max-age.
    // Sending it from a container that listens on plain HTTP :8080 would make
    // every later plain-HTTP request to that host fail outright.
    $r = request('GET', '/api/health');
    assertTrue(sec_header($r, 'Strict-Transport-Security') === '', 'no HSTS by default');
});

sec_it('headers: an error response leaks no internal detail', [], function () {
    $probes = [
        ['GET', '/api/nonexistent'],
        ['POST', '/api/auth/open', ['code' => "'; DROP TABLE spaces;--", 'password' => 'x', 'device' => ['id' => 'd']]],
        ['POST', '/api/sync/pull', ['cursor' => 0]],
        ['POST', '/api/auth/create', null, 'not json'],
        ['GET', '/api/../api/config.php'],
    ];
    $banned = ['/app/', 'api/', 'SELECT ', 'INSERT ', 'PDOException', 'Stack trace',
        'SQLSTATE', 'password_hash', 'sync.sqlite', 'tt_session=', 'on line ',
        '/var/www', 'PHP/', 'think\\', 'require(', 'PDO'];
    foreach ($probes as $probe) {
        [$method, $path] = $probe;
        $body = $probe[2] ?? null;
        $r = request($method, $path, is_array($body) ? $body : null, null, is_string($body) ? $body : null);
        $text = (string)json_encode($r['body']);
        foreach ($banned as $needle) {
            assertTrue(!str_contains($text, $needle), "response for $path must not contain '$needle': $text");
        }
        // A fixed, code-only error shape.
        if (!empty($r['body']) && ($r['body']['ok'] ?? null) === false) {
            assertSame(array_keys($r['body']), ['ok', 'error'], "$path error shape");
            assertSame(array_keys($r['body']['error']), ['code'], "$path error object has only a code");
        }
    }
});

register_shutdown_function('sec_shutdown');
