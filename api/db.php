<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';

/**
 * SQLite backing store for sync + private spaces.
 *
 * The server mirrors client records and hosts the private-space authentication
 * layers. No domain logic lives here.
 *
 * records: one row per client record, scoped to a space.
 *          `rev` is a per-space monotonic sequence used as the pull cursor.
 * spaces:  one row per private sync space (code + hashed password).
 * sessions:server-side 24h sessions (cookie holds only the token's hash).
 * devices: registered devices per space (identity/telemetry only, not auth).
 * auth_failures: per-IP counter for failed-auth rate limiting.
 */

function task_timer_db(): PDO {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $cfg = task_timer_config();
    $dir = dirname($cfg['db_path']);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('database directory unavailable');
    }

    // Deny direct web access to the data directory on Apache deployments.
    $ht = $dir . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht, "Require all denied\n");
    }

    $pdo = new PDO('sqlite:' . $cfg['db_path'], null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    // The database holds every password hash and every record in the instance.
    // SQLite creates the file 0644 (the process umask), so on any deployment
    // that did not create the directory itself — which is every Docker one: the
    // Dockerfile and the named volume both make /app/api/var before PHP ever
    // runs, so the mkdir(0700) above is skipped — the file was left
    // world-readable inside the container. Observed: -rw-r--r-- 1 tt tt.
    //
    // Best-effort on purpose: a bind mount or a filesystem that does not honour
    // chmod must not stop the app from starting, and the container is the real
    // boundary either way. This makes the code do what the 0700 above already
    // says it does.
    if (is_file($cfg['db_path'])) {
        @chmod($cfg['db_path'], 0600);
    }
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA foreign_keys = ON');

    task_timer_schema($pdo);
    return $pdo;
}

function task_timer_schema(PDO $db): void {
    // Migrate the v1 schema (no space scoping) to the current one. A fresh DB
    // gets the new layout directly; an existing one is rebuilt in place. Legacy
    // rows are adopted by space id 1 (the first-created space owns them).
    $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
    if (in_array('records', $tables, true)) {
        $cols = $db->query('PRAGMA table_info(records)')->fetchAll();
        $hasSpace = in_array('space_id', array_column($cols, 'name'), true);
        if (!$hasSpace) {
            $db->beginTransaction();
            try {
                $db->exec(
                    'CREATE TABLE records_new (
                         space_id   INTEGER NOT NULL,
                         store      TEXT NOT NULL,
                         id         TEXT NOT NULL,
                         rev        INTEGER PRIMARY KEY AUTOINCREMENT,
                         deleted    INTEGER NOT NULL DEFAULT 0,
                         updated_at INTEGER NOT NULL,
                         data       TEXT,
                         UNIQUE (space_id, store, id)
                     )'
                );
                $db->exec(
                    'INSERT INTO records_new (space_id, store, id, rev, deleted, updated_at, data)
                     SELECT 1, store, id, rev, deleted, updated_at, data FROM records'
                );
                $db->exec('DROP TABLE records');
                $db->exec('ALTER TABLE records_new RENAME TO records');
                $db->commit();
            } catch (Throwable $e) {
                $db->rollBack();
                throw $e;
            }
        }
    }

    $db->exec(
        <<<'SQL'
CREATE TABLE IF NOT EXISTS records (
    space_id   INTEGER NOT NULL,
    store      TEXT NOT NULL,
    id         TEXT NOT NULL,
    rev        INTEGER PRIMARY KEY AUTOINCREMENT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    data       TEXT,
    UNIQUE (space_id, store, id)
);

CREATE TABLE IF NOT EXISTS spaces (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id   INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    space_id     INTEGER NOT NULL,
    device_id    TEXT NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, device_id)
);

CREATE TABLE IF NOT EXISTS auth_failures (
    ip           TEXT NOT NULL,
    scope        TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL,
    PRIMARY KEY (ip, scope)
);

CREATE INDEX IF NOT EXISTS idx_records_gc ON records (deleted, updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions (space_id, expires_at);
SQL
    );

    // auth_failures gained a `scope` column when auth/create got its own budget
    // (it is limited by attempts, not failures, because it hashes a password
    // whether or not the space exists). The counters are transient by design —
    // they expire with their window — so the old table is dropped rather than
    // migrated: every row in it is a stale counter that would otherwise keep
    // limiting an address for up to RATE_WINDOW seconds after the upgrade.
    // PRAGMA table_info returns (cid, name, type, ...); the name is the second
    // column, so it has to be read BY NAME. Fetching it positionally yields the
    // cid list, which never contains "scope", and this block would then drop and
    // recreate the table on every single request.
    $afCols = array_column($db->query('PRAGMA table_info(auth_failures)')->fetchAll(), 'name');
    if (in_array('scope', $afCols, true) === false) {
        $db->exec('DROP TABLE auth_failures');
        $db->exec(
            'CREATE TABLE auth_failures (
                ip           TEXT NOT NULL,
                scope        TEXT NOT NULL,
                count        INTEGER NOT NULL DEFAULT 0,
                window_start INTEGER NOT NULL,
                PRIMARY KEY (ip, scope)
            )'
        );
    }
}