// Guards on the two read services that gather records for a page.
//
// Both exist for the same reason and both are invisible to the rest of the suite:
// they open a transaction, read a list of stores, and hand plain records to a pure
// function in domain/analytics.js. Nothing about them is testable from outside, so
// what is tested here is the thing that actually goes wrong — a reader, a store or
// a record shape that one screen needs and another no longer does.
//
// That failure is not hypothetical. Removing the debt readers from report-service,
// because the home screen had stopped reporting debt balances, broke
// `reportService.summary` — which the REPORTS page calls — and the whole client
// suite stayed green, because no test ever reached either. The reports page threw
// "debts is not defined" the first time anybody opened it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { recordFor } from "../app/js/data/stores.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

const reportService = read("app/js/services/report-service.js");
const logService = read("app/js/services/log-service.js");

// The readers each file declares, as reader-name → STORE name.
//
// Resolved through the registry rather than read off the source, because the
// source names a record TYPE: `reader("debt")` is the store `debts`. Comparing a
// reader against a withTx() list without going through the registry compares a type
// to a store name, and reports every one of them as a mismatch.
function readers(src) {
    const map = new Map();
    for (const m of src.matchAll(/^const (\w+) = reader\("(\w+)"\);/gm)) {
        const record = recordFor(m[2]);
        assert.ok(record, `reader("${m[2]}") names a record type that is not in the registry`);
        map.set(m[1], record.store);
    }
    return map;
}

test("every store a service names in a transaction has a reader bound to it", () => {
    // The rule, stated so a future store cannot be added to a withTx() list without
    // a reader: a transaction that names a store and a call that names a reader are
    // two halves of one thing, and nothing in either language ties them together.
    for (const [name, src] of [["report-service", reportService], ["log-service", logService]]) {
        const bound = readers(src);

        // Every `await <reader>(r.<store>)` must resolve to a reader bound to that
        // exact store. The mismatch case is the one that hides: a reader called
        // `debts` bound to `reader("debtPayment")` reads a real store and answers a
        // different question, and nothing about it looks wrong.
        const dangling = [];
        for (const m of src.matchAll(/await (\w+)\(r\.(\w+)\)\./g)) {
            const [, readerName, storeName] = m;
            if (!bound.has(readerName)) dangling.push(`${name}: ${readerName} is not declared`);
            else if (bound.get(readerName) !== storeName) {
                dangling.push(`${name}: ${readerName} reads ${storeName} but is bound to ${bound.get(readerName)}`);
            }
        }
        assert.deepEqual(dangling, [], `unbound or mismatched readers: ${dangling.join("; ")}`);

        // And every store named in a withTx() list must be read through a reader
        // bound to that exact store. `reader("debt")` bound to `debts` is the shape
        // that hides a mistake, so the store NAME has to match, not the type.
        for (const m of src.matchAll(/withTx\(\s*\[([^\]]+)\]/g)) {
            const stores = [...m[1].matchAll(/"(\w+)"/g)].map(x => x[1]);
            for (const store of stores) {
                const isRead = [...bound.values()].includes(store);
                assert.ok(isRead, `${name}: "${store}" is in a withTx() list and is never read`);
            }
        }

        // A reader that no transaction names is dead weight — and the next person to
        // delete one finds out at runtime rather than here.
        const named = new Set();
        for (const m of src.matchAll(/withTx\(\s*\[([^\]]+)\]/g)) {
            for (const s of m[1].matchAll(/"(\w+)"/g)) named.add(s[1]);
        }
        for (const [readerName, storeName] of bound) {
            assert.ok(named.has(storeName),
                `${name}: ${readerName} binds "${storeName}" and no transaction reads it`);
        }
    }
});

test("both services are read-only: neither opens a readwrite transaction", () => {
    // A report and a log are derived on read. A service that could write would be a
    // second source of truth for the same fact, which is the thing this app's whole
    // storage design exists to prevent.
    for (const [name, src] of [["report-service", reportService], ["log-service", logService]]) {
        assert.doesNotMatch(src, /"readwrite"/, `${name} must never open a readwrite transaction`);
        assert.doesNotMatch(src, /\benqueue\(/, `${name} must never put anything in the sync queue`);
        assert.doesNotMatch(src, /data-changed/, `${name} must not announce a change it does not make`);
    }
});

test("the log reads every store whose records can become a line in it", () => {
    // activityLog() takes sessions, transactions, routines, routineLogs, tasks and
    // later. A store missing from this file is a kind of activity the Log cannot
    // show, and the symptom is a shorter log rather than an error.
    for (const type of ["session", "transaction", "routine", "routineLog", "task", "later"]) {
        const store = recordFor(type).store;
        assert.ok(logService.includes(`"${store}"`),
            `the Log cannot read ${store}, so a ${type} is invisible to it`);
    }
});

test("the glance reads the stores the home screen draws from, and no more", () => {
    // `glance()` is the narrower of the two, and its store list is the whole
    // argument for one transaction rather than nine. The assertion is that the
    // list and the payload agree — a store read but never drawn is a transaction
    // opened for nothing, and a store drawn but not read is a figure that is
    // always zero.
    const glance = reportService.slice(reportService.indexOf("async glance"));
    const stores = [...glance.matchAll(/\[([^\]]+)\]/g)][0][1]
        .matchAll(/"(\w+)"/g);
    const named = [...stores].map(m => m[1]);
    assert.deepEqual(named.sort(),
        ["debtPayments", "debts", "later", "pages", "recurring", "routines", "sessions", "tasks", "transactions"].sort());
    // The debts are on it now, and that is a decision rather than an accident: they
    // were off it while the home screen reported only the month's flows, on the
    // ground that a balance belongs to Finance and Reports. It is on it because
    // "how much do I owe" is not a summary of the month — it is the figure the
    // person is carrying around, and a month that ends in three zeroes beside a
    // debt they still owe is the easier half of the story. See homeGlance.
    assert.ok(named.includes("debts"));
    // Both, not one: a debt is its amount MINUS what has been paid against it, and
    // an unpaid-for balance is a wrong figure rather than a rough one.
    assert.ok(named.includes("debtPayments"));
});
