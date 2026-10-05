// The record vocabulary, in one place.
//
// Every synced thing in this app is a record with the same shape: an id, a
// payload, an updatedAt, a last-write-wins rule and a tombstone. Tasks,
// sessions, events, the four finance stores, the two vocabularies (categories
// and people), Later, and a page and the items inside it are all that one idea,
// differing only in name.
//
// That name used to be written out longhand in five places — the migrations,
// sync-service's type→store map, backup-service's store list, a T_* constant in
// every service, and the PHP whitelist — and they were free to disagree. This
// file is the one place they cannot: migrations.js is frozen and a test checks
// it against this registry, and api/tests/run.php checks the PHP whitelist
// against the same list.
//
// Three things are bound together here per record, because each of them is
// useless without the other two and all three used to be passed separately:
//   store — the IndexedDB object store, which is also what withTx() takes;
//   repo  — the factory that reads it, so a caller never names both;
//   quota — the per-account cap, the field the error points at and the code the
//           UI translates. A quota used to be three agreeing string arguments
//           passed to a helper, with nothing checking that they agreed.

import { tasksRepo } from "./tasks.repo.js";
import { sessionsRepo } from "./sessions.repo.js";
import { eventsRepo } from "./events.repo.js";
import { transactionsRepo } from "./transactions.repo.js";
import { recurringRepo } from "./recurring.repo.js";
import { debtsRepo } from "./debts.repo.js";
import { debtPaymentsRepo } from "./debt-payments.repo.js";
import { categoriesRepo } from "./categories.repo.js";
import { peopleRepo } from "./people.repo.js";
import { laterRepo } from "./later.repo.js";
import { noteMediaRepo } from "./note-media.repo.js";
import { pagesRepo } from "./pages.repo.js";
import { pageItemsRepo } from "./page-items.repo.js";
import { kanbanItemsRepo } from "./kanban-items.repo.js";
import { routinesRepo } from "./routines.repo.js";
import { routineLogsRepo } from "./routine-logs.repo.js";
import { ValidationError } from "../domain/errors.js";
import {
    MAX_TASKS,
    MAX_SESSIONS,
    MAX_FINANCE_TRANSACTIONS,
    MAX_FINANCE_RECURRING,
    MAX_FINANCE_DEBTS,
    MAX_FINANCE_DEBT_PAYMENTS,
    MAX_FINANCE_CATEGORIES,
    MAX_FINANCE_PEOPLE,
    MAX_LATER_ITEMS,
    MAX_PAGES,
    MAX_PAGE_ITEMS,
    MAX_KANBAN_ITEMS,
    MAX_ROUTINES,
    MAX_ROUTINE_LOGS
} from "../domain/validation.js";

/**
 * Every record type, in the order the app thinks about them: the timer first,
 * then its journal, then money, then the two vocabularies money is written in,
 * then the holding pen.
 *
 * Four things are bound together per record, because each is useless without
 * the others and all of them used to be passed separately:
 *   store     — the IndexedDB object store, which is also what withTx() takes;
 *   repo      — the factory that reads it, so a caller never names both;
 *   quota     — the per-account cap, the field the error points at and the code
 *               the UI translates. A quota used to be three agreeing string
 *               arguments passed to a helper, with nothing checking that they
 *               agreed;
 *   backupKey — the field this record occupies in an exported backup. The
 *               backup format groups the money records under `finance*` while
 *               every other vocabulary is named plainly, so this was a fourth
 *               hand-written table of the same ten records, and the one that
 *               decides which key a restore reads each list back from.
 */
export const RECORDS = Object.freeze([
    {
        type: "task",
        store: "tasks",
        backupKey: "tasks",
        repo: tasksRepo,
        quota: { field: "tasks", max: MAX_TASKS, code: "tasks_limit" }
    },
    {
        type: "session",
        store: "sessions",
        backupKey: "sessions",
        repo: sessionsRepo,
        quota: { field: "sessions", max: MAX_SESSIONS, code: "sessions_limit" }
    },
    // The event journal is a log, not a document: it is pruned, never edited
    // in place, and has no quota of its own (the server bounds the space).
    { type: "event", store: "events", backupKey: "events", repo: eventsRepo, quota: null },
    {
        type: "transaction",
        store: "transactions",
        backupKey: "financeTransactions",
        repo: transactionsRepo,
        quota: { field: "transactions", max: MAX_FINANCE_TRANSACTIONS, code: "finance_limit" }
    },
    {
        type: "recurring",
        store: "recurring",
        backupKey: "financeRecurring",
        repo: recurringRepo,
        quota: { field: "recurring", max: MAX_FINANCE_RECURRING, code: "finance_limit" }
    },
    {
        type: "debt",
        store: "debts",
        backupKey: "financeDebts",
        repo: debtsRepo,
        quota: { field: "debts", max: MAX_FINANCE_DEBTS, code: "finance_limit" }
    },
    {
        type: "debtPayment",
        store: "debtPayments",
        backupKey: "financeDebtPayments",
        repo: debtPaymentsRepo,
        quota: { field: "debtPayments", max: MAX_FINANCE_DEBT_PAYMENTS, code: "finance_limit" }
    },
    {
        type: "category",
        store: "categories",
        backupKey: "financeCategories",
        repo: categoriesRepo,
        quota: { field: "categories", max: MAX_FINANCE_CATEGORIES, code: "finance_limit" }
    },
    {
        type: "person",
        store: "people",
        backupKey: "financePeople",
        repo: peopleRepo,
        quota: { field: "people", max: MAX_FINANCE_PEOPLE, code: "finance_limit" }
    },
    {
        type: "later",
        store: "later",
        backupKey: "later",
        repo: laterRepo,
        quota: { field: "later", max: MAX_LATER_ITEMS, code: "later_limit" }
    },
    // Pages, and the items inside them — two records because they are two facts
    // that change for different reasons (see Migration 7). Each cap is its own
    // because they are answered by different questions: "too many pages" is
    // about how many things the user keeps filed away, "too many items" is about
    // one of them getting long, and a user who hit either deserves to be told
    // which one it was.
    {
        type: "page",
        store: "pages",
        backupKey: "pages",
        repo: pagesRepo,
        quota: { field: "pages", max: MAX_PAGES, code: "pages_limit" }
    },
    {
        type: "pageItem",
        store: "pageItems",
        backupKey: "pageItems",
        repo: pageItemsRepo,
        quota: { field: "pageItems", max: MAX_PAGE_ITEMS, code: "page_items_limit" }
    },
    {
        type: "kanbanItem",
        store: "kanbanItems",
        backupKey: "kanbanItems",
        repo: kanbanItemsRepo,
        quota: { field: "kanbanItems", max: MAX_KANBAN_ITEMS, code: "kanban_items_limit" }
    },
    // Routines, and the days a counter recorded. TWO records because they are two
    // facts that change for different reasons: the rule is edited, the day's tally
    // is written once (see Migration 10). Each cap is its own because they answer
    // different questions — "too many routines" is about how much the user keeps
    // repeating, "too many days" is about history, and a user who hits either
    // deserves to be told which one it was.
    {
        type: "routine",
        store: "routines",
        backupKey: "routines",
        repo: routinesRepo,
        quota: { field: "routines", max: MAX_ROUTINES, code: "routines_limit" }
    },
    {
        type: "routineLog",
        store: "routineLogs",
        backupKey: "routineLogs",
        repo: routineLogsRepo,
        quota: { field: "routineLogs", max: MAX_ROUTINE_LOGS, code: "routine_logs_limit" }
    }
]);

/**
 * Stores that are NOT records: local machinery that never syncs and never
 * appears in a backup.
 *
 *  - `meta`      settings, the sync cursor and the crypto key names, addressed
 *                by name rather than by id;
 *  - `outbox`    the pending-sync queue, keyed by `type:id`;
 *  - `noteMedia` the BYTES of a note's attachments, and the reason this list
 *                exists at all — see the note below.
 *
 * The first two have no repo because nothing wraps them: they are read as
 * `r.meta.get(key)` where a record would go through `reader()`. The third is
 * different — it is a real store with a real factory, and it is deliberately
 * NOT a record type, because a record type is something that syncs and a blob
 * is not one of those. So it is declared here instead, in the one file whose
 * job is "the vocabulary of stores", and `localReader` is the `reader()` of a
 * store nobody may enqueue.
 *
 * Exported so `tests/data-layer.test.mjs` can assert that the schema and this
 * list agree, which is what stops a fifth local store from appearing in a
 * migration and being invisible to every other reader of the schema.
 */
export const LOCAL_STORES = Object.freeze(["meta", "outbox", "noteMedia"]);

const localRepos = new Map([["noteMedia", noteMediaRepo]]);

/** The repo factory for a local store, the way `reader()` does it for a record. */
export function localReader(store) {
    const repo = localRepos.get(store);
    if (!repo) throw new Error(`no local repo for store: ${store}`);
    return r => repo(r[store]);
}

/**
 * The two vocabularies: the lists the money records are written in.
 *
 * A restore has to write them BEFORE the records that name them, and the code
 * that said so and the code that did it had drifted apart — the comment claimed
 * an order the statements contradicted. Declaring which records are vocabularies
 * is what lets the restore keep the promise instead of describing it.
 */
export const VOCABULARY_TYPES = Object.freeze(["category", "person"]);

const byType = new Map(RECORDS.map(r => [r.type, r]));
// Both names resolve, on purpose. A record is addressed by its sync type almost
// everywhere ("which record is this change?"), but a transaction is written as
// a store list, so a lookup that only knew the type made every caller that had
// a store name in hand reach for a second function — and the two were easy to
// swap, which is how you get a record type paired with the wrong store.
const byName = new Map(RECORDS.flatMap(r => [[r.type, r], [r.store, r]]));

// The record types, which is exactly what the server's whitelist is. Kept as a
// plain list so a test can compare it to api/sync.php line for line.
export const SYNC_TYPES = Object.freeze(RECORDS.map(r => r.type));

// Type -> store, for the one place that has to translate between them.
export const SYNCED_STORES = Object.freeze(Object.fromEntries(RECORDS.map(r => [r.type, r.store])));

// The stores a backup and a restore cover, in registry order.
export const BACKUP_STORES = Object.freeze(RECORDS.map(r => r.store));

/** The registry entry for a sync type or an IndexedDB store, or undefined. */
export function recordFor(name) {
    return byName.get(name);
}

/** The repo factory for a record: the reader, without naming the store. */
export function repoFor(name) {
    return byName.get(name)?.repo;
}

/**
 * Read a record's store out of a withTx() handle, repo included.
 *
 * This is what replaces the old `transactionsRepo(r.transactions)`, where the
 * store name was written twice — once in the transaction list and once as the
 * handle key — with nothing checking that the two matched. `r` is still keyed
 * by store name, so the transaction list is the one place a store is spelled
 * out, and reader() is the only place that knows which one it belongs to.
 *
 *   const transactions = reader("transaction");
 *   await withTx(["transactions", "categories"], "readwrite", async r => {
 *       await transactions(r).put(record);
 *   });
 */
export function reader(type) {
    const record = byName.get(type);
    if (!record) throw new Error(`unknown record type: ${type}`);
    return r => record.repo(r[record.store]);
}

/**
 * Refuse a write that would take a store past its per-account cap. Called
 * inside the write transaction so two quick taps cannot both pass the same
 * check. The cap, the field the error points at and the code the UI translates
 * all come from the registry, so a store can never be guarded under the wrong
 * name or the wrong message.
 */
export async function guardQuota(r, type) {
    const record = byName.get(type);
    if (!record) throw new Error(`unknown record type: ${type}`);
    if (!record.quota) return;
    const { field, max, code } = record.quota;
    if (await record.repo(r[record.store]).count() >= max) {
        throw new ValidationError(field, code);
    }
}
