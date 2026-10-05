<?php

declare(strict_types=1);

/**
 * Integration test suite for the Tadkhir sync API.
 *
 * Boots the API on a random local port via PHP's built-in server with an
 * isolated SQLite database, then drives it over HTTP (cookie-aware). Run with:
 *
 *   php api/tests/run.php
 *
 * Exit code 0 = all green. A failure prints the diff and exits 1.
 */

define('TT_BASE', dirname(__DIR__, 2));

$php = (string)(getenv('PHP_BIN') ?: PHP_BINARY);
$port = tt_pick_port();
$dbPath = sys_get_temp_dir() . '/tt-sync-test-' . bin2hex(random_bytes(4)) . '.sqlite';
$script = TT_BASE . '/api/index.php';
// /dev/null does not exist on Windows; redirect server output to a log file.
$nullStream = PHP_OS_FAMILY === 'Windows'
    ? sys_get_temp_dir() . '/tt-sync-test-server.log'
    : '/dev/null';

$env = array_merge(getenv(), [
    'DATABASE_PATH'  => $dbPath,
    'ENVIRONMENT'    => 'development',
    'PULL_BATCH'     => '2',
    'RATE_MAX'       => '3',
    'RATE_WINDOW'    => '900',
    // The suite creates ~30 spaces from one address in a few seconds, which is
    // exactly the shape the real auth/create budget exists to stop. Raised here
    // so the functional suite exercises the code rather than the limiter; the
    // limiter itself is covered by its own test below.
    'RATE_MAX_CREATE' => '500',
    'SESSION_LIFETIME' => '86400',
    'MAX_TASKS_PER_SPACE'    => '6',
    'MAX_SESSIONS_PER_SPACE' => '3',
    'MAX_DEVICES_PER_SPACE'  => '3',
    'MAX_EVENTS_PER_SPACE'   => '4',
    // Low on purpose so the finance quota backstop is actually exercised.
    // Each finance store gets its own cap, counted per space.
    'MAX_FINANCE_RECORDS_PER_SPACE' => '3',
    // Windows must be wide enough for the synthetic timestamps used below
    // (2001..2027) but still reject truly broken clocks.
    'MAX_UPDATED_AT_FUTURE_MS' => '31536000000',   // 1 year
    'MAX_UPDATED_AT_AGE_MS'    => '946080000000',  // 30 years
]);

// `-d enable_post_data_reading=0` is the same setting docker/php/php.ini sets,
// and for the same reason: the Web Share Target intake reads a multipart body
// from php://input, and the SAPI has to be told not to consume it first. Without
// this the intake answers 415 and the share tests below would be asserting the
// wrong thing — that the endpoint is broken, rather than that the server it runs
// on was not configured for it.
$proc = proc_open(
    [$php, '-d', 'enable_post_data_reading=0', '-S', "127.0.0.1:$port", $script],
    [1 => ['file', $nullStream, 'w'], 2 => ['file', $nullStream, 'w']],
    $pipes,
    TT_BASE,
    $env
);
if (!is_resource($proc)) {
    fwrite(STDERR, "failed to start server\n");
    exit(2);
}

// Wait for the server to accept connections.
$ready = false;
for ($i = 0; $i < 100; $i++) {
    $s = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
    if ($s !== false) {
        fclose($s);
        $ready = true;
        break;
    }
    usleep(50000);
}
if (!$ready) {
    fwrite(STDERR, "server did not start\n");
    proc_terminate($proc);
    exit(2);
}

register_shutdown_function(function () use ($proc, $dbPath) {
    proc_terminate($proc);
    foreach ([$dbPath, $dbPath . '-wal', $dbPath . '-shm'] as $f) {
        if (is_file($f)) @unlink($f);
    }
});

$tests = [];
$passed = 0;
$failed = 0;

function it(string $name, callable $fn): void {
    global $tests;
    $tests[] = [$name, $fn];
}

/**
 * Perform one HTTP request against the server under test.
 *
 * `$raw` sends a body verbatim, which is how the malformed-JSON cases are
 * expressed. `$headers` replaces individual header lines — passing
 * ['Content-Type' => 'text/plain'] genuinely sends text/plain, which is what the
 * CSRF tests depend on, so an explicit value wins over the JSON default rather
 * than being appended to it.
 */
function request(string $method, string $path, ?array $body = null, ?string $cookie = null, ?string $raw = null, array $headers = []): array {
    global $port;
    $content = $raw ?? ($body === null ? null : json_encode($body));
    $lines = ['Content-Type: application/json'];
    if ($cookie !== null) $lines[] = "Cookie: tt_session=$cookie";
    foreach ($headers as $name => $value) {
        if ($value === '' || $value === null) {
            $lines = array_values(array_filter($lines, fn($l) => stripos($l, $name . ':') !== 0));
            continue;
        }
        $replaced = false;
        foreach ($lines as $i => $l) {
            if (stripos($l, $name . ':') === 0) { $lines[$i] = "$name: $value"; $replaced = true; }
        }
        if (!$replaced) $lines[] = "$name: $value";
    }
    $ctx = stream_context_create([
        'http' => [
            'method'        => $method,
            'header'        => implode("\r\n", array_values(array_filter($lines))),
            'content'       => $content,
            'ignore_errors' => true,
            'timeout'       => 15,
        ],
    ]);
    $resp = @file_get_contents('http://127.0.0.1:' . $port . $path, false, $ctx);
    $headers = $http_response_header ?? [];

    $status = 0;
    foreach ($headers as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) {
            $status = (int)$m[1];
            break;
        }
    }

    $setCookie = '';
    foreach ($headers as $h) {
        if (stripos($h, 'Set-Cookie:') === 0) {
            $setCookie = $h;
            break;
        }
    }
    $parsed = [];
    if ($setCookie !== '') {
        preg_match('/tt_session=([^;]*)/', $setCookie, $m);
        $parsed['value'] = $m[1] ?? '';
        $parsed['httponly'] = (bool)preg_match('/\bHttpOnly\b/i', $setCookie);
        $parsed['samesite'] = preg_match('/SameSite=([a-zA-Z]+)/i', $setCookie, $sm) ? $sm[1] : '';
    } else {
        $parsed['value'] = null;
    }

    return [
        'status'   => $status,
        'body'     => $resp === false ? null : json_decode($resp, true),
        'cookie'   => $parsed,
        'headers'  => $headers,
    ];
}

/** Fetch every page of a pull loop until `more` is false. */
function pullAll(string $cookieA, string $path = '/api/sync/pull'): array {
    $cursor = 0;
    $all = [];
    for (;;) {
        $p = request('POST', $path, ['cursor' => $cursor], $cookieA);
        assertStatus($p, 200, 'pull page in loop');
        foreach ($p['body']['changes'] ?? [] as $c) $all[] = $c;
        $cursor = $p['body']['nextCursor'] ?? 0;
        if (($p['body']['more'] ?? false) !== true) break;
    }
    return $all;
}

/** All pulled changes of the given record types, in pull order. */
function pullTypes(string $cookie, array $types): array {
    return array_values(array_filter(
        pullAll($cookie),
        fn(array $c): bool => in_array($c['type'] ?? '', $types, true)
    ));
}

/** Create a throwaway space and return its session cookie. */
function newSpace(string $code, string $password, string $device): string {
    $r = request('POST', '/api/auth/create', [
        'code' => $code, 'password' => $password, 'device' => ['id' => $device],
    ]);
    assertStatus($r, 200, "create space $code");
    return $r['cookie']['value'];
}

function assertSame($got, $expected, string $msg): void {
    $got = json_encode($got);
    $exp = json_encode($expected);
    if ($got !== $exp) {
        throw new RuntimeException("$msg\n  expected: $exp\n  got:      $got");
    }
}

function assertTrue(bool $cond, string $msg): void {
    if (!$cond) {
        throw new RuntimeException("$msg");
    }
}

function assertStatus(array $res, int $status, string $msg): void {
    if ($res['status'] !== $status) {
        $body = json_encode($res['body']);
        throw new RuntimeException("$msg\n  expected HTTP $status, got {$res['status']}: $body");
    }
}

/* ------------------------------ health ---------------------------------- */

it('health is public', function () {
    $r = request('GET', '/api/health');
    assertStatus($r, 200, 'health');
    assertSame($r['body']['ok'], true, 'health ok');
});

it('same-origin deployment sends no CORS headers', function () {
    $r = request('GET', '/api/health', null, null, null);
    $aca = null;
    foreach ($r['headers'] as $h) {
        if (stripos($h, 'Access-Control-Allow-Origin:') === 0) $aca = $h;
    }
    assertTrue($aca === null, 'no ACAO header when ALLOWED_ORIGIN is empty');
});

/* ------------------------------ auth: create --------------------------- */

it('create rejects bad input', function () {
    $r = request('POST', '/api/auth/create', ['code' => 'x', 'password' => 'short', 'device' => ['id' => 'd1']]);
    assertStatus($r, 400, 'create short-code/short-password');
    $r = request('POST', '/api/auth/create', ['code' => 'validcode', 'password' => 'password', 'device' => ['id' => '']]);
    assertStatus($r, 400, 'create missing device id');
});

it('create returns a session cookie and spaceId', function () {
    global $cookieA;
    $r = request('POST', '/api/auth/create', [
        'code' => 'space_a', 'password' => 'super-secret-pass', 'device' => ['id' => 'dev-a', 'label' => 'Laptop'],
    ]);
    assertStatus($r, 200, 'create ok');
    assertSame($r['body']['ok'], true, 'create ok flag');
    assertSame($r['body']['spaceId'], 1, 'first space is id 1');
    assertTrue(is_int($r['body']['expiresAt']) && $r['body']['expiresAt'] > time() * 1000, 'expiry in ms future');
    assertTrue($r['cookie']['httponly'], 'cookie is httpOnly');
    assertSame($r['cookie']['samesite'], 'Lax', 'cookie samesite lax (same-origin)');
    assertTrue($r['cookie']['value'] !== '', 'cookie present');
    $cookieA = $r['cookie']['value'];
});

it('create rejects duplicate code', function () {
    $r = request('POST', '/api/auth/create', ['code' => 'space_a', 'password' => 'super-secret-pass', 'device' => ['id' => 'dev-x']]);
    assertStatus($r, 409, 'duplicate code');
    assertSame($r['body']['error']['code'] ?? null, 'space_exists', 'duplicate code error key');
});

it('status reflects authentication', function () {
    global $cookieA;
    $r = request('POST', '/api/auth/status', [], $cookieA);
    assertStatus($r, 200, 'status with cookie');
    assertSame($r['body']['authenticated'], true, 'authenticated');
    assertSame($r['body']['spaceId'], 1, 'space 1');
    assertSame($r['body']['deviceCount'], 1, 'one device registered');
});

it('status without cookie is unauthenticated', function () {
    $r = request('POST', '/api/auth/status', []);
    assertStatus($r, 200, 'status without cookie');
    assertSame($r['body']['authenticated'], false, 'not authenticated');
});

/* ------------------------------ auth: open ----------------------------- */

it('open works with correct credentials on a new device', function () {
    global $cookieB;
    $r = request('POST', '/api/auth/open', [
        'code' => 'space_a', 'password' => 'super-secret-pass', 'device' => ['id' => 'dev-b', 'label' => 'Tablet'],
    ]);
    assertStatus($r, 200, 'open ok');
    assertSame($r['body']['spaceId'], 1, 'same space');
    $r2 = request('POST', '/api/auth/status', [], $r['cookie']['value']);
    assertSame($r2['body']['deviceCount'], 2, 'second device registered');
    $cookieB = $r['cookie']['value'];
});

it('open rejects unknown code and wrong password (same 401)', function () {
    $r = request('POST', '/api/auth/open', ['code' => 'nope', 'password' => 'super-secret-pass', 'device' => ['id' => 'd-x']]);
    assertStatus($r, 401, 'unknown code');
    assertSame($r['body']['error']['code'] ?? null, 'invalid_credentials', 'unknown code error');
    $r2 = request('POST', '/api/auth/open', ['code' => 'space_a', 'password' => 'wrong-password', 'device' => ['id' => 'd-x']]);
    assertStatus($r2, 401, 'wrong password');
});

/* ------------------------------ sync: unauthenticated ------------------ */

it('sync requires a session', function () {
    $r = request('POST', '/api/sync/pull', ['cursor' => 0]);
    assertStatus($r, 401, 'pull without cookie');
    assertSame($r['body']['error']['code'] ?? null, 'unauthorized', 'unauthorized code');
    $r = request('POST', '/api/sync/push', ['changes' => []]);
    assertStatus($r, 401, 'push without cookie');
});

/* ------------------------------ sync: push/pull ------------------------ */

it('push then pull returns changes + pagination', function () {
    global $cookieA;
    $t = 1_700_000_000_000;
    $changes = [];
    for ($i = 0; $i < 5; $i++) {
        $changes[] = [
            'type' => 'task', 'id' => "task-$i", 'op' => 'upsert',
            'data' => ['id' => "task-$i", 'title' => "T$i"], 'updatedAt' => $t + $i,
        ];
    }
    $r = request('POST', '/api/sync/push', ['changes' => $changes], $cookieA);
    assertStatus($r, 200, 'push ok');
    assertSame($r['body'], ['ok' => true, 'accepted' => 5, 'rejected' => 0, 'invalid' => 0], 'all accepted');

    $all = pullAll($cookieA);
    $ids = array_column($all, 'id');
    assertSame($ids, ['task-0', 'task-1', 'task-2', 'task-3', 'task-4'], 'all pages');
});

it('pull with a stale cursor returns nothing new', function () {
    global $cookieA;
    $p = request('POST', '/api/sync/pull', ['cursor' => 999999], $cookieA);
    assertStatus($p, 200, 'pull far cursor');
    assertSame($p['body']['changes'], [], 'no changes');
});

it('LWW: older updatedAt is rejected, newer wins', function () {
    global $cookieA;
    $older = ['type' => 'task', 'id' => 'task-0', 'op' => 'upsert',
        'data' => ['title' => 'old'], 'updatedAt' => 1_000_000_000_000];
    $r = request('POST', '/api/sync/push', ['changes' => [$older]], $cookieA);
    assertSame($r['body']['rejected'], 1, 'stale rejected');

    $newer = ['type' => 'task', 'id' => 'task-0', 'op' => 'upsert',
        'data' => ['title' => 'new'], 'updatedAt' => 1_800_000_000_000];
    $r = request('POST', '/api/sync/push', ['changes' => [$newer]], $cookieA);
    assertSame($r['body']['accepted'], 1, 'newer accepted');

    $p = pullAll($cookieA);
    $task0 = null;
    foreach ($p as $c) {
        if ($c['id'] === 'task-0' && ($c['op'] ?? '') === 'upsert') $task0 = $c;
    }
    assertTrue($task0 !== null, 'task-0 present');
    assertSame($task0['data']['title'] ?? null, 'new', 'new title present');
});

it('push is idempotent (LWW equal timestamp)', function () {
    global $cookieA;
    $c = ['type' => 'event', 'id' => 'ev-1', 'op' => 'upsert', 'data' => ['id' => 'ev-1'], 'updatedAt' => 1_700_500_000_000];
    $r1 = request('POST', '/api/sync/push', ['changes' => [$c]], $cookieA);
    $r2 = request('POST', '/api/sync/push', ['changes' => [$c]], $cookieA);
    assertSame($r1['body']['accepted'], 1, 'first accept');
    assertSame($r2['body']['accepted'], 1, 'second accept (idempotent, rev moves)');
});

it('delete becomes a tombstone and survives pull', function () {
    global $cookieA;
    $r = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'session', 'id' => 'sess-del', 'op' => 'delete', 'updatedAt' => 1_800_100_000_000
    ]]], $cookieA);
    assertSame($r['body']['accepted'], 1, 'delete accepted');

    $found = null;
    foreach (pullAll($cookieA) as $c) {
        if ($c['id'] === 'sess-del') $found = $c;
    }
    assertTrue($found !== null, 'tombstone present');
    assertSame($found['op'], 'delete', 'op is delete');
});

it('invalid payloads are rejected with 400 / 413', function () {
    global $cookieA;
    $r = request('POST', '/api/sync/push', null, $cookieA, 'not-json{');
    assertStatus($r, 400, 'invalid json');
    $r = request('POST', '/api/sync/push', ['changes' => [['type' => 'nope', 'id' => '1', 'op' => 'upsert', 'updatedAt' => 1]]], $cookieA);
    assertSame($r['body']['invalid'], 1, 'invalid change counted');
});

it('oversized body -> 413', function () {
    global $cookieA;
    $big = str_repeat('a', 1024 * 1024 + 1);
    $r = request('POST', '/api/sync/push', ['changes' => [['type' => 'task', 'id' => 'x', 'op' => 'upsert', 'data' => ['x' => $big], 'updatedAt' => 1]]], $cookieA);
    assertStatus($r, 413, 'payload too large');
});

/* ------------------------------ space isolation ------------------------ */

it('spaces are fully isolated', function () {
    global $cookieA;
    $r = request('POST', '/api/auth/create', [
        'code' => 'space_b', 'password' => 'another-password', 'device' => ['id' => 'dev-b2'],
    ]);
    assertStatus($r, 200, 'create second space');
    $cookieB2 = $r['cookie']['value'];

    $p = request('POST', '/api/sync/pull', ['cursor' => 0], $cookieB2);
    assertStatus($p, 200, 'pull in space B');
    assertSame($p['body']['changes'], [], 'space B sees nothing from space A');
    assertSame($p['body']['nextCursor'], 0, 'cursor stays 0 in empty space B');

    // Push a record in B, confirm A never sees it.
    request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'task', 'id' => 'bspace-only', 'op' => 'upsert', 'data' => [], 'updatedAt' => 1_800_200_000_000
    ]]], $cookieB2);
    $pA = request('POST', '/api/sync/pull', ['cursor' => 0], $cookieA);
    $ids = array_column($pA['body']['changes'], 'id');
    assertTrue(!in_array('bspace-only', $ids, true), 'space A isolated from space B');
});

/* ------------------------------ quotas ------------------------------- */

it('quota: new tasks/sessions are capped per space; deletes free slots', function () {
    $r = request('POST', '/api/auth/create', [
        'code' => 'space_quota', 'password' => 'quota-password', 'device' => ['id' => 'dq'],
    ]);
    assertStatus($r, 200, 'create quota space');
    $cookie = $r['cookie']['value'];

    $tasks = [];
    for ($i = 0; $i < 6; $i++) {
        $tasks[] = ['type' => 'task', 'id' => "qt-$i", 'op' => 'upsert',
            'data' => ['id' => "qt-$i", 'title' => "Q$i"], 'updatedAt' => 1_800_300_000_000 + $i];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $tasks], $cookie);
    assertStatus($p, 200, 'push under task cap');
    assertSame($p['body']['accepted'], 6, 'six tasks accepted');

    $over = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'task', 'id' => 'qt-over', 'op' => 'upsert',
        'data' => ['id' => 'qt-over', 'title' => 'over'], 'updatedAt' => 1_800_300_100_000,
    ]]], $cookie);
    assertStatus($over, 409, 'over task cap rejected');
    assertSame($over['body']['error']['code'] ?? null, 'limit_reached', 'limit_reached code');

    // Updating an existing record is not a new insert and stays allowed.
    $upd = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'task', 'id' => 'qt-1', 'op' => 'upsert',
        'data' => ['id' => 'qt-1', 'title' => 'updated'], 'updatedAt' => 1_800_300_200_000,
    ]]], $cookie);
    assertStatus($upd, 200, 'update existing task accepted');

    // Sessions have their own quota of 3.
    $sessions = [];
    for ($i = 0; $i < 3; $i++) {
        $sessions[] = ['type' => 'session', 'id' => "qs-$i", 'op' => 'upsert',
            'data' => ['id' => "qs-$i", 'status' => 'completed', 'segments' => []],
            'updatedAt' => 1_800_400_000_000 + $i];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $sessions], $cookie);
    assertStatus($p, 200, 'push under session cap');
    assertSame($p['body']['accepted'], 3, 'three sessions accepted');

    $sover = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'session', 'id' => 'qs-over', 'op' => 'upsert',
        'data' => ['id' => 'qs-over', 'status' => 'completed'], 'updatedAt' => 1_800_400_100_000,
    ]]], $cookie);
    assertStatus($sover, 409, 'over session cap rejected');

    // Deleting a task frees its slot.
    $del = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'task', 'id' => 'qt-0', 'op' => 'delete', 'updatedAt' => 1_800_500_000_000,
    ]]], $cookie);
    assertStatus($del, 200, 'delete one task');
    $freed = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'task', 'id' => 'qt-freed', 'op' => 'upsert',
        'data' => ['id' => 'qt-freed', 'title' => 'freed'], 'updatedAt' => 1_800_500_100_000,
    ]]], $cookie);
    assertStatus($freed, 200, 'task accepted after delete');
});

/* ------------------------------ finance -------------------------------- */

/*
 * Finance is not a separate protocol: it is four more record types over the
 * same push/pull transport, the same encryption envelope and the same
 * last-write-wins rule. These tests assert exactly that — no finance endpoint,
 * no finance-specific server behaviour, and no field the server understands.
 */

const FINANCE_TYPES = ['transaction', 'recurring', 'debt', 'debtPayment'];

it('finance records round-trip through the generic push/pull transport', function () {
    $cookie = newSpace('space_fin', 'finance-password', 'df1');
    $t = 1_810_000_000_000;

    $records = [
        ['type' => 'transaction', 'id' => 'fin-tx-1', 'op' => 'upsert', 'updatedAt' => $t + 1, 'data' => [
            'id' => 'fin-tx-1', 'type' => 'expense', 'title' => 'Groceries', 'amount' => 2550,
            'currency' => 'EUR', 'category' => 'food', 'occurredAt' => $t,
            'note' => null, 'recurringId' => 'fin-rec-1', 'createdAt' => $t, 'updatedAt' => $t,
        ]],
        ['type' => 'recurring', 'id' => 'fin-rec-1', 'op' => 'upsert', 'updatedAt' => $t + 2, 'data' => [
            'id' => 'fin-rec-1', 'type' => 'expense', 'title' => 'Rent', 'amount' => 90000,
            'currency' => 'EUR', 'category' => 'home', 'frequency' => 'monthly',
            'anchorAt' => $t, 'reminderDays' => 0, 'skipped' => [], 'note' => null,
            'active' => true, 'createdAt' => $t, 'updatedAt' => $t,
        ]],
        ['type' => 'debt', 'id' => 'fin-debt-1', 'op' => 'upsert', 'updatedAt' => $t + 3, 'data' => [
            'id' => 'fin-debt-1', 'direction' => 'owed_by_me', 'title' => 'Car repair',
            'person' => 'Sam', 'amount' => 40000, 'currency' => 'EUR', 'category' => 'car',
            'dueAt' => null, 'note' => null, 'createdAt' => $t, 'updatedAt' => $t,
        ]],
        // A payment is its own record so it can sync and be deleted on its own.
        ['type' => 'debtPayment', 'id' => 'fin-pay-1', 'op' => 'upsert', 'updatedAt' => $t + 4, 'data' => [
            'id' => 'fin-pay-1', 'debtId' => 'fin-debt-1', 'title' => null, 'amount' => 10000,
            'occurredAt' => $t, 'note' => null, 'createdAt' => $t, 'updatedAt' => $t,
        ]],
    ];
    $p = request('POST', '/api/sync/push', ['changes' => $records], $cookie);
    assertStatus($p, 200, 'push finance records');
    assertSame($p['body'], ['ok' => true, 'accepted' => 4, 'rejected' => 0, 'invalid' => 0], 'all finance accepted');

    $pulled = pullTypes($cookie, FINANCE_TYPES);
    assertSame(array_column($pulled, 'type'), FINANCE_TYPES, 'all four types pulled back');
    assertSame(array_column($pulled, 'id'), ['fin-tx-1', 'fin-rec-1', 'fin-debt-1', 'fin-pay-1'], 'ids intact');

    // The server is content-agnostic: it returns the payload byte for byte, so
    // the client keeps deriving paid/remaining itself.
    $tx = $pulled[0]['data'];
    assertSame($tx['amount'], 2550, 'amount arrives as integer minor units');
    assertSame($tx['recurringId'], 'fin-rec-1', 'link to the recurring rule survives');
    assertSame($pulled[1]['data']['skipped'], [], 'empty skip list survives');
    assertSame($pulled[3]['data']['debtId'], 'fin-debt-1', 'payment points at its debt');
    // Nothing invented: the server never adds derived totals.
    assertTrue(!array_key_exists('remaining', $pulled[2]['data']), 'no server-computed remaining stored');
    assertTrue(!array_key_exists('paid', $pulled[2]['data']), 'no server-computed paid stored');
});

it('finance records survive the encrypted envelope untouched', function () {
    $cookie = newSpace('space_finenc', 'envelope-password', 'df2');
    $t = 1_810_100_000_000;
    // What the client actually sends: the record sealed under the master key.
    // The server stores an opaque blob and must not inspect or unwrap it.
    $sealed = rtrim(strtr(base64_encode('{"amount":1299,"title":"sealed"}'), '+/', '-_'), '=');
    $p = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'transaction', 'id' => 'fin-enc-1', 'op' => 'upsert', 'updatedAt' => $t,
        'data' => ['c' => $sealed],
    ]]], $cookie);
    assertStatus($p, 200, 'push sealed transaction');
    assertSame($p['body']['accepted'], 1, 'sealed payload accepted like any other');

    $pulled = pullTypes($cookie, ['transaction']);
    assertSame(count($pulled), 1, 'one transaction pulled');
    assertSame($pulled[0]['data'], ['c' => $sealed], 'envelope returned verbatim');
    // The server has no idea what is inside, so it cannot have rewritten it.
    assertTrue(!str_contains(json_encode($pulled[0]['data']), '1299'), 'ciphertext only, never plaintext');
});

it('finance types follow the same last-write-wins rule as tasks', function () {
    $cookie = newSpace('space_finlww', 'lww-password', 'df3');
    $t = 1_810_200_000_000;

    // One debt record, pushed at three different timestamps.
    $change = function (string $title, int $at) use ($t): array {
        return [
            'type' => 'debt', 'id' => 'fin-lww-1', 'op' => 'upsert', 'updatedAt' => $at,
            'data' => ['id' => 'fin-lww-1', 'direction' => 'owed_by_me', 'title' => $title, 'amount' => 1000],
        ];
    };
    $push = function (array $change) use ($cookie): array {
        $r = request('POST', '/api/sync/push', ['changes' => [$change]], $cookie);
        assertStatus($r, 200, 'push one debt version');
        return $r['body'];
    };

    assertSame($push($change('v1', $t))['accepted'], 1, 'first version stored');
    // Strictly older: rejected, and the stored version is untouched.
    assertSame($push($change('v0', $t - 1000))['rejected'], 1, 'older version rejected');
    // Strictly newer: accepted.
    assertSame($push($change('v2', $t + 1000))['accepted'], 1, 'newer version accepted');
    // Equal timestamp is accepted too: the rev moves so the pull cursor stays
    // monotonic, and the stored data is the same version.
    assertSame($push($change('v2', $t + 1000))['accepted'], 1, 'repeat push of the same version is idempotent');

    $pulled = pullTypes($cookie, ['debt']);
    assertSame($pulled[0]['data']['title'], 'v2', 'newest version is the one served');
});

it('deleting a debt payment syncs as its own tombstone', function () {
    $cookie = newSpace('space_findel', 'tombstone-password', 'df4');
    $t = 1_810_300_000_000;

    // A debt and two payments, so the cascade is visible: removing the debt
    // later must not need a second tombstone per payment to be correct.
    $setup = [
        ['type' => 'debt', 'id' => 'fin-del-d', 'op' => 'upsert', 'updatedAt' => $t, 'data' => ['id' => 'fin-del-d']],
        ['type' => 'debtPayment', 'id' => 'fin-del-p1', 'op' => 'upsert', 'updatedAt' => $t, 'data' => ['id' => 'fin-del-p1', 'debtId' => 'fin-del-d']],
        ['type' => 'debtPayment', 'id' => 'fin-del-p2', 'op' => 'upsert', 'updatedAt' => $t, 'data' => ['id' => 'fin-del-p2', 'debtId' => 'fin-del-d']],
    ];
    $p = request('POST', '/api/sync/push', ['changes' => $setup], $cookie);
    assertSame($p['body']['accepted'], 3, 'debt and payments stored');

    $r = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'debtPayment', 'id' => 'fin-del-p1', 'op' => 'delete', 'updatedAt' => $t + 1_000,
    ]]], $cookie);
    assertStatus($r, 200, 'payment delete accepted');
    assertSame($r['body']['accepted'], 1, 'payment tombstone accepted');

    $byId = [];
    foreach (pullTypes($cookie, FINANCE_TYPES) as $c) $byId[$c['id']] = $c;
    assertSame($byId['fin-del-p1']['op'], 'delete', 'payment is a tombstone');
    assertSame($byId['fin-del-p2']['op'] ?? null, 'upsert', 'sibling payment untouched');
    assertSame($byId['fin-del-d']['op'] ?? null, 'upsert', 'debt itself untouched');
    // A tombstone carries no payload, so a stale device cannot resurrect data.
    assertSame($byId['fin-del-p1']['data'], null, 'tombstone has no data');
});

it('the record-type whitelist stays closed to unknown finance-ish types', function () {
    $cookie = newSpace('space_finwl', 'whitelist-password', 'df5');
    $t = 1_810_400_000_000;
    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'budget',    'id' => 'x1', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'account',   'id' => 'x2', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'wallet',    'id' => 'x3', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'debt_payment', 'id' => 'x4', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'transactions',  'id' => 'x5', 'op' => 'upsert', 'updatedAt' => $t],
    ]], $cookie);
    assertStatus($p, 200, 'push unknown types');
    assertSame($p['body'], ['ok' => true, 'accepted' => 0, 'rejected' => 0, 'invalid' => 5], 'all unknown types invalid');
    assertSame(pullAll($cookie), [], 'nothing was stored');
});

it('syncs categories and people through the generic record protocol', function () {
    $cookie = newSpace('space_catpeople', 'catpeople-password', 'df5b');
    $t = 1_810_450_000_000;
    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'category', 'id' => 'groceries', 'op' => 'upsert', 'data' => ['id' => 'groceries'], 'updatedAt' => $t],
        ['type' => 'person',   'id' => 'p1',        'op' => 'upsert', 'data' => ['id' => 'p1', 'name' => 'Alice'], 'updatedAt' => $t + 1],
    ]], $cookie);
    assertStatus($p, 200, 'push categories and people');
    assertSame($p['body']['accepted'], 2, 'both accepted');
    $pulled = pullAll($cookie);
    assertSame(count($pulled), 2, 'pulled two records');
});

it('quota: finance records are capped per store per space; deletes free slots', function () {
    $cookie = newSpace('space_finquota', 'fin-quota-password', 'df6');
    $t = 1_810_500_000_000;
    // The suite runs with MAX_FINANCE_RECORDS_PER_SPACE=3.

    $batch = [];
    for ($i = 0; $i < 3; $i++) {
        $batch[] = ['type' => 'transaction', 'id' => "fqt-$i", 'op' => 'upsert',
            'data' => ['id' => "fqt-$i", 'type' => 'expense', 'title' => "Q$i", 'amount' => 100 + $i],
            'updatedAt' => $t + $i];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $batch], $cookie);
    assertStatus($p, 200, 'push under the finance cap');
    assertSame($p['body']['accepted'], 3, 'three transactions accepted');

    $over = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'transaction', 'id' => 'fqt-over', 'op' => 'upsert',
        'data' => ['id' => 'fqt-over', 'type' => 'expense', 'title' => 'over', 'amount' => 1],
        'updatedAt' => $t + 10,
    ]]], $cookie);
    assertStatus($over, 409, 'over the finance cap rejected');
    assertSame($over['body']['error']['code'] ?? null, 'limit_reached', 'limit_reached code');

    // The cap is per store, not per space: a debt still fits.
    $other = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'debt', 'id' => 'fqt-debt', 'op' => 'upsert',
        'data' => ['id' => 'fqt-debt', 'direction' => 'owed_by_me', 'title' => 'd', 'amount' => 1],
        'updatedAt' => $t + 10,
    ]]], $cookie);
    assertStatus($other, 200, 'a different finance store has its own quota');
    assertSame($other['body']['accepted'], 1, 'debt accepted');

    // Updating an existing record is not a new insert.
    $upd = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'transaction', 'id' => 'fqt-1', 'op' => 'upsert',
        'data' => ['id' => 'fqt-1', 'type' => 'expense', 'title' => 'updated', 'amount' => 999],
        'updatedAt' => $t + 20,
    ]]], $cookie);
    assertStatus($upd, 200, 'update under the cap stays allowed');

    // Deleting frees exactly one slot.
    $del = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'transaction', 'id' => 'fqt-0', 'op' => 'delete', 'updatedAt' => $t + 30,
    ]]], $cookie);
    assertStatus($del, 200, 'delete one transaction');
    $freed = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'transaction', 'id' => 'fqt-new', 'op' => 'upsert',
        'data' => ['id' => 'fqt-new', 'type' => 'expense', 'title' => 'new', 'amount' => 1],
        'updatedAt' => $t + 40,
    ]]], $cookie);
    assertStatus($freed, 200, 'new transaction accepted after a delete');
    assertSame($freed['body']['accepted'], 1, 'freed slot used');
});

/* ------------------------------ later ---------------------------------- */

/*
 * Later is not a separate protocol either: one more record type over the same
 * push/pull transport, the same encryption envelope, the same last-write-wins
 * rule and the same tombstones. These tests assert exactly that — no later
 * endpoint, no later-specific server behaviour, and no field the server
 * understands.
 */
it('later items round-trip through the generic push/pull transport', function () {
    $cookie = newSpace('space_later', 'later-password', 'dl1');
    $t = 1_810_600_000_000;

    $records = [
        ['type' => 'later', 'id' => 'lat-1', 'op' => 'upsert', 'updatedAt' => $t + 1, 'data' => [
            'id' => 'lat-1', 'type' => 'link', 'title' => 'Read later', 'content' => null,
            'url' => 'https://example.com/a', 'completedAt' => null, 'createdAt' => $t, 'updatedAt' => $t,
        ]],
        ['type' => 'later', 'id' => 'lat-2', 'op' => 'upsert', 'updatedAt' => $t + 2, 'data' => [
            'id' => 'lat-2', 'type' => 'note', 'title' => null, 'content' => 'look into offline sync',
            'url' => null, 'completedAt' => $t + 3, 'createdAt' => $t, 'updatedAt' => $t + 3,
        ]],
    ];
    $p = request('POST', '/api/sync/push', ['changes' => $records], $cookie);
    assertStatus($p, 200, 'push later items');
    assertSame($p['body'], ['ok' => true, 'accepted' => 2, 'rejected' => 0, 'invalid' => 0], 'both later items accepted');

    $pulled = pullTypes($cookie, ['later']);
    assertSame(count($pulled), 2, 'two later items pulled back');
    assertSame(array_column($pulled, 'id'), ['lat-1', 'lat-2'], 'ids intact');
    // The server is content-agnostic: it returns the payload as it was sent, so
    // the client keeps deriving "open vs followed up" itself.
    assertSame($pulled[0]['data']['url'], 'https://example.com/a', 'link url survives');
    assertSame($pulled[1]['data']['completedAt'], $t + 3, 'the followed-up stamp is just data');
    assertTrue(!array_key_exists('done', $pulled[1]['data']), 'no server-computed flag stored');
});

it('later records survive the encrypted envelope untouched', function () {
    $cookie = newSpace('space_laterenc', 'envelope-password', 'dl2');
    $t = 1_810_650_000_000;
    $sealed = rtrim(strtr(base64_encode('{"content":"sealed later note"}'), '+/', '-_'), '=');
    $p = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'later', 'id' => 'lat-enc-1', 'op' => 'upsert', 'updatedAt' => $t,
        'data' => ['c' => $sealed],
    ]]], $cookie);
    assertStatus($p, 200, 'push sealed later item');
    assertSame($p['body']['accepted'], 1, 'sealed payload accepted like any other');

    $pulled = pullTypes($cookie, ['later']);
    assertSame($pulled[0]['data'], ['c' => $sealed], 'envelope returned verbatim');
    assertTrue(!str_contains(json_encode($pulled[0]['data']), 'sealed'), 'ciphertext only, never plaintext');
});

it('later items follow the same last-write-wins rule as tasks', function () {
    $cookie = newSpace('space_laterlww', 'lww-password', 'dl3');
    $t = 1_810_700_000_000;

    $change = function (string $title, int $at) use ($t): array {
        return [
            'type' => 'later', 'id' => 'lat-lww-1', 'op' => 'upsert', 'updatedAt' => $at,
            'data' => ['id' => 'lat-lww-1', 'type' => 'link', 'title' => $title, 'url' => 'https://a.dev/'],
        ];
    };
    $push = function (array $change) use ($cookie): array {
        $r = request('POST', '/api/sync/push', ['changes' => [$change]], $cookie);
        assertStatus($r, 200, 'push one later version');
        return $r['body'];
    };

    assertSame($push($change('v1', $t))['accepted'], 1, 'first version stored');
    assertSame($push($change('v0', $t - 1000))['rejected'], 1, 'older version rejected');
    assertSame($push($change('v2', $t + 1000))['accepted'], 1, 'newer version accepted');
    assertSame($push($change('v2', $t + 1000))['accepted'], 1, 'repeat push of the same version is idempotent');

    $pulled = pullTypes($cookie, ['later']);
    assertSame($pulled[0]['data']['title'], 'v2', 'newest version is the one served');
});

it('deleting a later item syncs as its own tombstone', function () {
    $cookie = newSpace('space_laterdel', 'tombstone-password', 'dl4');
    $t = 1_810_750_000_000;

    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'later', 'id' => 'lat-del-1', 'op' => 'upsert', 'updatedAt' => $t,
            'data' => ['id' => 'lat-del-1', 'type' => 'note', 'content' => 'one']],
        ['type' => 'later', 'id' => 'lat-del-2', 'op' => 'upsert', 'updatedAt' => $t,
            'data' => ['id' => 'lat-del-2', 'type' => 'note', 'content' => 'two']],
    ]], $cookie);
    assertSame($p['body']['accepted'], 2, 'two later items stored');

    $r = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'later', 'id' => 'lat-del-1', 'op' => 'delete', 'updatedAt' => $t + 1_000,
    ]]], $cookie);
    assertStatus($r, 200, 'later delete accepted');
    assertSame($r['body']['accepted'], 1, 'later tombstone accepted');

    $byId = [];
    foreach (pullTypes($cookie, ['later']) as $c) $byId[$c['id']] = $c;
    assertSame($byId['lat-del-1']['op'], 'delete', 'item is a tombstone');
    assertSame($byId['lat-del-1']['data'], null, 'a tombstone carries no data');
    // Deleting one item leaves the others alone: they are separate records, not
    // rows of a shared document.
    assertSame($byId['lat-del-2']['op'], 'upsert', 'sibling item untouched');
    assertSame($byId['lat-del-2']['data']['content'], 'two', 'sibling keeps its content');
});

it('the record-type whitelist still refuses unknown later-ish types', function () {
    $cookie = newSpace('space_laterwl', 'whitelist-password', 'dl5');
    $t = 1_810_800_000_000;
    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'laterItem',  'id' => 'x1', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'laters',    'id' => 'x2', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'bookmark',  'id' => 'x3', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'read_later','id' => 'x4', 'op' => 'upsert', 'updatedAt' => $t],
    ]], $cookie);
    assertStatus($p, 200, 'push unknown later-ish types');
    assertSame($p['body'], ['ok' => true, 'accepted' => 0, 'rejected' => 0, 'invalid' => 4], 'all unknown types invalid');
    assertSame(pullAll($cookie), [], 'nothing was stored');
});

it('quota: later items share the per-store cap; deletes free slots', function () {
    $cookie = newSpace('space_laterquota', 'later-quota-password', 'dl6');
    $t = 1_810_850_000_000;
    // The suite runs with MAX_FINANCE_RECORDS_PER_SPACE=3, which is the shared
    // backstop cap for every store beyond tasks and sessions.

    $batch = [];
    for ($i = 0; $i < 3; $i++) {
        $batch[] = ['type' => 'later', 'id' => "lqt-$i", 'op' => 'upsert',
            'data' => ['id' => "lqt-$i", 'type' => 'note', 'content' => "note $i"],
            'updatedAt' => $t + $i];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $batch], $cookie);
    assertStatus($p, 200, 'push under the shared cap');
    assertSame($p['body']['accepted'], 3, 'three later items accepted');

    $over = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'later', 'id' => 'lqt-over', 'op' => 'upsert',
        'data' => ['id' => 'lqt-over', 'type' => 'note', 'content' => 'over'],
        'updatedAt' => $t + 10,
    ]]], $cookie);
    assertStatus($over, 409, 'over the cap rejected');
    assertSame($over['body']['error']['code'] ?? null, 'limit_reached', 'limit_reached code');

    // The cap is per store: finance still has its own budget.
    $other = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'transaction', 'id' => 'lqt-tx', 'op' => 'upsert',
        'data' => ['id' => 'lqt-tx', 'type' => 'expense', 'title' => 'still free', 'amount' => 1],
        'updatedAt' => $t + 10,
    ]]], $cookie);
    assertStatus($other, 200, 'a different store has its own quota');
    assertSame($other['body']['accepted'], 1, 'transaction accepted');

    // Updating an existing item is not a new insert.
    $upd = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'later', 'id' => 'lqt-1', 'op' => 'upsert',
        'data' => ['id' => 'lqt-1', 'type' => 'note', 'content' => 'edited'],
        'updatedAt' => $t + 20,
    ]]], $cookie);
    assertStatus($upd, 200, 'update under the cap stays allowed');

    // Deleting frees exactly one slot.
    $del = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'later', 'id' => 'lqt-0', 'op' => 'delete', 'updatedAt' => $t + 30,
    ]]], $cookie);
    assertStatus($del, 200, 'delete one later item');
    $freed = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'later', 'id' => 'lqt-new', 'op' => 'upsert',
        'data' => ['id' => 'lqt-new', 'type' => 'note', 'content' => 'new'],
        'updatedAt' => $t + 40,
    ]]], $cookie);
    assertStatus($freed, 200, 'new later item accepted after a delete');
    assertSame($freed['body']['accepted'], 1, 'freed slot used');
});

/* ----------------------------- routines -------------------------------- */

/*
 * Routines are not a separate protocol either: two more record types over the
 * same push/pull transport, the same encryption envelope, the same
 * last-write-wins rule and the same tombstones — a rule, and the day rows a
 * counter recorded. There is no routines endpoint and no server-side notion of
 * "today", "due" or "missed": the server stores rows and hands them back, and
 * every one of those questions is answered on the device from the records it
 * already had.
 *
 * What these tests assert is therefore narrow and deliberate: the two types are
 * accepted, a payload comes back exactly as it went in, a run is NOT a record
 * type of its own (it is an ordinary session carrying the rule's id), and a rule
 * is tombstoned like anything else.
 */
it('routines and their day rows round-trip through the generic transport', function () {
    $cookie = newSpace('space_routine', 'routine-password', 'rt1');
    $t = 1_810_900_000_000;

    $records = [
        ['type' => 'routine', 'id' => 'rt-1', 'op' => 'upsert', 'updatedAt' => $t + 1, 'data' => [
            'id' => 'rt-1', 'kind' => 'timed', 'frequency' => 'weekly', 'title' => 'Wash the car',
            'weekday' => 5, 'durationMs' => 3600000, 'target' => null,
            'reminderBeforeMs' => 3600000, 'reminderEveryMs' => null, 'active' => true,
            'createdAt' => $t, 'updatedAt' => $t,
        ]],
        ['type' => 'routine', 'id' => 'rt-2', 'op' => 'upsert', 'updatedAt' => $t + 2, 'data' => [
            'id' => 'rt-2', 'kind' => 'counter', 'frequency' => 'daily', 'title' => 'Water',
            'weekday' => null, 'durationMs' => null, 'target' => 5,
            'reminderBeforeMs' => null, 'reminderEveryMs' => 3600000, 'active' => true,
            'createdAt' => $t, 'updatedAt' => $t,
        ]],
        // The id IS the (routine, day) pair, which is how two devices agree on one
        // counter's day without ever writing a second row for it.
        ['type' => 'routineLog', 'id' => 'rt-2@2026-09-30', 'op' => 'upsert', 'updatedAt' => $t + 3, 'data' => [
            'id' => 'rt-2@2026-09-30', 'routineId' => 'rt-2', 'dayKey' => '2026-09-30',
            'count' => 3, 'updatedAt' => $t + 3,
        ]],
    ];
    $p = request('POST', '/api/sync/push', ['changes' => $records], $cookie);
    assertStatus($p, 200, 'push routines and a day row');
    assertSame($p['body'], ['ok' => true, 'accepted' => 3, 'rejected' => 0, 'invalid' => 0], 'all three accepted');

    $pulled = pullTypes($cookie, ['routine', 'routineLog']);
    assertSame(count($pulled), 3, 'all three pulled back');
    assertSame($pulled[0]['data']['weekday'], 5, 'a weekday is just data');
    assertSame($pulled[1]['data']['target'], 5, 'and so is a target');
    assertSame($pulled[2]['data']['count'], 3, 'the day row keeps its count');
    assertTrue(!array_key_exists('done', $pulled[0]['data']), 'nothing computed on the server');
    assertTrue(!array_key_exists('overdue', $pulled[0]['data']), 'and no notion of being late');
});

it('a run is an ordinary session, not a record type of its own', function () {
    $cookie = newSpace('space_routinesess', 'routine-session-password', 'rt2');
    $t = 1_810_950_000_000;

    // A timed routine's run is the app's own timer: a session carrying the rule's
    // id and its duration as the estimate. There is no "routineRun" type, and the
    // whitelist must refuse one if anybody ever sends it.
    $p = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'session', 'id' => 'rs-1', 'op' => 'upsert', 'updatedAt' => $t,
        'data' => [
            'id' => 'rs-1', 'taskId' => null, 'taskTitle' => 'Run', 'routineId' => 'rt-1',
            'estimatedMs' => 1800000, 'status' => 'completed', 'segments' => [],
            'startedAt' => $t - 1800000, 'endedAt' => $t, 'actualMs' => 1800000,
            'createdAt' => $t - 1800000, 'updatedAt' => $t,
        ],
    ]]], $cookie);
    assertStatus($p, 200, 'push a session that belongs to a routine');
    assertSame($p['body']['accepted'], 1, 'accepted as a session');

    $pulled = pullTypes($cookie, ['session']);
    assertSame($pulled[0]['data']['routineId'], 'rt-1', 'the link is the only routine-shaped field on it');

    $bogus = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'routineRun', 'id' => 'x1', 'op' => 'upsert', 'updatedAt' => $t, 'data' => ['id' => 'x1']],
        ['type' => 'routineSession', 'id' => 'x2', 'op' => 'upsert', 'updatedAt' => $t, 'data' => ['id' => 'x2']],
        ['type' => 'routines', 'id' => 'x3', 'op' => 'upsert', 'updatedAt' => $t, 'data' => ['id' => 'x3']],
    ]], $cookie);
    assertStatus($bogus, 200, 'push routine-ish types that do not exist');
    assertSame($bogus['body'], ['ok' => true, 'accepted' => 0, 'rejected' => 0, 'invalid' => 3], 'all invalid');
    assertSame(count(pullTypes($cookie, ['session'])), 1, 'and none of them stored anything');
});

it('a deleted routine tombstones like anything else, and its day rows are separate records', function () {
    $cookie = newSpace('space_routinedel', 'routine-delete-password', 'rt3');
    $t = 1_811_000_000_000;

    request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'routine', 'id' => 'rtd-1', 'op' => 'upsert', 'updatedAt' => $t,
            'data' => ['id' => 'rtd-1', 'kind' => 'counter', 'frequency' => 'daily', 'title' => 'Water',
                'weekday' => null, 'durationMs' => null, 'target' => 5, 'reminderBeforeMs' => null,
                'reminderEveryMs' => null, 'active' => true, 'createdAt' => $t, 'updatedAt' => $t]],
        ['type' => 'routineLog', 'id' => 'rtd-1@2026-09-30', 'op' => 'upsert', 'updatedAt' => $t + 1,
            'data' => ['id' => 'rtd-1@2026-09-30', 'routineId' => 'rtd-1', 'dayKey' => '2026-09-30',
                'count' => 4, 'updatedAt' => $t + 1]],
    ]], $cookie);

    // The rule goes, and its days are tombstoned by the CLIENT, one row each —
    // the server has no cascade of its own, because it has no model of what a
    // day row means. A day row left behind is a number no device can place, so
    // the client must send those tombstones too; this test says the transport
    // carries them when it does.
    $d = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'routine', 'id' => 'rtd-1', 'op' => 'delete', 'updatedAt' => $t + 10],
        ['type' => 'routineLog', 'id' => 'rtd-1@2026-09-30', 'op' => 'delete', 'updatedAt' => $t + 10],
    ]], $cookie);
    assertStatus($d, 200, 'delete a routine and its day row');
    assertSame($d['body']['accepted'], 2, 'both tombstones stored');

    $byId = [];
    foreach (pullTypes($cookie, ['routine', 'routineLog']) as $c) $byId[$c['id']] = $c;
    assertSame($byId['rtd-1']['op'], 'delete', 'the rule is a tombstone');
    assertSame($byId['rtd-1@2026-09-30']['op'], 'delete', 'and so is its day');
    assertSame($byId['rtd-1']['data'], null, 'a tombstone carries no payload');
});

it('quota: routines share the same per-store cap as every other non-core store', function () {
    $cookie = newSpace('space_routinequota', 'routine-quota-password', 'rt4');
    $t = 1_811_050_000_000;

    // The suite runs with MAX_FINANCE_RECORDS_PER_SPACE=3, the shared backstop cap.
    $batch = [];
    for ($i = 0; $i < 3; $i++) {
        $batch[] = ['type' => 'routine', 'id' => "rqt-$i", 'op' => 'upsert', 'updatedAt' => $t + $i,
            'data' => ['id' => "rqt-$i", 'kind' => 'counter', 'frequency' => 'daily',
                'title' => "W$i", 'weekday' => null, 'durationMs' => null, 'target' => 5,
                'reminderBeforeMs' => null, 'reminderEveryMs' => null, 'active' => true,
                'createdAt' => $t, 'updatedAt' => $t]];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $batch], $cookie);
    assertStatus($p, 200, 'push under the shared cap');
    assertSame($p['body']['accepted'], 3, 'three routines accepted');

    $over = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'routine', 'id' => 'rqt-over', 'op' => 'upsert', 'updatedAt' => $t + 10,
        'data' => ['id' => 'rqt-over', 'kind' => 'counter', 'frequency' => 'daily', 'title' => 'over',
            'weekday' => null, 'durationMs' => null, 'target' => 5, 'reminderBeforeMs' => null,
            'reminderEveryMs' => null, 'active' => true, 'createdAt' => $t, 'updatedAt' => $t],
    ]]], $cookie);
    assertStatus($over, 409, 'over the cap rejected');
    assertSame($over['body']['error']['code'] ?? null, 'limit_reached', 'limit_reached code');

    // A day row is its own record with its own budget, which is the point of
    // storing it apart from the rule: history is bounded by history.
    $day = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'routineLog', 'id' => 'rqt-0@2026-09-30', 'op' => 'upsert', 'updatedAt' => $t + 20,
        'data' => ['id' => 'rqt-0@2026-09-30', 'routineId' => 'rqt-0', 'dayKey' => '2026-09-30',
            'count' => 2, 'updatedAt' => $t + 20],
    ]]], $cookie);
    assertStatus($day, 200, 'a day row has its own budget');
    assertSame($day['body']['accepted'], 1, 'day row accepted');

    // And a delete frees exactly one slot.
    $del = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'routine', 'id' => 'rqt-0', 'op' => 'delete', 'updatedAt' => $t + 30,
    ]]], $cookie);
    assertStatus($del, 200, 'delete one routine');
    $freed = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'routine', 'id' => 'rqt-new', 'op' => 'upsert', 'updatedAt' => $t + 40,
        'data' => ['id' => 'rqt-new', 'kind' => 'timed', 'frequency' => 'daily', 'title' => 'Run',
            'weekday' => null, 'durationMs' => 1800000, 'target' => null, 'reminderBeforeMs' => null,
            'reminderEveryMs' => null, 'active' => true, 'createdAt' => $t, 'updatedAt' => $t],
    ]]], $cookie);
    assertStatus($freed, 200, 'new routine accepted after a delete');
    assertSame($freed['body']['accepted'], 1, 'freed slot used');
});

/* ------------------------------ pages ---------------------------------- */

/*
 * Pages are not a separate protocol either: two more record types over the same
 * push/pull transport, the same encryption envelope, the same last-write-wins
 * rule and the same tombstones. These tests assert exactly that — no pages
 * endpoint, no pages-specific server behaviour, and no field the server
 * understands. A page is an organisation layer over records that live somewhere
 * else, so what matters here is that a pointer stays a pointer: the server must
 * hand back the id it was given and invent nothing about the record it names.
 */
const PAGE_TYPES = ['page', 'pageItem'];

it('pages and page items round-trip through the generic push/pull transport', function () {
    $cookie = newSpace('space_pages', 'pages-password', 'dp1');
    $t = 1_811_000_000_000;

    $records = [
        ['type' => 'page', 'id' => 'pg-1', 'op' => 'upsert', 'updatedAt' => $t + 1, 'data' => [
            'id' => 'pg-1', 'title' => 'Sprint 4', 'description' => 'what this page is for',
            'createdAt' => $t, 'updatedAt' => $t + 1,
        ]],
        ['type' => 'pageItem', 'id' => 'pi-1', 'op' => 'upsert', 'updatedAt' => $t + 2, 'data' => [
            'id' => 'pi-1', 'pageId' => 'pg-1', 'type' => 'heading', 'position' => 0,
            'content' => ['text' => 'Shipped'], 'createdAt' => $t, 'updatedAt' => $t + 2,
        ]],
        // A pointer at a record that lives in another store entirely. The page
        // holds the id and nothing else.
        ['type' => 'pageItem', 'id' => 'pi-2', 'op' => 'upsert', 'updatedAt' => $t + 3, 'data' => [
            'id' => 'pi-2', 'pageId' => 'pg-1', 'type' => 'task', 'position' => 1,
            'content' => ['taskId' => 'task-0'], 'createdAt' => $t, 'updatedAt' => $t + 3,
        ]],
        ['type' => 'pageItem', 'id' => 'pi-3', 'op' => 'upsert', 'updatedAt' => $t + 4, 'data' => [
            'id' => 'pi-3', 'pageId' => 'pg-1', 'type' => 'divider', 'position' => 2,
            'content' => null, 'createdAt' => $t, 'updatedAt' => $t + 4,
        ]],
    ];
    $p = request('POST', '/api/sync/push', ['changes' => $records], $cookie);
    assertStatus($p, 200, 'push page records');
    assertSame($p['body'], ['ok' => true, 'accepted' => 4, 'rejected' => 0, 'invalid' => 0], 'all page records accepted');

    $pulled = pullTypes($cookie, PAGE_TYPES);
    assertSame(array_column($pulled, 'type'), ['page', 'pageItem', 'pageItem', 'pageItem'], 'both types pulled back');
    assertSame(array_column($pulled, 'id'), ['pg-1', 'pi-1', 'pi-2', 'pi-3'], 'ids intact');

    // The server is content-agnostic: it returns each payload as it was sent, so
    // the client keeps deriving the order and the labels itself.
    assertSame($pulled[1]['data']['position'], 0, 'the order is just a number in the payload');
    assertSame($pulled[2]['data']['content'], ['taskId' => 'task-0'], 'a pointer stays a pointer');
    assertTrue(!array_key_exists('label', $pulled[2]['data']), 'no server-resolved title stored');
    assertSame($pulled[3]['data']['content'], null, 'a divider carries no content');
});

it('page records survive the encrypted envelope untouched', function () {
    $cookie = newSpace('space_pagesenc', 'envelope-password', 'dp2');
    $t = 1_811_050_000_000;
    $sealed = rtrim(strtr(base64_encode('{"title":"sealed page"}'), '+/', '-_'), '=');
    $p = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'page', 'id' => 'pg-enc-1', 'op' => 'upsert', 'updatedAt' => $t,
        'data' => ['c' => $sealed],
    ]]], $cookie);
    assertStatus($p, 200, 'push sealed page');
    assertSame($p['body']['accepted'], 1, 'sealed payload accepted like any other');

    $pulled = pullTypes($cookie, ['page']);
    assertSame(count($pulled), 1, 'one page pulled');
    assertSame($pulled[0]['data'], ['c' => $sealed], 'envelope returned verbatim');
    assertTrue(!str_contains(json_encode($pulled[0]['data']), 'sealed'), 'ciphertext only, never plaintext');
});

it('pages follow the same last-write-wins rule as tasks', function () {
    $cookie = newSpace('space_pageslww', 'lww-password', 'dp3');
    $t = 1_811_100_000_000;

    $change = function (string $title, int $at) use ($t): array {
        return [
            'type' => 'page', 'id' => 'pg-lww-1', 'op' => 'upsert', 'updatedAt' => $at,
            'data' => ['id' => 'pg-lww-1', 'title' => $title],
        ];
    };
    $push = function (array $change) use ($cookie): array {
        $r = request('POST', '/api/sync/push', ['changes' => [$change]], $cookie);
        assertStatus($r, 200, 'push one page version');
        return $r['body'];
    };

    assertSame($push($change('v1', $t))['accepted'], 1, 'first version stored');
    assertSame($push($change('v0', $t - 1000))['rejected'], 1, 'older version rejected');
    assertSame($push($change('v2', $t + 1000))['accepted'], 1, 'newer version accepted');
    assertSame($push($change('v2', $t + 1000))['accepted'], 1, 'repeat push of the same version is idempotent');

    $pulled = pullTypes($cookie, ['page']);
    assertSame($pulled[0]['data']['title'], 'v2', 'newest version is the one served');
});

it('a page and its items are independent records, so each delete is its own tombstone', function () {
    $cookie = newSpace('space_pagesdel', 'tombstone-password', 'dp4');
    $t = 1_811_150_000_000;

    // Deleting a page takes its items with it, and the client writes that as one
    // tombstone per record — but the cascade is a client decision, not a server
    // one. The server stores exactly the tombstones it is handed, which is what
    // makes the same delete correct on every device without the server knowing
    // what a page is.
    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'page', 'id' => 'pg-del', 'op' => 'upsert', 'updatedAt' => $t,
            'data' => ['id' => 'pg-del', 'title' => 'to be removed']],
        ['type' => 'pageItem', 'id' => 'pi-del-1', 'op' => 'upsert', 'updatedAt' => $t,
            'data' => ['id' => 'pi-del-1', 'pageId' => 'pg-del', 'type' => 'text', 'position' => 0]],
        ['type' => 'pageItem', 'id' => 'pi-keep', 'op' => 'upsert', 'updatedAt' => $t,
            'data' => ['id' => 'pi-keep', 'pageId' => 'pg-keep', 'type' => 'text', 'position' => 0]],
    ]], $cookie);
    assertSame($p['body']['accepted'], 3, 'page and both items stored');

    $r = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'page', 'id' => 'pg-del', 'op' => 'delete', 'updatedAt' => $t + 1_000],
        ['type' => 'pageItem', 'id' => 'pi-del-1', 'op' => 'delete', 'updatedAt' => $t + 1_000],
    ]], $cookie);
    assertStatus($r, 200, 'page cascade delete accepted');
    assertSame($r['body']['accepted'], 2, 'one tombstone per record');

    $byId = [];
    foreach (pullTypes($cookie, PAGE_TYPES) as $c) $byId[$c['id']] = $c;
    assertSame($byId['pg-del']['op'], 'delete', 'page is a tombstone');
    assertSame($byId['pg-del']['data'], null, 'a tombstone carries no data');
    assertSame($byId['pi-del-1']['op'], 'delete', 'its item is its own tombstone');
    // An item on a page that was not deleted is untouched, and a stale device
    // cannot resurrect the deleted line from a tombstone.
    assertSame($byId['pi-keep']['op'] ?? null, 'upsert', 'item on another page untouched');
    assertSame($byId['pi-keep']['data']['pageId'], 'pg-keep', 'surviving item keeps its owner');
});

it('the record-type whitelist still refuses unknown page-ish types', function () {
    $cookie = newSpace('space_pageswl', 'whitelist-password', 'dp5');
    $t = 1_811_200_000_000;
    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'pages',       'id' => 'x1', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'page_item',   'id' => 'x2', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'pageitems',   'id' => 'x3', 'op' => 'upsert', 'updatedAt' => $t],
        ['type' => 'block',       'id' => 'x4', 'op' => 'upsert', 'updatedAt' => $t],
    ]], $cookie);
    assertStatus($p, 200, 'push unknown page-ish types');
    assertSame($p['body'], ['ok' => true, 'accepted' => 0, 'rejected' => 0, 'invalid' => 4], 'all unknown types invalid');
    assertSame(pullAll($cookie), [], 'nothing was stored');
});

it('quota: pages and page items each get their own per-store cap; deletes free slots', function () {
    $cookie = newSpace('space_pagesquota', 'pages-quota-password', 'dp6');
    $t = 1_811_250_000_000;
    // The suite runs with MAX_FINANCE_RECORDS_PER_SPACE=3, the shared backstop
    // cap for every store beyond tasks and sessions.

    $batch = [];
    for ($i = 0; $i < 3; $i++) {
        $batch[] = ['type' => 'page', 'id' => "pqt-$i", 'op' => 'upsert',
            'data' => ['id' => "pqt-$i", 'title' => "P$i"], 'updatedAt' => $t + $i];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $batch], $cookie);
    assertStatus($p, 200, 'push under the shared cap');
    assertSame($p['body']['accepted'], 3, 'three pages accepted');

    $over = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'page', 'id' => 'pqt-over', 'op' => 'upsert',
        'data' => ['id' => 'pqt-over', 'title' => 'over'], 'updatedAt' => $t + 10,
    ]]], $cookie);
    assertStatus($over, 409, 'over the cap rejected');
    assertSame($over['body']['error']['code'] ?? null, 'limit_reached', 'limit_reached code');

    // The cap is per store: a full pages store does not lock out page items.
    $items = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'pageItem', 'id' => 'pqt-i-1', 'op' => 'upsert',
        'data' => ['id' => 'pqt-i-1', 'pageId' => 'pqt-0', 'type' => 'text', 'position' => 0],
        'updatedAt' => $t + 10,
    ]]], $cookie);
    assertStatus($items, 200, 'a different store has its own quota');
    assertSame($items['body']['accepted'], 1, 'page item accepted');

    // Updating an existing record is not a new insert.
    $upd = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'page', 'id' => 'pqt-1', 'op' => 'upsert',
        'data' => ['id' => 'pqt-1', 'title' => 'edited'], 'updatedAt' => $t + 20,
    ]]], $cookie);
    assertStatus($upd, 200, 'update under the cap stays allowed');

    // Deleting frees exactly one slot.
    $del = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'page', 'id' => 'pqt-0', 'op' => 'delete', 'updatedAt' => $t + 30,
    ]]], $cookie);
    assertStatus($del, 200, 'delete one page');
    $freed = request('POST', '/api/sync/push', ['changes' => [[
        'type' => 'page', 'id' => 'pqt-new', 'op' => 'upsert',
        'data' => ['id' => 'pqt-new', 'title' => 'new'], 'updatedAt' => $t + 40,
    ]]], $cookie);
    assertStatus($freed, 200, 'new page accepted after a delete');
    assertSame($freed['body']['accepted'], 1, 'freed slot used');
});

/* ------------------------------ device cap ------------------------------ */

it('auth/open rejects brand-new devices beyond the per-space cap', function () {
    $r = request('POST', '/api/auth/create', [
        'code' => 'space_devcap', 'password' => 'devcap-password', 'device' => ['id' => 'dc-1'],
    ]);
    assertStatus($r, 200, 'create dev-cap space');
    $cookie = $r['cookie']['value'];

    foreach (['dc-2', 'dc-3'] as $did) {
        $o = request('POST', '/api/auth/open', [
            'code' => 'space_devcap', 'password' => 'devcap-password', 'device' => ['id' => $did],
        ]);
        assertStatus($o, 200, "open with device $did");
    }

    $over = request('POST', '/api/auth/open', [
        'code' => 'space_devcap', 'password' => 'devcap-password', 'device' => ['id' => 'dc-4'],
    ]);
    assertStatus($over, 409, '4th device rejected');
    assertSame($over['body']['error']['code'] ?? null, 'device_limit', 'device_limit code');

    // An already-registered device is never locked out.
    $again = request('POST', '/api/auth/open', [
        'code' => 'space_devcap', 'password' => 'devcap-password', 'device' => ['id' => 'dc-1'],
    ]);
    assertStatus($again, 200, 'existing device still opens');

    $st = request('POST', '/api/auth/status', [], $cookie);
    assertSame($st['body']['deviceCount'], 3, 'three devices registered');
    assertSame($st['body']['deviceLimit'], 3, 'device limit exposed');
});

it('events are pruned to the per-space cap, keeping the newest', function () {
    $r = request('POST', '/api/auth/create', [
        'code' => 'space_evcap', 'password' => 'evcap-password', 'device' => ['id' => 'de'],
    ]);
    assertStatus($r, 200, 'create event-cap space');
    $cookie = $r['cookie']['value'];

    $changes = [];
    for ($i = 0; $i < 6; $i++) {
        $changes[] = ['type' => 'event', 'id' => "evc-$i", 'op' => 'upsert',
            'data' => ['id' => "evc-$i"], 'updatedAt' => 1_800_600_000_000 + $i];
    }
    $p = request('POST', '/api/sync/push', ['changes' => $changes], $cookie);
    assertStatus($p, 200, 'push six events');
    assertSame($p['body']['accepted'], 6, 'all six accepted (then trimmed)');

    $evIds = [];
    foreach (pullAll($cookie) as $c) {
        if (($c['type'] ?? '') === 'event' && ($c['op'] ?? '') === 'upsert') $evIds[] = $c['id'];
    }
    assertSame($evIds, ['evc-2', 'evc-3', 'evc-4', 'evc-5'], 'newest 4 events survive the cap');

    // A fresh device only sees the kept window; devices that pulled before the
    // trim keep their local copies (trimming never touches a device's DB).
    $r2 = request('POST', '/api/auth/open', [
        'code' => 'space_evcap', 'password' => 'evcap-password', 'device' => ['id' => 'de-2'],
    ]);
    assertStatus($r2, 200, 'second device opens');
    $freshIds = [];
    foreach (pullAll($r2['cookie']['value']) as $c) {
        if (($c['type'] ?? '') === 'event' && ($c['op'] ?? '') === 'upsert') $freshIds[] = $c['id'];
    }
    assertSame($freshIds, ['evc-2', 'evc-3', 'evc-4', 'evc-5'], 'fresh device sees only kept events');
});

it('updatedAt far outside the accepted clock window is counted invalid', function () {
    $r = request('POST', '/api/auth/create', [
        'code' => 'space_clock', 'password' => 'clock-password', 'device' => ['id' => 'cl'],
    ]);
    assertStatus($r, 200, 'create clock-window space');
    $cookie = $r['cookie']['value'];

    $p = request('POST', '/api/sync/push', ['changes' => [
        ['type' => 'task', 'id' => 'clock-future', 'op' => 'upsert', 'data' => [], 'updatedAt' => 9_999_999_999_999_999],
        ['type' => 'task', 'id' => 'clock-past', 'op' => 'upsert', 'data' => [], 'updatedAt' => 1],
    ]], $cookie);
    assertStatus($p, 200, 'push returns ok');
    assertSame($p['body'], ['ok' => true, 'accepted' => 0, 'rejected' => 0, 'invalid' => 2], 'both invalid');

    // Neither ever reached the store.
    $all = pullAll($cookie);
    $ids = array_column($all, 'id');
    assertTrue(!in_array('clock-future', $ids, true) && !in_array('clock-past', $ids, true), 'not stored');
});

/* ------------------------------ rate limiting -------------------------- */

it('failed opens are rate limited per IP', function () {
    // Reset any failures recorded while exercising the auth endpoints above.
    global $dbPath;
    $boot = new PDO('sqlite:' . $dbPath);
    $boot->exec('DELETE FROM auth_failures');
    $boot = null;

    $payload = ['code' => 'space_a', 'password' => 'bad-password', 'device' => ['id' => 'bot']];
    $codes = [];
    for ($i = 0; $i < 4; $i++) {
        $r = request('POST', '/api/auth/open', $payload);
        $codes[] = $r['status'];
    }
    assertSame($codes, [401, 401, 401, 429], '3 fails then rate limited');

    // Even a correct password is blocked while over the limit.
    $ok = request('POST', '/api/auth/open', ['code' => 'space_a', 'password' => 'super-secret-pass', 'device' => ['id' => 'bot']]);
    assertStatus($ok, 429, 'still blocked after limit');

    // Clear the failures table directly to simulate window expiry.
    $pdo = new PDO('sqlite:' . $dbPath);
    $pdo->exec('DELETE FROM auth_failures');
    $pdo = null;
    $ok2 = request('POST', '/api/auth/open', ['code' => 'space_a', 'password' => 'super-secret-pass', 'device' => ['id' => 'bot']]);
    assertStatus($ok2, 200, 'open works again after window clears');
});

/* ------------------------------ logout / expiry ------------------------ */

it('logout invalidates the session', function () {
    global $cookieB;
    $r = request('POST', '/api/auth/logout', [], $cookieB);
    assertStatus($r, 200, 'logout ok');
    assertTrue($r['cookie']['value'] === '' || $r['cookie']['value'] === 'deleted', 'cookie cleared');
    $pull = request('POST', '/api/sync/pull', ['cursor' => 0], $cookieB);
    assertStatus($pull, 401, 'old cookie no longer valid');
});

it('expired sessions are rejected', function () {
    global $dbPath;
    // Manufacture an already-expired session directly.
    $db = new PDO('sqlite:' . $dbPath);
    $db->exec('INSERT INTO spaces (code, password_hash, created_at) VALUES ("exp_space", "x", 0)');
    $space = (int)$db->query('SELECT id FROM spaces WHERE code = "exp_space"')->fetchColumn();
    $db->prepare('INSERT INTO sessions (space_id, token_hash, created_at, expires_at) VALUES (?, ?, 0, 0)')
        ->execute([$space, hash('sha256', 'expired-token')]);
    $db = null;
    $r = request('POST', '/api/sync/pull', ['cursor' => 0], 'expired-token');
    assertStatus($r, 401, 'expired session rejected');
});

/* ------------------------------ runner --------------------------------- */

// The security suite registers its own tests here, so it lands in the same run
// and the same report as the functional one. It is required rather than
// inlined because it is a suite in its own right: every test in it boots a
// dedicated server with the limits it needs to be able to cross.
require __DIR__ . '/security.php';
require __DIR__ . '/share-intake.php';

foreach ($tests as [$name, $fn]) {
    try {
        $fn();
        $passed++;
        fwrite(STDOUT, "  ok    $name\n");
    } catch (Throwable $e) {
        $failed++;
        fwrite(STDOUT, "  FAIL  $name\n    " . str_replace("\n", "\n    ", $e->getMessage()) . "\n");
    }
}

fwrite(STDOUT, "\n$passed passed, $failed failed\n");
exit($failed === 0 ? 0 : 1);

function tt_pick_port(): int {
    $s = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if (!$s) {
        fwrite(STDERR, "no free port\n");
        exit(2);
    }
    $name = stream_socket_get_name($s, false);
    fclose($s);
    return (int)substr($name, strrpos($name, ':') + 1);
}