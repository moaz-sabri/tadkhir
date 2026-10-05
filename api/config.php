<?php

declare(strict_types=1);

/**
 * Central configuration.
 *
 * Precedence: environment variables, then config.local.php (gitignored).
 * Supported env vars:
 *   DATABASE_PATH       absolute or relative path to the SQLite file
 *   ALLOWED_ORIGIN      browser origin allowed via CORS (empty = same-origin only)
 *   ENVIRONMENT         development | production
 *   PULL_BATCH          max changes returned per pull request
 *   PUSH_BATCH          max changes accepted per push request
 *   REQUEST_MAX_BYTES   max request body size
 *   SHARE_MAX_BYTES     max bytes one Web Share Target upload may carry
 *   SHARE_MAX_FILES     max files one Web Share Target upload may carry
 *   SHARE_DIR           directory parked shares are held in (default api/var/share)
 *   RATE_WINDOW         failed-auth window length in seconds (default 15 min)
 *   RATE_MAX            failed-auth attempts allowed before rate limiting
 *   RATE_MAX_CREATE     auth/create attempts allowed per window per IP
 *   SESSION_LIFETIME    session lifetime in seconds (default 24h)
 *   COOKIE_SECURE       force Secure flag on the session cookie (auto by environment otherwise)
 *   PASSWORD_ALGO       argon2id | bcrypt (default: argon2id when the build supports it)
 *   PASSWORD_MAX_BYTES  longest accepted password (default 1024)
 *   HSTS_MAX_AGE        send Strict-Transport-Security with this max-age;
 *                       0 (the default) sends none, because the container serves
 *                       plain HTTP and a browser that caches the header would
 *                       refuse every later plain-HTTP request to this host
 *   MAX_SPACES                max spaces the instance will hold (default 10000)
 *   MAX_TASKS_PER_SPACE   max stored tasks per space (default 100)
 *   MAX_SESSIONS_PER_SPACE max stored session records per space (default 500)
 *   MAX_AUTH_SESSIONS_PER_SPACE max live auth sessions per space (default 32)
 *   MAX_FINANCE_RECORDS_PER_SPACE max stored records per finance store per
 *                          space (default 10000; the client caps each store
 *                          lower, this is the multi-device backstop)
 *   MAX_DEVICES_PER_SPACE max registered devices per space (default 8)
 *   MAX_EVENTS_PER_SPACE  max stored events per space; older ones are pruned (default 5000)
 *   MAX_UPDATED_AT_FUTURE_MS max accepted client-clock lead in ms (default 1 h)
 *   MAX_UPDATED_AT_AGE_MS max accepted client-clock lag in ms (default 366 days)
 */

/**
 * The password hashing algorithm actually in force.
 *
 * Resolved once, at runtime, from what the interpreter was built with rather
 * than from a constant: PASSWORD_ARGON2ID only exists when the build links
 * libargon2, and asking for it unconditionally is a fatal error, not a
 * fallback. Argon2id is preferred because it is memory-hard and has no input
 * length limit; bcrypt is the fallback and keeps its silent 72-byte
 * truncation, which is why PASSWORD_MAX_BYTES exists as well.
 */
function task_timer_password_algo(): string {
    static $algo = null;
    if ($algo !== null) {
        return $algo;
    }
    $wanted = (string)(getenv('PASSWORD_ALGO') ?: '');
    if ($wanted !== '' && $wanted !== 'auto') {
        $algo = in_array($wanted, password_algos(), true) ? $wanted : PASSWORD_DEFAULT;
    } else {
        $algo = in_array('argon2id', password_algos(), true) ? 'argon2id' : PASSWORD_DEFAULT;
    }
    return $algo;
}

function task_timer_config(): array {
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }

    $environment = (string)(getenv('ENVIRONMENT') ?: 'production');

    $secureEnv = (string)(getenv('COOKIE_SECURE') ?: '');
    $cookieSecure = $secureEnv === ''
        ? $environment === 'production'
        : filter_var($secureEnv, FILTER_VALIDATE_BOOL);

    $hsts = (int)(getenv('HSTS_MAX_AGE') ?: 0);

    $cfg = [
        'db_path'           => (string)(getenv('DATABASE_PATH')
            ?: __DIR__ . '/var/sync.sqlite'),
        'allowed_origin'    => (string)(getenv('ALLOWED_ORIGIN') ?: ''),
        'environment'       => $environment,
        'pull_batch'        => max(1, (int)(getenv('PULL_BATCH') ?: 200)),
        'push_batch'        => max(1, (int)(getenv('PUSH_BATCH') ?: 200)),
        'request_max_bytes' => max(1024, (int)(getenv('REQUEST_MAX_BYTES') ?: 1048576)),
        // The share intake's OWN ceiling, and it is a separate number from
        // request_max_bytes on purpose. That one bounds an unauthenticated JSON
        // push and is deliberately small; a shared clip is up to 5 MB by the
        // app's own rule and a phone's camera roll routinely offers 40 MB
        // photographs, so the intake is where a larger body is expected — and
        // the one place in the API that is reachable without a session, which is
        // why it gets an explicit budget rather than inheriting the general one.
        'share_intake_max_bytes' => max(1024, (int)(getenv('SHARE_MAX_BYTES') ?: 12582912)),
        'share_intake_max_files' => max(1, (int)(getenv('SHARE_MAX_FILES') ?: 6)),
        'rate_window'       => max(1, (int)(getenv('RATE_WINDOW') ?: 900)),
        'rate_max'          => max(1, (int)(getenv('RATE_MAX') ?: 10)),
        // auth/create is a separate budget from auth/open on purpose. `open` is
        // limited by FAILURES because its expensive part (the password hash) is
        // only reached when the code exists. `create` hashes unconditionally and
        // is unauthenticated, so it is limited by ATTEMPTS: without that, anyone
        // on the internet can spend ~17x the CPU of a normal request per call and
        // add a permanent row to `spaces` each time.
        'rate_max_create'   => max(1, (int)(getenv('RATE_MAX_CREATE') ?: 20)),
        'max_spaces'        => max(1, (int)(getenv('MAX_SPACES') ?: 10000)),
        'max_password_bytes' => max(64, (int)(getenv('PASSWORD_MAX_BYTES') ?: 1024)),
        'max_device_label_len' => max(1, (int)(getenv('MAX_DEVICE_LABEL_LEN') ?: 120)),
        'hsts_max_age'      => $hsts > 0 ? $hsts : 0,
        'max_tasks_per_space'    => max(1, (int)(getenv('MAX_TASKS_PER_SPACE') ?: 100)),
        'max_sessions_per_space' => max(1, (int)(getenv('MAX_SESSIONS_PER_SPACE') ?: 500)),
        // NOT the same knob as max_sessions_per_space, which caps stored
        // *session records* in the sync store. This one caps the *auth*
        // sessions a space can hold at once. They are separate budgets because
        // they bound separate things: one is the user's time-tracking history,
        // the other is how many browser cookies can mint access to the space.
        'max_auth_sessions_per_space' => max(1, (int)(getenv('MAX_AUTH_SESSIONS_PER_SPACE') ?: 32)),
        'max_finance_records_per_space' => max(1, (int)(getenv('MAX_FINANCE_RECORDS_PER_SPACE') ?: 10000)),
        'max_devices_per_space'  => max(1, (int)(getenv('MAX_DEVICES_PER_SPACE') ?: 8)),
        'max_events_per_space'   => max(1, (int)(getenv('MAX_EVENTS_PER_SPACE') ?: 5000)),
        'max_updated_at_future_ms' => max(1000, (int)(getenv('MAX_UPDATED_AT_FUTURE_MS') ?: 3600000)),
        'max_updated_at_age_ms'    => max(1000, (int)(getenv('MAX_UPDATED_AT_AGE_MS') ?: 31622400000)),
        'session_lifetime'  => max(60, (int)(getenv('SESSION_LIFETIME') ?: 86400)),
        'cookie_name'       => 'tt_session',
        'cookie_secure'     => $cookieSecure,
    ];

    $local = __DIR__ . '/config.local.php';
    if (is_file($local)) {
        $overrides = (array)require $local;
        $cfg = array_replace($cfg, $overrides);
    }

    return $cfg;
}
