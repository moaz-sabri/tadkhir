// One vocabulary, one set of bindings — enforced.
//
// The record vocabulary used to be written out longhand in five places that
// were free to disagree: the migrations, sync-service's type→store map,
// backup-service's store list, a T_* constant in every service, and the PHP
// whitelist. A disagreement was invisible until a record failed to sync or a
// store was named that did not exist, and nothing in the suite would have
// caught it.
//
// data/stores.js is now the single place. These tests are what keep it single:
// they read the frozen migrations and the PHP source and fail the moment the
// registry, a service or a transaction drifts away from them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
    RECORDS,
    SYNC_TYPES,
    SYNCED_STORES,
    BACKUP_STORES,
    LOCAL_STORES,
    localReader,
    recordFor,
    reader,
    guardQuota
} from "../app/js/data/stores.js";
import { migrations } from "../app/js/data/migrations.js";
import { DB_VERSION, DB_NAME } from "../app/js/config.js";
import { debtTotals, debtTotalsById, debtsByPerson, debtSummary } from "../app/js/domain/finance.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

// Comments are prose about the design and several of them quote the very things
// these scans look for. Stripped so a note about the old code cannot fail a
// test about the new one.
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const jsFiles = [];
(function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js")) jsFiles.push(p);
    }
})("app/js");

/* -------------------------------------------------------------------------- */
/* The registry itself                                                         */
/* -------------------------------------------------------------------------- */

test("the registry has no duplicate types and no duplicate stores", () => {
    assert.equal(new Set(SYNC_TYPES).size, RECORDS.length, "duplicate record type");
    assert.equal(new Set(BACKUP_STORES).size, RECORDS.length, "duplicate store");
    for (const r of RECORDS) assert.equal(SYNCED_STORES[r.type], r.store);
});

test("every record is looked up by type, by store and through its reader", () => {
    for (const r of RECORDS) {
        // One lookup, and it answers to either name — a record is addressed by
        // its sync type in the services and by its store in a transaction, and
        // two functions for that was a trap.
        assert.equal(recordFor(r.type), r, `recordFor(${r.type})`);
        assert.equal(recordFor(r.store), r, `recordFor(${r.store})`);
        assert.equal(typeof reader(r.type), "function");
        // A reader for a type nobody registered must fail loudly rather than
        // hand back something that quietly does nothing.
        assert.throws(() => reader("not-a-record"), /unknown record type/);
        assert.equal(recordFor("not-a-record"), undefined);
    }
});

test("every quota names the field it guards and a code the UI can translate", () => {
    const strings = read("app/js/i18n/strings.js");
    for (const r of RECORDS) {
        if (!r.quota) continue;
        const { field, max, code } = r.quota;
        assert.ok(field.length > 0, `${r.type} quota field`);
        assert.ok(Number.isInteger(max) && max > 0, `${r.type} quota max`);
        assert.equal(typeof code, "string");
        // The message the user sees has to exist in both languages, or the
        // guard fires into a blank toast.
        assert.ok(strings.includes(`${code}:`), `error.${code} is missing from strings.js`);
        assert.equal(
            (strings.match(new RegExp(`\\n\\s*${code}:`, "g")) || []).length >= 2,
            true,
            `error.${code} is not defined for both en and ar`
        );
    }
});

test("the event journal is the one record with no quota of its own", () => {
    // Everything else is a document the user accumulates and can be shown a
    // cap for. Events are a log the server prunes, so a local cap would refuse
    // a write the server was always going to accept.
    const withQuota = RECORDS.filter(r => r.quota).map(r => r.type);
    assert.equal(recordFor("event").quota, null);
    assert.equal(withQuota.length, RECORDS.length - 1);
});

// A repo is either the whole store interface or it is not. Tasks and sessions
// were each missing `count`, so the quota check on those two stores had to read
// the entire store to produce a number, and guardQuota() — how every other
// quota is checked — could not be pointed at them at all. The failure only
// showed up when a task was actually created.
const CORE = ["get", "getAll", "put", "delete", "count", "clear"];

test("every record repo offers the same core operations", () => {
    for (const r of RECORDS) {
        const repo = r.repo(null);
        for (const op of CORE) {
            assert.equal(typeof repo[op], "function", `${r.type} repo has no ${op}()`);
        }
    }
});

test("the guard can be pointed at every quota-bearing record", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { withTx } = await import("../app/js/data/db.js");

    for (const r of RECORDS) {
        if (!r.quota) continue;
        // Does not throw on an empty store. This is the assertion that matters:
        // a repo without count() used to make this fail with a TypeError, and
        // only when the first task or session was actually created.
        await withTx([r.store], "readwrite", async handle => {
            await guardQuota(handle, r.type);
        });

        // And it refuses once the cap IS reached, with the registry's own field
        // and code. Only for the caps cheap enough to fill here — writing 5000
        // rows through the stub's one-macrotask-per-request would dominate the
        // run, and the mapping it checks is the same for every record.
        if (r.quota.max > 300) continue;
        await withTx([r.store], "readwrite", async handle => {
            const repo = r.repo(handle[r.store]);
            for (let i = 0; i < r.quota.max; i++) {
                await repo.put({ id: `${r.type}-${i}`, name: "n", title: "t", amount: 1, occurredAt: 1, createdAt: 1, updatedAt: 1 });
            }
        });
        await assert.rejects(
            () => withTx([r.store], "readwrite", handle => guardQuota(handle, r.type)),
            (e) => e.code === r.quota.code && e.field === r.quota.field,
            `${r.type} did not refuse at its cap`
        );
        idb.wipe();
    }
});

/* -------------------------------------------------------------------------- */
/* Registry vs the frozen migrations                                            */
/* -------------------------------------------------------------------------- */

// The migrations are FROZEN: a database already at DB_VERSION never runs them
// again, so an edit only reaches fresh installs. They cannot be generated from
// the registry, which is why the check runs the other way round.
test("every store the registry names exists in the schema, keyed on id", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { openDb } = await import("../app/js/data/db.js");
    const db = await openDb();
    idb.wipe();

    for (const r of RECORDS) {
        const store = db.transaction([r.store], "readonly").objectStore(r.store);
        assert.ok(store, `${r.store} is missing from the schema`);
        assert.equal(store.keyPath, "id", `${r.store} is not keyed on id`);
    }
    assert.equal(DB_VERSION, Object.keys(migrations).length, "a migration is missing for a version");
    assert.ok(DB_NAME.length > 0);
});

test("the schema has no store the registry does not know", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { openDb } = await import("../app/js/data/db.js");
    const db = await openDb();
    idb.wipe();

    // The local stores — settings, the pending queue, and the attachment bytes —
    // are read from the registry rather than written out here. They were a
    // hand-written pair in this file once, which is how a third one (noteMedia)
    // could be added to a migration and be invisible to every other reader of
    // the schema; now the list has exactly one home.
    const local = new Set(LOCAL_STORES);
    const known = new Set(RECORDS.map(r => r.store));
    const stores = [...db.stores.keys()];
    for (const s of stores) {
        if (local.has(s)) continue;
        assert.ok(known.has(s), `${s} exists in the schema but not in the registry`);
    }
    assert.deepEqual(
        stores.filter(s => !local.has(s)).sort(),
        [...known].sort(),
        "the schema and the registry disagree about the record stores"
    );
});

/* -------------------------------------------------------------------------- */
/* Registry vs the server whitelist                                            */
/* -------------------------------------------------------------------------- */

test("the server's record whitelist is exactly the registry plus settings", () => {
    const php = read("api/sync.php");
    const block = php.match(/const\s+TASK_TIMER_STORES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(block, "could not find TASK_TIMER_STORES in api/sync.php");
    const phpTypes = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

    // `meta` is the one type the client never enqueues: settings travel as a
    // single document, not as keyed records, and are applied by name.
    assert.deepEqual(
        [...phpTypes].sort(),
        [...SYNC_TYPES, "meta"].sort(),
        "the server accepts types the client never sends, or the client sends types the server rejects"
    );
});

// The constant name says nothing — T_PAYMENT holds "debtPayment" — so the check
// resolves each T_ name to the value the same file gave it.
test("every type a service enqueues is one the server accepts", () => {
    const accepted = new Set(SYNC_TYPES);
    for (const file of jsFiles) {
        const src = code(read(file));
        const constants = new Map();
        for (const m of src.matchAll(/const\s+(T_[A-Z_]+)\s*=\s*"([^"]+)"/g)) {
            constants.set(m[1], m[2]);
        }
        for (const m of src.matchAll(/\bT_[A-Z_]+\b/g)) {
            const name = m[0];
            if (!constants.has(name)) {
                throw new Error(`${file} uses ${name} without defining it`);
            }
            const value = constants.get(name);
            assert.ok(
                accepted.has(value),
                `${file}: ${name} is "${value}", which the server does not accept`
            );
        }
        // A raw string type, straight in an enqueue, cannot be checked this way
        // — so there must not be any.
        for (const m of src.matchAll(/enqueue\(\s*"([^"]+)"/g)) {
            assert.ok(accepted.has(m[1]) || m[1] === "meta", `${file} enqueues the undeclared type "${m[1]}"`);
        }
    }
});

test("every T_ constant a service defines is a real record type", () => {
    const accepted = new Set(SYNC_TYPES);
    for (const file of jsFiles) {
        const src = code(read(file));
        for (const m of src.matchAll(/const\s+T_([A-Z_]+)\s*=\s*"([a-zA-Z]+)"/g)) {
            assert.ok(accepted.has(m[2]), `${file}: T_${m[1]} is "${m[2]}", which is not a record type`);
        }
    }
});

/* -------------------------------------------------------------------------- */
/* No service may name a store that does not exist                             */
/* -------------------------------------------------------------------------- */

// withTx() takes store NAMES as plain strings, and a typo in one either widens
// the transaction (locking a store for nothing) or narrows it (a readwrite
// transaction that then touches a store it never opened, which IndexedDB
// refuses). Neither is caught until runtime, so the names are checked here.
test("every store named in a withTx() call exists in the schema", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { openDb } = await import("../app/js/data/db.js");
    const db = await openDb();
    idb.wipe();
    const stores = new Set([...db.stores.keys()]);

    let checked = 0;
    for (const file of jsFiles) {
        const src = code(read(file));
        for (const m of src.matchAll(/withTx\(\s*\[([\s\S]*?)\]/g)) {
            for (const s of m[1].matchAll(/"([^"]+)"/g)) {
                checked++;
                assert.ok(stores.has(s[1]), `${file} opens a store that does not exist: "${s[1]}"`);
            }
        }
    }
    assert.ok(checked > 40, `expected to check many store lists, only saw ${checked}`);
});

test("every local store is a name in the registry, and the ones with a repo are readable", () => {
    // `localReader` is reader() for a store that is not a record: it exists so
    // the attachment bytes get the same "the store name is written once" property
    // records have, and so a local store with no factory cannot be reached by
    // hand at a call site.
    assert.ok(LOCAL_STORES.includes("noteMedia"),
        "the attachment bytes must be declared as local, or they look like a record");
    assert.equal(recordFor("noteMedia"), undefined,
        "noteMedia must NOT be a record type: it never syncs, so it is not one");
    assert.equal(SYNC_TYPES.includes("noteMedia"), false);
    assert.equal(BACKUP_STORES.includes("noteMedia"), false,
        "attachment bytes are not in a JSON backup, and must never be");
    assert.equal(typeof localReader("noteMedia"), "function");
    assert.throws(() => localReader("meta"), /no local repo/,
        "a store with no factory must fail loudly rather than hand back nothing");
});

test("no service reaches into a record store by hand where a reader would do", () => {
    // `repoFactory(r.storeName)` is the old shape: the store written once in the
    // transaction list and again as the handle key, with nothing tying them
    // together. reader() binds both from one record type.
    //
    // meta and outbox are exempt because they are not records: settings and the
    // pending queue never sync and have no registry entry. sync-service is
    // exempt for the four core records, each of which has its own rules.
    const exempt = new Set(["services/sync-service.js", "data/stores.js"]);
    for (const file of jsFiles) {
        const rel = file.replace(/\\/g, "/");
        if (exempt.has(rel)) continue;
        const src = code(read(file));
        const direct = (src.match(/\b(?:meta|outbox)Repo\(r\.\w+\)/g) || []).length === 0
            ? (src.match(/\b\w+Repo\(r\.\w+\)/g) || [])
            : [];
        assert.deepEqual(direct, [], `${rel} still binds a repo to a store by hand: ${direct.join(", ")}`);
    }
});

/* -------------------------------------------------------------------------- */
/* The batched outbox                                                           */
/* -------------------------------------------------------------------------- */

test("enqueueMany writes a whole batch in ONE transaction", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { withTx, req } = await import("../app/js/data/db.js");
    const { syncService } = await import("../app/js/services/sync-service.js");

    const batch = Array.from({ length: 250 }, (_, i) => ({
        type: "transaction", id: `t${i}`, op: "upsert", data: { id: `t${i}` }
    }));

    idb.resetStats();
    await syncService.enqueueMany(batch);

    const { transactions, requests } = idb.stats();
    assert.equal(transactions, 1, `250 records opened ${transactions} transactions`);
    assert.equal(requests, 250, "every record still gets written");

    const queued = await withTx(["outbox"], "readonly", r => req(r.outbox.getAll()));
    assert.equal(queued.length, 250);
    assert.equal(queued[0].key, "transaction:t0");

    // And the single-record form is the same code path.
    idb.resetStats();
    await syncService.enqueue("later", "l1", "upsert", { id: "l1" });
    assert.equal(idb.stats().transactions, 1);

    await syncService.clearOutbox();
});

test("enqueueMany refuses an empty batch instead of opening a transaction", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { syncService } = await import("../app/js/services/sync-service.js");
    idb.resetStats();
    await syncService.enqueueMany([]);
    await syncService.enqueueMany(null);
    assert.equal(idb.stats().transactions, 0);
    await syncService.clearOutbox();
});

test("an explicit timestamp survives the batch form", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    installFakeIndexedDB();
    const { withTx, req } = await import("../app/js/data/db.js");
    const { syncService } = await import("../app/js/services/sync-service.js");
    const at = 1_700_000_000_000;
    await syncService.enqueueMany([
        { type: "debt", id: "d1", op: "delete", data: null, at },
        { type: "debtPayment", id: "p1", op: "delete", data: null, at }
    ]);
    const queued = await withTx(["outbox"], "readonly", r => req(r.outbox.getAll()));
    assert.equal(queued.length, 2);
    for (const q of queued) {
        assert.equal(q.updatedAt, at, "a batch entry lost its timestamp");
        assert.equal(q.op, "delete");
    }
    await syncService.clearOutbox();
});

/* -------------------------------------------------------------------------- */
/* The indexes the read paths depend on                                        */
/* -------------------------------------------------------------------------- */

// The finance screens used to load whole stores and filter in JavaScript even
// though the store carried an index for exactly that. These are the reads that
// the index is there to serve, checked against the schema so a migration that
// dropped one of the indexes would be caught here rather than by a blank list.
test("every index a repo asks for exists in the schema", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { withTx } = await import("../app/js/data/db.js");

    // What each repo reads, and through which index. Kept here as the answer to
    // "what must the schema provide", which is otherwise only answerable by
    // running the app.
    const expected = {
        sessions: ["startedAt", "taskId", "status", "activeSlot"],
        events: ["sessionId"],
        transactions: ["occurredAt", "category", "recurringId"],
        recurring: ["active", "category"],
        debts: ["direction", "category"],
        debtPayments: ["debtId"],
        // One page's items in the page's own order, and the same items found again
        // to delete with the page. Both are byPage/deleteByPage, so one index
        // serves both reads.
        pageItems: ["pageId"],
        // A routine's own days and one day's rows across every routine.
        routineLogs: ["routineId", "dayKey"]
    };

    for (const [store, indexes] of Object.entries(expected)) {
        const found = await withTx([store], "readonly", r => indexes.filter(n => r[store].indexNames.contains(n)));
        assert.deepEqual(found, indexes, `${store} is missing an index the repos read`);
    }
    idb.wipe();
});

test("an index read returns the same rows a full scan and filter would", async () => {
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { withTx, req } = await import("../app/js/data/db.js");
    const transactions = reader("transaction");
    const debts = reader("debt");
    const at = 1_760_000_000_000;

    await withTx(["transactions", "debts"], "readwrite", async r => {
        for (let i = 0; i < 12; i++) {
            await transactions(r).put({
                id: `t${i}`, type: "expense", title: `T${i}`, amount: 100 + i, currency: "EUR",
                category: ["food", "car", "food"][i % 3], occurredAt: at + i * 1000,
                note: null, recurringId: null, createdAt: at, updatedAt: at
            });
        }
        for (let i = 0; i < 6; i++) {
            await debts(r).put({
                id: `d${i}`, direction: i % 2 ? "owed_to_me" : "owed_by_me", title: `D${i}`,
                personId: null, person: null, amount: 1000, currency: "EUR",
                category: "other", dueAt: null, note: null, createdAt: at, updatedAt: at
            });
        }
    });

    // byCategory — the repo already resolves, so no req() here
    const byCategory = await withTx(["transactions"], "readonly", r => transactions(r).byCategory("food"));
    const scanned = await withTx(["transactions"], "readonly", async r => {
        const all = await transactions(r).getAll();
        return all.filter(t => t.category === "food");
    });
    assert.equal(byCategory.length, 8, "two thirds of the fixtures are 'food'");
    assert.deepEqual(
        byCategory.map(t => t.id).sort(),
        scanned.map(t => t.id).sort(),
        "the indexed read and the scan disagree"
    );

    // recent(5): newest first, and it must stop at the limit
    const recent = await withTx(["transactions"], "readonly", r => transactions(r).recent(5));
    assert.equal(recent.length, 5);
    assert.deepEqual(recent.map(t => t.id), ["t11", "t10", "t9", "t8", "t7"]);

    // sinceOccurred: at or after, in index order (oldest first — unlike
    // recent(), which walks the same index backwards).
    const since = await withTx(["transactions"], "readonly", r => transactions(r).sinceOccurred(at + 8000));
    assert.deepEqual(since.map(t => t.id), ["t8", "t9", "t10", "t11"]);

    // byDirection
    const byDirection = await withTx(["debts"], "readonly", r => debts(r).byDirection("owed_to_me"));
    assert.equal(byDirection.length, 3);
    for (const d of byDirection) assert.equal(d.direction, "owed_to_me");

    // A key nothing matches is empty, not an error and not the whole store.
    const none = await withTx(["transactions"], "readonly", r => transactions(r).byCategory("nope"));
    assert.deepEqual(none, []);

    idb.wipe();
});

test("an abandoned cursor still lets its transaction commit", async () => {
    // recent() resolves after `limit` rows without ever exhausting the cursor.
    // An open cursor is a pending request, and a browser stops treating it as
    // one when nothing more is asked of it — so the transaction around it must
    // still commit, or every screen using recent() would hang forever.
    const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
    const idb = installFakeIndexedDB();
    const { withTx, req } = await import("../app/js/data/db.js");
    const sessions = reader("session");
    const at = 1_760_000_000_000;

    await withTx(["sessions"], "readwrite", async r => {
        for (let i = 0; i < 20; i++) {
            await sessions(r).put({ id: `s${i}`, status: "completed", startedAt: at + i * 1000, segments: [] });
        }
    });

    const settled = await Promise.race([
        withTx(["sessions"], "readonly", async r => {
            const five = await sessions(r).recent(5);
            const active = await sessions(r).getActive();
            return { five: five.length, active: active ?? null };
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("the transaction never committed")), 4000))
    ]);

    assert.equal(settled.five, 5);
    assert.equal(settled.active, null, "no running session among completed ones");
    idb.wipe();
});

/* -------------------------------------------------------------------------- */
/* The grouped totals                                                          */
/* -------------------------------------------------------------------------- */

test("debtTotalsById agrees with debtTotals, debt by debt", () => {
    const debts = [
        { id: "d1", amount: 1000 },
        { id: "d2", amount: 500 },
        { id: "d3", amount: 0 },
        { id: "d4", amount: 2500 }
    ];
    const payments = [
        { debtId: "d1", amount: 400 },
        { debtId: "d1", amount: 600 },
        { debtId: "d2", amount: 499 },
        { debtId: "d4", amount: 3000 },
        { debtId: "missing", amount: 999 },
        { debtId: null, amount: 999 },
        null
    ];
    const grouped = debtTotalsById(debts, payments);
    for (const d of debts) {
        assert.deepEqual(grouped.get(d.id), debtTotals(d, payments), `totals differ for ${d.id}`);
    }
});

test("a debt with no payments, and one overpaid, are both handled", () => {
    const debts = [{ id: "a", amount: 100 }, { id: "b", amount: 100 }];
    const grouped = debtTotalsById(debts, [{ debtId: "b", amount: 250 }]);
    assert.deepEqual(grouped.get("a"), { paid: 0, remaining: 100, settled: false });
    assert.deepEqual(grouped.get("b"), { paid: 250, remaining: 0, settled: true });
    assert.deepEqual(debtTotalsById(debts, []).get("a"), { paid: 0, remaining: 100, settled: false });
});

test("the grouped path keeps debtsByPerson and debtSummary answering as before", () => {
    const debts = [
        { id: "d1", direction: "owed_by_me", amount: 1000, personId: "p1", person: "Sam" },
        { id: "d2", direction: "owed_to_me", amount: 400, personId: "p1", person: "Sam" },
        { id: "d3", direction: "owed_by_me", amount: 300, personId: null, person: null }
    ];
    const payments = [{ debtId: "d1", amount: 250 }, { debtId: "d2", amount: 400 }];
    const people = [{ id: "p1", name: "Sam" }];

    const groups = debtsByPerson(debts, payments, people);
    const sam = groups.find(g => g.personId === "p1");
    assert.equal(sam.owedByMe, 750, "d1 owes 750 of 1000");
    assert.equal(sam.owedToMe, 0, "d2 is fully paid, so it contributes nothing");
    assert.equal(sam.debts.length, 2);
    assert.deepEqual(sam.debts.map(d => d.paid), [250, 400], "each debt carries its own figure");

    // d3 has no person, so it lands in the ungrouped bucket and still counts
    // towards the space-wide total.
    const ungrouped = groups.find(g => !g.personId);
    assert.equal(ungrouped.owedByMe, 300);
    assert.deepEqual(debtSummary(debts, payments), { owedByMe: 1050, owedToMe: 0 });
});
