// The sync, crypto and backup paths, exercised for real.
//
// These are the tests that the browser-only manual pass could not leave behind:
// the key/owner binding order, the DataError a malformed record used to cause,
// the outbox entries that could never be delivered, and a session rotation
// that reported success on a 401. Every one of them was found by driving two
// browsers against a live server; this file pins them so they stay fixed.
//
// The data layer runs on the in-memory IndexedDB stub (tests/helpers/
// fake-indexeddb.mjs) and the crypto layer on Node's own WebCrypto, so the
// production modules run unmodified â€” including the 600k-iteration PBKDF2,
// which is why these tests are not instant.

import test from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.mjs";

const idb = installFakeIndexedDB();

const { metaRepo } = await import("../app/js/data/meta.repo.js");
const { tasksRepo } = await import("../app/js/data/tasks.repo.js");
const { withTx, req } = await import("../app/js/data/db.js");
const cryptoService = await import("../app/js/services/crypto-service.js");
const { authService } = await import("../app/js/services/auth-service.js");
const { syncService } = await import("../app/js/services/sync-service.js");
const { backupService } = await import("../app/js/services/backup-service.js");

const PASSWORD = "test-password-1234";
const OWNER = "owner-secret-1234";
const OTHER_OWNER = "someone-else-9999";

// Every fetch is answered here. The tests care about what the client does with
// the answer, not about the server's behaviour, which api/tests/run.php covers
// directly â€” except where a specific status code IS the thing under test.
let routes = [];
let calls = [];
globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^\/api\//, "");
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, body });
    const route = routes.find(r => r.path === path);
    if (!route) return json(404, { ok: false, error: { code: "not_found" } });
    return typeof route.reply === "function"
        ? route.reply(body, calls.length)
        : route.reply;
};

const json = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
});

const ok = payload => json(200, { ok: true, ...payload });

// A server that accepts everything, which is what most of these tests want.
const happyServer = () => {
    routes = [
        { path: "auth/create", reply: ok({ spaceId: 1 }) },
        { path: "auth/open", reply: ok({ spaceId: 1 }) },
        { path: "auth/rotate", reply: ok({ expiresAt: 1 }) },
        { path: "auth/logout", reply: ok({}) },
        { path: "sync/push", reply: ok({ accepted: 0, rejected: 0, invalid: 0 }) },
        { path: "sync/pull", reply: ok({ changes: [], nextCursor: 0, more: false }) }
    ];
    calls = [];
};

test.beforeEach(async () => {
    idb.wipe();
    await authService.logout();
    happyServer();
});

// The sync loop is a setInterval that lives in module state. Nothing in a test
// waits for it, and a still-armed timer keeps the runner alive after the last
// test, so it is torn down here rather than left to time out.
test.afterEach(async () => {
    await syncService.logout();
});

/* -------------------------------------------------------------------------- */
/* metaRepo.delete â€” the crash that made every key wipe fail                   */
/* -------------------------------------------------------------------------- */

// cryptoService.clearEncryptionKeys() called metaRepo.delete, which did not
// exist. It threw a TypeError on every call, from inside catch blocks and from
// the Settings cross-space flow â€” so a failed space creation reported "space
// already exists" as a bare crash, and replacing a device's space wiped the
// config and then died before it could open the new one.
test("metaRepo can delete a single key, which is what clearEncryptionKeys needs", async () => {
    await withTx(["meta"], "readwrite", async r => {
        const mr = metaRepo(r.meta);
        await mr.set("keep", 1);
        await mr.set("drop", 2);
        await mr.delete("drop");
    });
    const store = await withTx(["meta"], "readonly", r => req(r.meta.getAll()));
    assert.deepEqual(store, [{ key: "keep", value: 1 }]);
});

test("clearEncryptionKeys removes the key and the salt, and leaves the owner alone", async () => {
    const created = await authService.createSpace({ code: "space-x", password: PASSWORD });
    assert.ok(created.ok);
    await cryptoService.storeKEKSalt("salt-value");
    await authService.storeOwnerVerifier(await cryptoService.createOwnerVerifier(OWNER));

    await cryptoService.clearEncryptionKeys();

    assert.equal(await cryptoService.getEncryptedKey(), null);
    assert.equal(await cryptoService.getKEKSalt(), null);
    // The owner binding is a separate decision and must survive: a key wipe is
    // not a "become a different account" operation.
    assert.ok(await authService.getOwnerVerifier());
    assert.equal(await cryptoService.hasEncryptionKeys(), false);
});

/* -------------------------------------------------------------------------- */
/* A failed import must not take the device over                              */
/* -------------------------------------------------------------------------- */

// The owner verifier was persisted as soon as the owner code matched, which
// happened BEFORE the password was ever checked. A fresh device that imported
// a file with the right owner code and a mistyped password was left permanently
// bound to that owner: it could never set its own owner code again, and every
// other owner's file was refused. There was no way out but clearing storage.
test("a sync-file import with a wrong password does not bind the device's owner", async () => {
    const file = await buildSyncFile();
    await virgin();
    assert.equal(await authService.getOwnerVerifier(), null);

    const res = await syncService.importSyncFile(file, { password: "wrong-password", ownerCode: OWNER });

    assert.equal(res.ok, false);
    assert.equal(res.code, "decryption_failed");
    assert.equal(await authService.getOwnerVerifier(), null, "owner must not be bound by a failed import");
    assert.equal(await cryptoService.hasEncryptionKeys(), false);

    // And the device is still free to become its own owner.
    const own = await authService.resolveOwner("my-own-code-0000");
    assert.equal(own.ok, true);
});

test("a sync-file import binds the owner only once the key actually opened", async () => {
    const file = await buildSyncFile();
    const res = await syncService.importSyncFile(file, { password: PASSWORD, ownerCode: OWNER });
    assert.equal(res.ok, true);
    assert.equal(res.merged, true);
    assert.ok(await authService.getOwnerVerifier());
    assert.equal(await cryptoService.hasEncryptionKeys(), true);
});

test("a sync-file import with a wrong owner still changes nothing", async () => {
    const file = await buildSyncFile();
    await virgin();

    const res = await syncService.importSyncFile(file, { password: PASSWORD, ownerCode: OTHER_OWNER });

    assert.equal(res.code, "owner_mismatch");
    assert.equal(await authService.getOwnerVerifier(), null);
    assert.equal(await cryptoService.hasEncryptionKeys(), false);
});

// The same ordering bug in the backup path, one step further along: a corrupt
// payload still decrypted the master key, so the device adopted the file's key
// AND its owner before decryptData() rejected the ciphertext. The owner of the
// account could then never restore their own backup.
test("a backup whose payload is corrupt does not bind the device's key or owner", async () => {
    const file = await buildBackup();
    await virgin();
    const tampered = corrupt(file, "d");

    await assert.rejects(
        () => backupService.parse(tampered, PASSWORD, { getOwnerCode: async () => OWNER }),
        (e) => e.code === "decryption_failed"
    );

    assert.equal(await cryptoService.hasEncryptionKeys(), false, "key must not be bound");
    assert.equal(await authService.getOwnerVerifier(), null, "owner must not be bound");
    // The device is still able to become its own owner.
    assert.equal((await authService.resolveOwner("my-own-code-0000")).ok, true);
});

test("a wrong password on a backup never reaches the owner check", async () => {
    const file = await buildBackup();
    let ownerAsked = false;
    await assert.rejects(
        () => backupService.parse(file, "wrong-password", { getOwnerCode: async () => { ownerAsked = true; return OWNER; } }),
        (e) => e.code === "no_encrypted_key" || e.code === "invalid_credentials"
    );
    assert.equal(ownerAsked, false);
});

/* -------------------------------------------------------------------------- */
/* The cross-space prompt must not be asked before the file is known good      */
/* -------------------------------------------------------------------------- */

// Answering this prompt wipes the device's sync setup, and it used to be
// answered before the password had been tried, so a mistyped password left the
// device configured for nothing.
test("a cross-space import with a wrong password is refused before the prompt", async () => {
    // Both files are built first: building one stores its key on this device,
    // so building the second after the device was set up would quietly replace
    // the very key the test is about.
    const first = await buildSyncFile({ code: "space-unit-1" });
    const other = await buildSyncFile({ code: "space-other-9" });
    await virgin();
    assert.equal((await syncService.importSyncFile(first, { password: PASSWORD, ownerCode: OWNER })).ok, true);
    const boundTo = (await syncService.getConfig()).code;

    // A different space, opened with the right owner but the wrong password.
    const res = await syncService.importSyncFile(other, { password: "wrong-password", ownerCode: OWNER });

    assert.equal(res.ok, false);
    assert.equal(res.code, "decryption_failed");
    assert.equal(res.requiresAction, undefined, "must not ask for a destructive change it cannot perform");
    assert.equal((await syncService.getConfig()).code, boundTo, "the device stays on its own space");
});

test("a cross-space import with the right password still asks, and says which is which", async () => {
    const first = await buildSyncFile({ code: "space-unit-1" });
    const other = await buildSyncFile({ code: "space-other-9" });
    await virgin();
    assert.equal((await syncService.importSyncFile(first, { password: PASSWORD, ownerCode: OWNER })).ok, true);
    const boundTo = (await syncService.getConfig()).code;

    const res = await syncService.importSyncFile(other, { password: PASSWORD, ownerCode: OWNER });

    assert.equal(res.ok, true);
    assert.equal(res.requiresAction, "cross_space");
    assert.equal(res.currentCode, boundTo);
    assert.equal(res.fileCode, "space-other-9");
});

/* -------------------------------------------------------------------------- */
/* Legacy backups must import                                                  */
/* -------------------------------------------------------------------------- */

// normalizeFinance defaulted financeCategories to BUILTIN_FINANCE_CATEGORIES â€”
// an array of STRINGS â€” while assertImportShape defaulted the same field to
// `{ id }` objects. importAll writes each entry into a store keyed on `id`, so
// `{ ...'home' }` has no id and the put threw a DataError that aborted the
// whole restore. Every backup without a financeCategories key hit it, which is
// every backup written before categories existed: exactly the case the code
// says it supports.
test("a backup with no financeCategories key restores instead of dying on a DataError", async () => {
    const raw = { app: "task-timer", version: 1, exportedAt: new Date().toISOString(), tasks: [], sessions: [], events: [], settings: { language: "en" } };
    const parsed = await backupService.parse(await sealBackup(raw), PASSWORD, { getOwnerCode: async () => OWNER });
    await assert.doesNotReject(() => backupService.importAll(parsed.data));

    const categories = await withTx(["categories"], "readonly", r => req(r.categories.getAll()));
    assert.equal(categories.length, 7, "the seven built-in categories are seeded");
    for (const c of categories) {
        assert.equal(typeof c.id, "string");
        assert.ok(c.id.length > 0, "every category has a keyPath value");
    }
});

test("a backup with finance records but no categories key restores too", async () => {
    const at = Date.now();
    const raw = {
        app: "task-timer", version: 1, exportedAt: new Date().toISOString(),
        tasks: [], sessions: [], events: [], settings: {},
        financeTransactions: [{ id: "tx1", type: "expense", title: "x", amount: 100, currency: "EUR", category: "food", occurredAt: at, note: null, recurringId: null, createdAt: at, updatedAt: at }]
    };
    const parsed = await backupService.parse(await sealBackup(raw), PASSWORD, { getOwnerCode: async () => OWNER });
    await assert.doesNotReject(() => backupService.importAll(parsed.data));

    const stored = await withTx(["transactions", "categories"], "readonly", r => req(r.transactions.getAll()));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, "x");
});

test("a categories array of bare strings is still refused as a malformed backup", async () => {
    const raw = { app: "task-timer", version: 1, exportedAt: new Date().toISOString(), tasks: [], sessions: [], events: [], settings: {}, financeCategories: ["home"] };
    const text = await sealBackup(raw);
    await assert.rejects(
        () => backupService.parse(text, PASSWORD, { getOwnerCode: async () => OWNER }),
        (e) => e.code === "invalid_schema"
    );
});

/* -------------------------------------------------------------------------- */
/* A malformed task must not take the restore down with it                     */
/* -------------------------------------------------------------------------- */

// assertImportShape checked sessions, finance and later, and never tasks. A
// backup could carry a task with no id at all, and the put then threw a
// DataError from IndexedDB â€” aborting the whole import, so one bad record cost
// the user every good one.
test("a task with no id is refused by the gate, with a code the UI can translate", async () => {
    const raw = { app: "task-timer", version: 1, exportedAt: new Date().toISOString(), tasks: [{ title: "no id", estimatedMs: 60000 }], sessions: [], events: [], settings: {} };
    const text = await sealBackup(raw);
    await assert.rejects(
        () => backupService.parse(text, PASSWORD, { getOwnerCode: async () => OWNER }),
        (e) => e.code === "invalid_schema"
    );
});

test("a task with an impossible estimate, a huge title or a broken subtasks is refused", async () => {
    const base = { app: "task-timer", version: 1, exportedAt: new Date().toISOString(), sessions: [], events: [], settings: {} };
    const bad = [
        { id: "t", title: "ok", estimatedMs: -1 },
        { id: "t", title: "ok", estimatedMs: 999999999999 },
        { id: "t", title: "x".repeat(5000), estimatedMs: 60000 },
        { id: "t", title: "   ", estimatedMs: 60000 },
        { id: "t", title: "ok", estimatedMs: 60000, subtasks: "not-an-array" },
        { id: "t", title: "ok", estimatedMs: 60000, subtasks: [{ title: "no id" }] },
        { id: "t", title: "ok", estimatedMs: 60000, note: "y".repeat(9000) },
        { id: "t", title: "ok", estimatedMs: 60000, plannedAt: "soon" }
    ];
    for (const task of bad) {
        const text = await sealBackup({ ...base, tasks: [task] });
        await assert.rejects(
            () => backupService.parse(text, PASSWORD, { getOwnerCode: async () => OWNER }),
            (e) => e.code === "invalid_schema",
            `expected ${JSON.stringify(task).slice(0, 80)} to be refused`
        );
    }
});

test("a well-formed task round-trips through a backup untouched", async () => {
    const task = {
        id: "t1", title: "Fine", estimatedMs: 60000, note: "n", plannedAt: null,
        subtasks: [{ id: "s1", title: "step" }], pinned: false, archived: false,
        usageCount: 0, lastUsedAt: null, createdAt: 1, updatedAt: 2
    };
    const raw = { app: "task-timer", version: 1, exportedAt: new Date().toISOString(), tasks: [task], sessions: [], events: [], settings: {} };
    const parsed = await backupService.parse(await sealBackup(raw), PASSWORD, { getOwnerCode: async () => OWNER });
    await backupService.importAll(parsed.data);
    const stored = await withTx(["tasks"], "readonly", r => req(r.tasks.getAll()));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, "Fine");
    assert.deepEqual(stored[0].subtasks, [{ id: "s1", title: "step" }]);
});

/* -------------------------------------------------------------------------- */
/* A session rotation that fails must say so                                   */
/* -------------------------------------------------------------------------- */

// auth-service's fetchJson answered {ok:false, code:"network"} for every
// failure â€” a 401 from an expired session included â€” and rotateSession
// returned ok:true regardless. So a dead session was indistinguishable from a
// fresh one: the rotation timer re-armed itself for another day, and the status
// was painted "idle" over it.
test("rotateSession reports failure when the server rejects the session", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    routes = [{ path: "auth/rotate", reply: json(401, { ok: false, error: { code: "unauthorized" } }) }];

    const res = await authService.rotateSession("space-x", "dev-1");

    assert.equal(res.ok, false);
    assert.equal(res.code, "unauthorized");
});

test("rotateSession reports the server's own code, not a blanket 'network'", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    routes = [{ path: "auth/rotate", reply: json(429, { ok: false, error: { code: "rate_limited" } }) }];
    assert.equal((await authService.rotateSession("space-x", "dev-1")).code, "rate_limited");

    routes = [{ path: "auth/rotate", reply: json(500, { ok: false, error: { code: "server_error" } }) }];
    assert.equal((await authService.rotateSession("space-x", "dev-1")).code, "server_error");
});

test("a failed rotation marks the sync status unauthorized instead of idle", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    routes = [{ path: "auth/rotate", reply: json(401, { ok: false, error: { code: "unauthorized" } }) }];

    const res = await syncService.rotateSession();

    assert.equal(res.ok, false);
    const status = await syncService.status();
    assert.equal(status.status, "unauthorized");
    assert.equal(status.authRequired, true, "the Settings page offers the reconnect button");
});

test("a successful rotation still reports success and goes idle", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    const res = await syncService.rotateSession();
    assert.equal(res.ok, true);
    assert.equal((await syncService.status()).status, "idle");
});

/* -------------------------------------------------------------------------- */
/* Changes the server refuses must not look delivered                          */
/* -------------------------------------------------------------------------- */

// A change outside the server's accepted clock window is counted invalid and
// answers 200. The client keeps it in the outbox and retries forever, which is
// right â€” but it used to report a clean run, so the Settings page showed
// "synced just now" while nothing could ever be delivered and the real cause
// (a badly wrong device clock) never surfaced.
test("a push the server refuses is reported, not reported as a clean sync", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    await syncService.enqueue("task", "t1", "upsert", { id: "t1", title: "x", updatedAt: Date.now() });
    routes = [
        { path: "auth/rotate", reply: ok({ expiresAt: 1 }) },
        { path: "sync/push", reply: ok({ accepted: 0, rejected: 0, invalid: 1 }) },
        { path: "sync/pull", reply: ok({ changes: [], nextCursor: 0, more: false }) }
    ];

    const res = await syncService.syncNow();

    assert.equal(res.ok, false);
    assert.equal(res.code, "push_invalid");
    assert.equal(res.invalid, 1);
    const status = await syncService.status();
    assert.equal(status.status, "error");
    assert.equal(status.lastError, "push_invalid");
    // Still queued: the change is kept, it is the reporting that was missing.
    assert.equal(await syncService.pendingCount(), 1);
});

test("a clean sync is still a clean sync", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    await syncService.enqueue("task", "t1", "upsert", { id: "t1", title: "x", updatedAt: Date.now() });

    const res = await syncService.syncNow();

    assert.equal(res.ok, true);
    assert.equal((await syncService.status()).status, "idle");
    assert.equal(await syncService.pendingCount(), 0, "an accepted change leaves the outbox");
});

/* -------------------------------------------------------------------------- */
/* What a run actually moved                                                    */
/* -------------------------------------------------------------------------- */

// The two numbers the refresh button in Settings reports. They exist because
// "sync" with nothing after it is a word a person cannot check anything against,
// and a person who pressed a button to be TOLD the answer is not served by the
// word "done". What they must mean is precise: sent is what the other devices
// have NOW, pulled is what this device was behind on.
//
// The first thing these pin is that the counts came from the real run rather
// than from anything the button chose to believe — a hardcoded "0 changes" is
// the failure this whole feature could have shipped with, and it would have
// looked exactly right.

test("a run reports what it sent and what it received", async () => {
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    await syncService.enqueue("task", "t1", "upsert", { id: "t1", title: "one", updatedAt: Date.now() });
    await syncService.enqueue("task", "t2", "upsert", { id: "t2", title: "two", updatedAt: Date.now() });

    const incoming = {
        id: "t3",
        taskId: null,
        title: "from another device",
        estimatedMs: 0,
        status: "open",
        updatedAt: Date.now()
    };
    const cipher = await cryptoService.encryptData(authService.getMasterKey(), incoming);
    routes = [
        { path: "auth/rotate", reply: ok({ expiresAt: 1 }) },
        { path: "sync/push", reply: ok({ accepted: 2, rejected: 0, invalid: 0 }) },
        {
            path: "sync/pull",
            reply: ok({
                changes: [{ type: "task", id: "t3", op: "upsert", data: { c: cipher }, updatedAt: incoming.updatedAt }],
                nextCursor: 7,
                more: false
            })
        }
    ];

    const res = await syncService.syncNow();

    assert.equal(res.ok, true);
    assert.equal(res.sent, 2, "both queued changes reached the server");
    assert.equal(res.pulled, 1, "the other device's change came down");
    // And the numbers are not a substitute for the work: the record is really
    // there afterwards, which is the only reason to report having received it.
    const stored = await withTx(["tasks"], "readonly", async r => (await tasksRepo(r.tasks).get("t3")));
    assert.equal(stored?.title, "from another device");
});

test("pulled counts every page of a long pull, not only the first", async () => {
    // A run that stops at the first page is a run that says "0 received" on a
    // device that was 40 changes behind, which is worse than saying nothing:
    // it is the answer, and it is wrong.
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });

    let page = 0;
    const cipher = await cryptoService.encryptData(authService.getMasterKey(), { id: "t9", title: "x", updatedAt: Date.now() });
    routes = [
        { path: "auth/rotate", reply: ok({ expiresAt: 1 }) },
        { path: "sync/push", reply: ok({ accepted: 0, rejected: 0, invalid: 0 }) },
        {
            path: "sync/pull",
            reply: () => {
                page += 1;
                return page <= 3
                    ? ok({
                        changes: [{ type: "task", id: `t${page}`, op: "upsert", data: { c: cipher }, updatedAt: Date.now() }],
                        nextCursor: page,
                        more: true
                    })
                    : ok({ changes: [], nextCursor: 4, more: false });
            }
        }
    ];

    const res = await syncService.syncNow();

    assert.equal(res.ok, true);
    assert.equal(res.pulled, 3);
    assert.equal(res.sent, 0, "an empty outbox sends nothing and claims nothing");
});

test("a change the server refused is not counted as sent", async () => {
    // The count is the answer to "did the other device get it", and a refused
    // change is emphatically not on the other device. Counting the batch here
    // would make the button report the exact opposite of the truth.
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    await syncService.enqueue("task", "t1", "upsert", { id: "t1", title: "x", updatedAt: Date.now() });

    routes = [
        { path: "auth/rotate", reply: ok({ expiresAt: 1 }) },
        { path: "sync/push", reply: ok({ accepted: 0, rejected: 0, invalid: 1 }) },
        { path: "sync/pull", reply: ok({ changes: [], nextCursor: 0, more: false }) }
    ];

    const res = await syncService.syncNow();

    assert.equal(res.ok, false);
    assert.equal(res.code, "push_invalid");
    assert.equal(res.sent, 0, "nothing was delivered, so nothing is claimed");
    assert.equal(await syncService.pendingCount(), 1, "and it is still queued to try again");
});

test("a run that had to re-authenticate reports the run that succeeded", async () => {
    // A session that expired mid-run means the first attempt did part of the
    // work and then failed. Its numbers are of a run that did not happen, and
    // adding them to the retry's would report the work twice — so a single
    // change would be counted as two, or a page of them as far more.
    await authService.createSpace({ code: "space-x", password: PASSWORD });
    await syncService.saveConfig({ code: "space-x" });
    await syncService.enqueue("task", "t1", "upsert", { id: "t1", title: "x", updatedAt: Date.now() });

    let pushes = 0;
    routes = [
        { path: "auth/rotate", reply: ok({ expiresAt: 1 }) },
        {
            path: "sync/push",
            reply: () => {
                pushes += 1;
                return pushes === 1
                    ? json(401, { ok: false, error: { code: "unauthorized" } })
                    : ok({ accepted: 1, rejected: 0, invalid: 0 });
            }
        },
        { path: "sync/pull", reply: ok({ changes: [], nextCursor: 0, more: false }) }
    ];

    const res = await syncService.syncNow();

    assert.equal(res.ok, true, "the retry after rotation succeeded");
    assert.equal(pushes, 2, "the server really was asked twice");
    assert.equal(res.sent, 1, "one change, counted once");
    assert.equal(await syncService.pendingCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function buildSyncFile({ code = "space-unit-1" } = {}) {
    const created = await authService.createSpace({ code, password: PASSWORD });
    const { buildSyncFile, serializeSyncFile } = await import("../app/js/services/sync-file.js");
    const verifier = await cryptoService.createOwnerVerifier(OWNER);
    return serializeSyncFile(buildSyncFile({
        code,
        encryptedPayload: created.encryptedKey,
        owner: verifier
    }));
}

// Building a file needs a master key, which means storing one on this device.
// The scenarios that care about a *fresh* device call this afterwards, so the
// device under test really has no key and no owner — which is the whole point.
async function virgin() {
    await cryptoService.clearEncryptionKeys();
    await authService.logout();
    const leftover = await withTx(["meta"], "readonly", async r => {
        const mr = metaRepo(r.meta);
        return {
            key: (await mr.get("task-timer-encrypted-key"))?.value ?? null,
            owner: (await mr.get("task-timer-owner-verifier"))?.value ?? null
        };
    });
    assert.equal(leftover.key, null, "virgin: no encrypted key");
    assert.equal(leftover.owner, null, "virgin: no owner verifier");
}

async function buildBackup() {
    const raw = { app: "task-timer", version: 1, exportedAt: new Date().toISOString(), tasks: [], sessions: [], events: [], settings: {} };
    return sealBackup(raw, PASSWORD);
}

async function sealBackup(raw, password = PASSWORD) {
    const created = await authService.createSpace({ code: "space-unit-1", password });
    const encrypted = await cryptoService.encryptData(authService.getMasterKey(), raw);
    return JSON.stringify({
        app: "task-timer",
        v: 1,
        d: encrypted,
        ek: { v: created.encryptedKey.v, d: created.encryptedKey.d }
    });
}

// Flip one character of a base64 field, which is what a truncated or edited
// file looks like: still valid JSON, still the right shape, but the ciphertext
// no longer authenticates.
function corrupt(text, field) {
    const obj = JSON.parse(text);
    const value = obj[field];
    obj[field] = value.slice(0, 5) + (value[5] === "A" ? "B" : "A") + value.slice(6);
    return JSON.stringify(obj);
}
