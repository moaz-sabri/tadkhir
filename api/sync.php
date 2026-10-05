<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';

/**
 * Sync handlers. Pure data transport, scoped to a private space:
 * apply changes (last-write-wins) and serve changes after a cursor.
 * No domain/business validation happens here.
 */

/**
 * Record types the generic protocol accepts. Finance, Later and Pages are just
 * more record types over the same push/pull transport — there is no finance
 * endpoint, no later endpoint, no pages endpoint, and no feature-specific
 * server logic. Routines are the same, and in particular a routine's run is not a
 * new record type either: it is an ordinary session, carrying the id of the rule
 * it was started from.
 */
const TASK_TIMER_STORES = [
    'task', 'session', 'event', 'meta',
    'transaction', 'recurring', 'debt', 'debtPayment',
    'category', 'person',
    'later',
    'page', 'pageItem',
    'kanbanItem',
    'routine', 'routineLog',
];

/**
 * A device that actually pushes / pulls is alive right now — bump
 * last_seen_at (telemetry only — never used for authentication).
 */
function task_timer_touch_device(int $spaceId, array $payload): void {
    $deviceId = is_array($payload['device'] ?? null) ? (string)($payload['device']['id'] ?? '') : '';
    if ($deviceId === '' || strlen($deviceId) > 128) {
        return;
    }
    task_timer_db()->prepare(
        'UPDATE devices SET last_seen_at = ? WHERE space_id = ? AND device_id = ?'
    )->execute([time(), $spaceId, $deviceId]);
}

function task_timer_push(int $spaceId, array $payload): array {
    task_timer_touch_device($spaceId, $payload);
    $db = task_timer_db();
    $changes = $payload['changes'] ?? [];
    if (!is_array($changes)) {
        $changes = [];
    }
    $cfg = task_timer_config();
    $batch = $cfg['push_batch'];
    $invalid = count($changes) > $batch ? count($changes) - $batch : 0;
    $changes = array_slice($changes, 0, $batch);

    $nowMs = time() * 1000;

    $valid = [];
    foreach ($changes as $c) {
        if (!is_array($c)) {
            $invalid++;
            continue;
        }
        $type = $c['type'] ?? null;
        $op   = $c['op'] ?? null;
        $id   = $c['id'] ?? null;
        $at   = $c['updatedAt'] ?? null;
        $data = $c['data'] ?? null;

        if (!in_array($type, TASK_TIMER_STORES, true)) { $invalid++; continue; }
        if ($op !== 'upsert' && $op !== 'delete')     { $invalid++; continue; }
        if (!is_string($id) || $id === '' || strlen($id) > 256) { $invalid++; continue; }
        // updatedAt window: a client whose clock is way off (more than
        // max_updated_at_future_ms ahead or max_updated_at_age_ms behind the
        // server) would corrupt last-write-wins ordering. Such changes are
        // counted invalid — never stored — so they stay in the client outbox
        // and keep retrying, surfacing the clock problem without corrupting
        // the ordering of legitimate changes.
        if (!is_int($at) || $at <= 0
            || $at > $nowMs + (int)$cfg['max_updated_at_future_ms']
            || $at < $nowMs - (int)$cfg['max_updated_at_age_ms']) {
            $invalid++;
            continue;
        }
        if ($op === 'upsert') {
            if (!is_array($data))                     { $invalid++; continue; }
            $data = (array)$data;
        } else {
            $data = null;
        }

        $valid[] = ['type' => $type, 'id' => $id, 'op' => $op, 'at' => $at, 'data' => $data];
    }

    $accepted = 0;
    $rejected = 0;

    // Per-space quotas: adding a brand-new record to a store that has already
    // hit its cap is rejected wholesale (409). The client enforces the same
    // limits locally; this is the backstop for multi-device spaces. Deleting
    // records is the only way to free a slot.
    //
    // Every non-core store shares ONE cap rather than a knob each. The client
    // caps each of them far lower and more precisely (domain/validation.js);
    // this exists only to stop one device filling a space for everyone, and a
    // per-store env var for each of them would be a setting nobody tunes.
    $sharedCap = (int)$cfg['max_finance_records_per_space'];
    $limits = [
        'task'    => (int)$cfg['max_tasks_per_space'],
        'session' => (int)$cfg['max_sessions_per_space'],
    ];
    foreach (['transaction', 'recurring', 'debt', 'debtPayment', 'category', 'person', 'later', 'page', 'pageItem', 'routine', 'routineLog'] as $sharedStore) {
        $limits[$sharedStore] = $sharedCap;
    }

    if ($valid !== []) {
        $db->beginTransaction();
        try {
            $stSel = $db->prepare('SELECT updated_at, deleted FROM records WHERE space_id = ? AND store = ? AND id = ?');
            $stDel = $db->prepare('DELETE FROM records WHERE space_id = ? AND store = ? AND id = ?');
            $stIns = $db->prepare(
                'INSERT INTO records (space_id, store, id, deleted, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)'
            );
            $stCount = $db->prepare('SELECT COUNT(*) FROM records WHERE space_id = ? AND store = ? AND deleted = 0');

            $pendingNew = array_fill_keys(array_keys($limits), 0);
            $counted = [];

            foreach ($valid as $c) {
                $stSel->execute([$spaceId, $c['type'], $c['id']]);
                $old = $stSel->fetch();

                // Last-write-wins: a strictly newer stored version wins.
                if ($old !== false && (int)$old['updated_at'] > $c['at']) {
                    $rejected++;
                    continue;
                }

                if ($c['op'] === 'upsert' && isset($limits[$c['type']])) {
                    $isNew = $old === false || (int)$old['deleted'] === 1;
                    if ($isNew) {
                        if (!isset($counted[$c['type']])) {
                            $stCount->execute([$spaceId, $c['type']]);
                            $counted[$c['type']] = (int)$stCount->fetchColumn();
                        }
                        $pendingNew[$c['type']]++;
                        if ($counted[$c['type']] + $pendingNew[$c['type']] > $limits[$c['type']]) {
                            $db->rollBack();
                            tt_error(409, 'limit_reached');
                        }
                    }
                }

                // Re-insert (delete + insert) so the row gets a fresh rev via
                // AUTOINCREMENT; this keeps the pull cursor monotonic.
                $stDel->execute([$spaceId, $c['type'], $c['id']]);
                $stIns->execute([
                    $spaceId,
                    $c['type'],
                    $c['id'],
                    $c['op'] === 'delete' ? 1 : 0,
                    $c['at'],
                    $c['data'] === null ? null : json_encode($c['data']),
                ]);
                $accepted++;
            }

            // Events are an append-only log that nothing references: an old
            // event is never needed to interpret a task or session. Cap the
            // rows per space and drop the oldest in the same push, so the
            // server copy (and later pulls for freshly added devices) stays
            // bounded.
            $eventCap = (int)$cfg['max_events_per_space'];
            if ($eventCap > 0) {
                $stEvCount = $db->prepare(
                    'SELECT COUNT(*) FROM records WHERE space_id = ? AND store = ? AND deleted = 0'
                );
                $stEvCount->execute([$spaceId, 'event']);
                $events = (int)$stEvCount->fetchColumn();
                if ($events > $eventCap) {
                    $stEvPrune = $db->prepare(
                        'DELETE FROM records WHERE space_id = ? AND store = ? AND deleted = 0 AND rev IN (
                             SELECT rev FROM records WHERE space_id = ? AND store = ? AND deleted = 0
                             ORDER BY rev ASC LIMIT ?
                         )'
                    );
                    $stEvPrune->execute([$spaceId, 'event', $spaceId, 'event', $events - $eventCap]);
                }
            }

            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            throw $e;
        }
    }

    return ['ok' => true, 'accepted' => $accepted, 'rejected' => $rejected, 'invalid' => $invalid];
}

function task_timer_pull(int $spaceId, array $payload): array {
    task_timer_touch_device($spaceId, $payload);
    $db = task_timer_db();
    $cursor = (isset($payload['cursor']) && is_int($payload['cursor']))
        ? max(0, $payload['cursor'])
        : 0;
    $batch = task_timer_config()['pull_batch'];

    $stMax = $db->prepare('SELECT COALESCE(MAX(rev), 0) FROM records WHERE space_id = ?');
    $stMax->execute([$spaceId]);
    $max = (int)$stMax->fetchColumn();

    $st = $db->prepare(
        'SELECT store, id, deleted, updated_at, data, rev
           FROM records
          WHERE space_id = ? AND rev > ?
          ORDER BY rev ASC
          LIMIT ?'
    );
    $st->execute([$spaceId, $cursor, $batch]);
    $rows = $st->fetchAll();

    $changes = [];
    foreach ($rows as $r) {
        $decoded = $r['data'] !== null ? json_decode($r['data'], true) : null;
        $changes[] = [
            'type'      => $r['store'],
            'id'        => $r['id'],
            'op'        => $r['deleted'] ? 'delete' : 'upsert',
            'data'      => $decoded,
            'updatedAt' => (int)$r['updated_at'],
            'rev'       => (int)$r['rev'],
        ];
    }

    $full = count($rows) === $batch;
    $nextCursor = $full && $rows !== []
        ? (int)$rows[count($rows) - 1]['rev']
        : $max;

    return [
        'ok'         => true,
        'changes'    => $changes,
        'nextCursor' => $nextCursor,
        'more'       => $full,
    ];
}