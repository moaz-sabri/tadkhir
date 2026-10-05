<?php

declare(strict_types=1);

/**
 * Tombstone + stale-device garbage collector.
 *
 * `records` rows with deleted=1 are delete markers that must reach every
 * device through the pull cursor: pulling is `rev > cursor`, so a tombstone is
 * the only thing that tells an offline device that the record no longer
 * exists. Without pruning, tombstones grow forever (a space that deletes a lot
 * grows `records` without bound).
 *
 * `devices` rows that have not pushed/pulled for a long time (90 days by
 * default) are also pruned: every space has a hard device cap
 * (MAX_DEVICES_PER_SPACE), so dropping stale identities frees a slot for a
 * legitimately new device.
 *
 * This script physically deletes tombstones whose updated_at is older than a
 * grace period and devices whose last_seen_at is older than the device age.
 * The grace period must be far longer than any realistic device offline
 * window: sync runs every 30s with a backoff capped at 5 minutes, so the
 * default of 30 days leaves enormous headroom. A device offline for longer
 * than the grace period could re-push the deleted record (LWW) and resurrect
 * it — that is the documented tradeoff for unbounded growth.
 *
 * Usage:
 *   php api/gc.php                prune tombstones older than default grace (30d)
 *                                 and devices idle for default age (90d)
 *   php api/gc.php --dry-run      report only, delete nothing
 *   php api/gc.php --age 604800   use a 7-day tombstone grace period
 *   php api/gc.php --device-age 2592000   use a 30-day device idle cutoff
 *   TOMBSTONE_GC_AGE=604800 php api/gc.php   (env form)
 *   DEVICE_GC_AGE=2592000 php api/gc.php     (env form)
 *
 * Honors DATABASE_PATH exactly like the rest of the app. If you want the SQLite
 * file to shrink after a large delete, run `PRAGMA wal_checkpoint(TRUNCATE);`
 * then `VACUUM;` manually (it needs an exclusive lock and rebuilds the file).
 */

require_once __DIR__ . '/db.php';

$dryRun = false;
$age = null;
$deviceAge = null;

for ($i = 1, $n = count($argv); $i < $n; $i++) {
    switch ($argv[$i]) {
        case '--dry-run':
            $dryRun = true;
            break;
        case '--age':
            if (++$i >= $n || !ctype_digit((string)$argv[$i])) {
                fwrite(STDERR, "--age requires a positive number of seconds\n");
                exit(2);
            }
            $age = (int)$argv[$i];
            break;
        case '--device-age':
            if (++$i >= $n || !ctype_digit((string)$argv[$i])) {
                fwrite(STDERR, "--device-age requires a positive number of seconds\n");
                exit(2);
            }
            $deviceAge = (int)$argv[$i];
            break;
        case '--help':
        case '-h':
            echo "Usage: php api/gc.php [--dry-run] [--age SECONDS] [--device-age SECONDS]\n";
            echo "Prunes tombstone rows (deleted=1) older than TOMBSTONE_GC_AGE seconds\n";
            echo "and devices idle longer than DEVICE_GC_AGE seconds.\n";
            echo "Defaults: TOMBSTONE_GC_AGE=2592000 (30 days), DEVICE_GC_AGE=7776000 (90 days).\n";
            exit(0);
        default:
            fwrite(STDERR, "Unknown argument: {$argv[$i]}\n");
            exit(2);
    }
}

$age = max(60, $age ?? (int)(getenv('TOMBSTONE_GC_AGE') ?: 2592000));
$deviceAge = max(60, $deviceAge ?? (int)(getenv('DEVICE_GC_AGE') ?: 7776000));
$cutoff = time() - $age;
$deviceCutoff = time() - $deviceAge;

$db = task_timer_db();

$total = (int)$db->query('SELECT COUNT(*) FROM records WHERE deleted = 1')->fetchColumn();

$st = $db->prepare('SELECT COUNT(*) FROM records WHERE deleted = 1 AND updated_at < ?');
$st->execute([$cutoff]);
$target = (int)$st->fetchColumn();

$deleted = 0;
if (!$dryRun) {
    $db->beginTransaction();
    try {
        $st = $db->prepare('DELETE FROM records WHERE deleted = 1 AND updated_at < ?');
        $st->execute([$cutoff]);
        $deleted = $st->rowCount();
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }
}

$remaining = (int)$db->query('SELECT COUNT(*) FROM records WHERE deleted = 1')->fetchColumn();

if ($dryRun) {
    printf(
        "[dry-run] tombstones: %d old enough (%d total); would delete %d, %d would remain\n",
        $target,
        $total,
        $target,
        $total - $target
    );
} else {
    printf(
        "deleted %d tombstone(s) older than %d seconds; %d of %d remain\n",
        $deleted,
        $age,
        $remaining,
        $total
    );
}

$devTotal = (int)$db->query('SELECT COUNT(*) FROM devices')->fetchColumn();

$stDev = $db->prepare('SELECT COUNT(*) FROM devices WHERE last_seen_at < ?');
$stDev->execute([$deviceCutoff]);
$devTarget = (int)$stDev->fetchColumn();

$devDeleted = 0;
if (!$dryRun) {
    $db->beginTransaction();
    try {
        $stDev = $db->prepare('DELETE FROM devices WHERE last_seen_at < ?');
        $stDev->execute([$deviceCutoff]);
        $devDeleted = $stDev->rowCount();
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }
}

$devRemaining = (int)$db->query('SELECT COUNT(*) FROM devices')->fetchColumn();

if ($dryRun) {
    printf(
        "[dry-run] devices: %d idle long enough (%d total); would delete %d, %d would remain\n",
        $devTarget,
        $devTotal,
        $devTarget,
        $devTotal - $devTarget
    );
} else {
    printf(
        "deleted %d device(s) idle more than %d seconds; %d of %d remain\n",
        $devDeleted,
        $deviceAge,
        $devRemaining,
        $devTotal
    );
}

exit(0);