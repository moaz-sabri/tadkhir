<?php

declare(strict_types=1);

/**
 * Standalone proof of the ON CONFLICT rate-limit window update (mirrors the
 * exact SQL in task_timer_rate_fail). Verifies:
 *   1. within-window failures accumulate (count++)
 *   2. window expiry resets count to 1 and slides window_start
 *   3. after reset, further failures count from 1 again (fresh window)
 */

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE auth_failures (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL)');

$rate_window = 900; // 15 min
$now = 1_700_000_000;

function fail_once(PDO $db, string $ip, int $rateWindow, &$now): int {
    // Bind the numeric parameters as integers on purpose: PDO binds plain
    // execute() arrays as strings, and in SQLite an INTEGER never compares
    // greater than TEXT, so the expiry reset would never fire. This mirrors
    // tt_rate_fail in api/auth.php exactly.
    $st = $db->prepare(
        'INSERT INTO auth_failures (ip, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT(ip) DO UPDATE SET
            count = CASE WHEN ? - window_start > ? THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN ? - window_start > ? THEN ? ELSE window_start END'
    );
    $st->bindValue(1, $ip, PDO::PARAM_STR);
    $st->bindValue(2, $now, PDO::PARAM_INT);
    $st->bindValue(3, $now, PDO::PARAM_INT);
    $st->bindValue(4, $rateWindow, PDO::PARAM_INT);
    $st->bindValue(5, $now, PDO::PARAM_INT);
    $st->bindValue(6, $rateWindow, PDO::PARAM_INT);
    $st->bindValue(7, $now, PDO::PARAM_INT);
    $st->execute();
    return (int)$db->query("SELECT count FROM auth_failures WHERE ip = '$ip'")->fetchColumn();
}

// 2 failures within the window -> count 2
$now = 1_700_000_000;
assertCount(fail_once($db, '1.2.3.4', $rate_window, $now), 1, 'first fail count=1');
assertCount(fail_once($db, '1.2.3.4', $rate_window, $now), 2, 'same-window count=2');

// Window expires (nothing happened for 16 min) -> next failure RESETS to 1
$now = 1_700_000_000 + 960; // +16 min > 15 min window
assertCount(fail_once($db, '1.2.3.4', $rate_window, $now), 1, 'expired window resets to 1');
assertCount(fail_once($db, '1.2.3.4', $rate_window, $now), 2, 'fresh window counts again');

// And window_start actually slid forward (sanity)
$ws = (int)$db->query("SELECT window_start FROM auth_failures WHERE ip = '1.2.3.4'")->fetchColumn();
assertTrue($ws === $now, 'window_start slid to latest failure');

echo "all rate-limit window cases pass\n";

function assertCount(int $got, int $want, string $m): void {
    if ($got !== $want) { fwrite(STDERR, "FAIL $m: got $got want $want\n"); exit(1); }
}
function assertTrue(bool $c, string $m): void {
    if (!$c) { fwrite(STDERR, "FAIL $m\n"); exit(1); }
}
