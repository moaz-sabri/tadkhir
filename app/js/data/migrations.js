import { BUILTIN_FINANCE_CATEGORIES } from "../domain/validation.js";

export const migrations = {
    1(db) {
        const tasks = db.createObjectStore("tasks", { keyPath: "id" });

        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("startedAt", "startedAt");
        sessions.createIndex("taskId", "taskId");
        sessions.createIndex("status", "status");
        sessions.createIndex("activeSlot", "activeSlot", { unique: true });

        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("sessionId", "sessionId");

        db.createObjectStore("meta", { keyPath: "key" });
    },
    2(db) {
        db.createObjectStore("outbox", { keyPath: "key" });
    },
    3(db, tx) {
        // Adds an index to a store that Migration 1 already created, so it
        // needs the upgrade transaction: IDBDatabase has no objectStore()
        // method. Calling db.objectStore("meta") here threw on every fresh
        // install, which left the index missing on new databases while
        // upgraded ones had it — the same version, two different schemas.
        // The transaction is optional so this migration can still be exercised
        // against the bare stub in tests.
        if (!db.objectStoreNames.contains("meta")) return;
        const meta = tx ? tx.objectStore("meta") : null;
        if (!meta) return;
        try { meta.createIndex("enc_key", "key"); } catch { /* index exists */ }
    },
    4(db) {
        // Finance. Purely additive: existing stores are left untouched, so a
        // user who never opens Finance keeps their tasks, sessions and events
        // exactly as they were.
        //
        // FROZEN: this migration shipped in DB_VERSION 4 and must never be
        // edited. A database already at version 4 does not run it again, so
        // anything added here would exist only on fresh installs and be missing
        // on every upgraded one — the same version with two different schemas.
        // Later needs belong in a new migration (see 5).
        const transactions = db.createObjectStore("transactions", { keyPath: "id" });
        transactions.createIndex("occurredAt", "occurredAt");
        transactions.createIndex("category", "category");
        transactions.createIndex("recurringId", "recurringId");

        const recurring = db.createObjectStore("recurring", { keyPath: "id" });
        recurring.createIndex("active", "active");

        const debts = db.createObjectStore("debts", { keyPath: "id" });
        debts.createIndex("direction", "direction");

        // A payment always belongs to a debt; the index is how a debt loads
        // its history without scanning the whole store.
        const debtPayments = db.createObjectStore("debtPayments", { keyPath: "id" });
        debtPayments.createIndex("debtId", "debtId");
    },
    5(db, tx) {
        // Categories and people. Additive in the same way Migration 4 was:
        // nothing that already exists is touched.
        //
        // A category is a NAME, nothing more: `id` IS the key that the finance
        // records already keep in their `category` field, and it doubles as the
        // label shown in the UI. There are no icons, colours, budgets or
        // ordering. Because the key is the name, the seven built-ins seed
        // exactly as the values already stored in existing records, so no
        // finance record has to be rewritten by this migration.
        const categories = db.createObjectStore("categories", { keyPath: "id" });

        // People are the owner of a debt's `personId`. Which side of a debt
        // they sit on is the DEBT's direction, never a property of the person,
        // so one record serves both "I owe Sam" and "Sam owes me".
        db.createObjectStore("people", { keyPath: "id" });

        // The category manager has to find every transaction, recurring rule
        // and debt that uses a category, so those stores need a `category`
        // index. Migration 4 shipped without one and never runs again on an
        // upgraded database, so the index has to be added here — putting it in
        // Migration 4 gave fresh installs an index that every real upgrade was
        // missing, and deleting a category then failed with
        // "The specified index was not found".
        //
        // Reached through the upgrade transaction, because IDBDatabase has no
        // objectStore() method. Guarded so the migration stays idempotent.
        for (const name of ["recurring", "debts"]) {
            if (!db.objectStoreNames.contains(name)) continue;
            const store = tx ? tx.objectStore(name) : null;
            if (store && !store.indexNames.contains("category")) {
                store.createIndex("category", "category");
            }
        }

        // First use: the default categories are there before any page asks for
        // them, on a fresh install and on an upgrade alike. No re-seeding
        // logic exists anywhere, and none is needed — the default category
        // cannot be deleted, so the store is never empty.
        const at = Date.now();
        for (const id of BUILTIN_FINANCE_CATEGORIES) {
            categories.put({ id, createdAt: at, updatedAt: at });
        }
    },
    6(db) {
        // Later / follow-up. Purely additive, the same way Migrations 4 and 5
        // were: a new store, and nothing that already exists is read or
        // rewritten, so a device that never opens Later keeps its tasks,
        // sessions, events and finance exactly as they were.
        //
        // FROZEN once shipped: a database already at version 6 does not run it
        // again, so anything added here later would exist on fresh installs
        // only. New needs belong in a new migration.
        //
        // No index, and that is the whole design: the store is capped at a few
        // hundred rows and every screen reads the whole list, so there is
        // nothing for an index to serve (see later.repo.js). Adding one that
        // nothing reads is the same kind of drift as a missing one.
        db.createObjectStore("later", { keyPath: "id" });
    },
    7(db) {
        // Pages. Purely additive, the same way Migrations 4, 5 and 6 were: two
        // new stores, and nothing that already exists is read or rewritten, so a
        // device that never opens Pages keeps its tasks, sessions, events,
        // finance and Later exactly as they were.
        //
        // FROZEN once shipped: a database already at version 7 does not run it
        // again, so anything added here later would exist on fresh installs
        // only. New needs belong in a new migration.
        //
        // TWO stores, not one. A page and the items inside it are two different
        // facts that change for different reasons, and last-write-wins compares
        // one `updatedAt` per record. Had the items been an array on the page,
        // typing in a text item would carry a timestamp that also claimed the
        // whole page had been rewritten, and a reorder arriving from another
        // device would drop the edit or vice versa. Separate records means a
        // reorder and a text edit resolve independently, exactly like a debt and
        // its payments do.
        db.createObjectStore("pages", { keyPath: "id" });

        // An item always belongs to a page, and the index is how a page reads
        // its own contents without scanning every page on the device — the same
        // reason debtPayments carries a `debtId` index. It also serves the
        // cascade: deleting a page deletes the rows this index selects.
        const pageItems = db.createObjectStore("pageItems", { keyPath: "id" });
        pageItems.createIndex("pageId", "pageId");
    },
    8(db) {
        // Note attachments. Purely additive, the same way Migrations 4 through 7
        // were: one new store, and nothing that already exists is read or
        // rewritten, so a device that never attaches anything keeps its records
        // exactly as they were.
        //
        // FROZEN once shipped: a database already at version 8 does not run it
        // again, so anything added here later would exist on fresh installs
        // only. New needs belong in a new migration.
        //
        // ONE store, holding the BYTES. The description of an attachment — its
        // kind, name, size, duration — is an array on the note record itself,
        // which is why there is no `noteAttachments` store of metadata here: the
        // description is a few hundred bytes of ordinary JSON that has to reach
        // the other devices (so they can say "3 photos" and explain that the
        // pictures are not here), while the bytes are megabytes that must not
        // leave this device at all. Splitting them is the whole design; see
        // domain/attachments.js.
        const media = db.createObjectStore("noteMedia", { keyPath: "id" });

        // The cascade. A note deleted on another device arrives as a record
        // whose descriptions are already gone, so the only thing that can say
        // which blobs are now orphaned is an index from the note — the same
        // reason debtPayments and pageItems carry one.
        media.createIndex("noteId", "noteId");
    },
    9(db) {
        // Kanban board: general administrative kanban independent of any single service.
        // Stores references to original items (by service/type and originalId), not copies.
        // Four fixed columns represented by status: have, working, done, deferred.
        const kanbanItems = db.createObjectStore("kanbanItems", { keyPath: "id" });
        kanbanItems.createIndex("status", "status");
        kanbanItems.createIndex("originalKey", "originalKey", { unique: true });
        kanbanItems.createIndex("service", "service");
        kanbanItems.createIndex("dueAt", "dueAt");
        kanbanItems.createIndex("todayKey", "todayKey");
    },
    10(db) {
        // Routines. Purely additive, the same way Migrations 4 through 9 were:
        // two new stores, and nothing that already exists is read or rewritten, so
        // a device that never opens Routines keeps its records exactly as they
        // were.
        //
        // FROZEN once shipped: a database already at version 10 does not run it
        // again, so anything added here later would exist on fresh installs only.
        // New needs belong in a new migration.
        //
        // TWO stores, and the split is the whole design: a routine is a RULE
        // ("run for 30 minutes, every day") and what the user actually did is a
        // different fact with a different lifetime. The rule is edited; the day is
        // written once and read again in the reports. Last-write-wins compares one
        // `updatedAt` per record, so on one record the two would overwrite each
        // other — pressing "+" on a counter would push the routine's own settings
        // to the losing side of the next sync. Separate records, the same argument
        // as pages and pageItems, and the same as a debt and its payments.
        //
        // What lands in `routineLogs` is only ever a COUNTER's tally. A timed
        // routine produces a session, and the session is the record of it: writing
        // a second copy of "the run happened" would be a copy that could disagree
        // with the one the app already keeps, and it would be a copy of something
        // that already syncs.
        db.createObjectStore("routines", { keyPath: "id" });

        // One row per routine per day. The id IS that pair, so today's row is a
        // `get` rather than a scan, and the counter starts again by itself when
        // the day rolls over — there is nothing to reset and nothing that can be
        // left holding yesterday's number.
        //
        // `routineId` serves the two reads that exist: this routine's own history
        // (its detail screen and the reports) and the cascade that takes those
        // rows away with the rule, because a tally nobody can reach any more is
        // storage that never comes back. `dayKey` is the one the home screen
        // reads: "what is due today" is a lookup of today's rows, not a filter
        // over all of them.
        const routineLogs = db.createObjectStore("routineLogs", { keyPath: "id" });
        routineLogs.createIndex("routineId", "routineId");
        routineLogs.createIndex("dayKey", "dayKey");
    }
};