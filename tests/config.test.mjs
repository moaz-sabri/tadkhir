import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    DB_NAME,
    DB_VERSION,
    APP_VERSION,
    BACKUP_REMINDER_DAYS,
    SYNC_META_KEY,
    SYNC_CONFIG_KEY,
    SYNC_PUSH_BATCH,
    SYNC_PULL_LOOP_MAX,
    SESSION_ROOTATION_MS,
    SYNC_INTERVAL_MS,
    EVENT_SYNC_DEBOUNCE_MS,
    SYNC_REQUEST_TIMEOUT_MS,
    CRYPTO_KEY_NAME,
    ENCRYPTED_KEY_NAME,
    KEK_SALT_NAME,
} from "../app/js/config.js";

test("client config constants stay stable", () => {
    assert.equal(DB_NAME, "task-timer");
    // A data migration, not a release number: 10 is Routines (the rules and the
    // days a counter recorded). It moves only when a store is added or changed
    // (see data/migrations.js).
    assert.equal(DB_VERSION, 10);
    // Semantic version string; bump on every sealed release (see PLAYBOOK section 7).
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(APP_VERSION, "1.3.0");
    assert.equal(BACKUP_REMINDER_DAYS, 30);

    assert.equal(SYNC_META_KEY, "sync");
    assert.equal(SYNC_CONFIG_KEY, "syncConfig");
    assert.equal(SYNC_PUSH_BATCH, 100);
    assert.equal(SYNC_PULL_LOOP_MAX, 50);

    assert.equal(SESSION_ROOTATION_MS, 24 * 60 * 60 * 1000);
    assert.equal(SYNC_INTERVAL_MS, 30_000);
    assert.equal(EVENT_SYNC_DEBOUNCE_MS, 5_000);
    // Long enough for a slow connection to answer a push of 100 records, short
    // enough that a hung request cannot suspend sync for the rest of the session.
    assert.equal(SYNC_REQUEST_TIMEOUT_MS, 20_000);

    assert.equal(CRYPTO_KEY_NAME, "task-timer-master-key");
    assert.equal(ENCRYPTED_KEY_NAME, "task-timer-encrypted-key");
    assert.equal(KEK_SALT_NAME, "task-timer-kek-salt");
});

test("the client has no runtime dependencies, and that is a decision not an accident", () => {
    // This app is served network-first to a device that may be offline for a
    // week, as ONE bundle. A runtime dependency does not fail — it makes the
    // bundle a package manager's output instead of this project's, and the cost
    // is paid on the worst possible connection by the user who can least afford
    // it. A rich-text editor is the exact change that would test this rule: the
    // usual answer is a WYSIWYG library, which is 30-80 KB before compression,
    // and the answer taken here was a parser of 200 lines that stores plain text
    // (app/js/domain/rich-text.js — the comment at its head says why).
    //
    // So the rule is a test. If a dependency ever becomes genuinely necessary,
    // the fix is to delete this assertion with a reason, not to add a library.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    assert.deepEqual(
        pkg.dependencies ?? {},
        {},
        "no runtime dependencies — see the note on this test"
    );

    // …and the build-time ones must stay build-time: webpack pulling a CSS
    // loader in is invisible to the browser, but anything imported by app/js and
    // bundled is not, so a `dependencies` entry is the thing this catches.
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) {
        assert.match(range, /^\^?\d/, `${name} is a build tool, not shipped code`);
    }
});

test("APP_VERSION stays in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    assert.equal(pkg.version, APP_VERSION);
});

test("the service worker cache name carries APP_VERSION", () => {
    // The cache name is what makes a release invalidate the previous release's
    // cached bundle. With a fixed name the activate handler can never clear
    // anything, so a browser keeps serving the bundle it first installed and a
    // rebuilt fix looks like it did nothing. Bumping the version here forces a
    // new cache and deletes the old one.
    const sw = readFileSync(fileURLToPath(new URL("../app/sw.js", import.meta.url)), "utf8");
    const name = sw.match(/const CACHE = "([^"]+)"/)?.[1];
    assert.ok(name, "sw.js must declare CACHE");
    assert.equal(
        name,
        `task-timer-v${APP_VERSION}`,
        "update the CACHE name in app/sw.js whenever APP_VERSION changes"
    );
});