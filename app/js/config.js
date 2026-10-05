// The name the user sees: the window title, the manifest, the install prompt,
// the service-worker update notice, and the badge on the home screen.
//
// `DB_NAME` and the crypto key names below are NOT the product name and must
// never follow it. They are the identity of what is already on a person's
// device: renaming them orphans every existing IndexedDB, and makes the app
// unable to find the key that opens it — at which point it refuses to read
// anything. A product rename touches the line below and nothing else.
export const DB_NAME = "task-timer";
export const DB_VERSION = 10;
export const APP_NAME = "Tadkhir";
export const APP_VERSION = "1.3.0";
export const BACKUP_REMINDER_DAYS = 30;

export const SYNC_META_KEY = "sync";
export const SYNC_CONFIG_KEY = "syncConfig";
export const SYNC_PUSH_BATCH = 100;
export const SYNC_PULL_LOOP_MAX = 50;

export const SESSION_ROOTATION_MS = 24 * 60 * 60 * 1000;
export const SYNC_INTERVAL_MS = 30000;
export const EVENT_SYNC_DEBOUNCE_MS = 5000;

// How long one HTTP request to the sync API may hang before it is given up on.
//
// This is not a politeness setting, it is the thing that keeps sync ALIVE. A
// request that never settles — a captive portal that accepts the connection and
// answers nothing, a half-open TCP connection, a phone that walks out of range
// mid-request — leaves the sync run suspended forever, because the flag that
// keeps two runs from overlapping is only released in the `finally` of a call
// that never returns. Every later attempt then finds sync "busy" and does
// nothing, silently, until the tab is reloaded. The interval keeps firing and
// the app keeps showing "syncing" while nothing is being synced at all.
//
// 20s is well inside the server's own slow-path budget (it answers a push of
// 100 records in well under a second) and well above a slow connection, and the
// failure is mapped to the same `network` code a real network error produces —
// so the backoff that already exists takes over unchanged.
export const SYNC_REQUEST_TIMEOUT_MS = 20000;

export const CRYPTO_KEY_NAME = "task-timer-master-key";
export const ENCRYPTED_KEY_NAME = "task-timer-encrypted-key";
export const KEK_SALT_NAME = "task-timer-kek-salt";