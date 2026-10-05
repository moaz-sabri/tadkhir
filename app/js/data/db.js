import { DB_NAME, DB_VERSION } from "../config.js";
import { migrations } from "./migrations.js";
import { ActiveSessionExistsError, TransactionInactiveError } from "../domain/errors.js";

let dbPromise;

export function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = e => {
            const db = e.target && e.target.result;
            if (!db) return;
            for (let v = e.oldVersion + 1; v <= DB_VERSION; v++) {
                const migration = migrations[v];
                if (typeof migration === "function") {
                    // The upgrade transaction is passed alongside the database
                    // because IDBDatabase has no objectStore() method: an
                    // existing store can only be reached through the
                    // versionchange transaction. Without it a migration that
                    // touches an already-created store throws, and the schema
                    // then depends on whether the install was fresh or an
                    // upgrade.
                    try { migration(db, req.transaction); }
                    catch (err) { console.error(`Migration ${v} failed:`, err); }
                }
            }
        };

        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };

        req.onerror = () => {
            const err = req.error;
            if (err && err.name === "VersionError") {
                console.error("IndexedDB version error, deleting database");
                indexedDB.deleteDatabase(DB_NAME);
            }
            reject(req.error);
        };
    });

    return dbPromise;
}

export function withTx(storeNames, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const r = {};
        for (const n of storeNames) r[n] = tx.objectStore(n);

        let value;
        // The reason fn failed, kept apart from the transaction's own error: it
        // is the useful one, and by the time onabort/onerror fires the
        // transaction may already have been discarded.
        let failed = null;

        // fn MUST be invoked synchronously, in the same task that created the
        // transaction. IndexedDB auto-commits a transaction as soon as the task
        // ends with no request pending, so deferring fn by even one microtask
        // (Promise.resolve().then(() => fn(r))) lets it commit first and every
        // request inside then throws TransactionInactiveError. The try/catch is
        // only there so a synchronous throw still becomes a rejection.
        let pending;
        try {
            pending = Promise.resolve(fn(r));
        } catch (e) {
            pending = Promise.reject(e);
        }

        // Whether `fn` has finished. An IndexedDB transaction auto-commits as
        // soon as it has no pending request, so a callback that is still
        // waiting at that point was waiting on something OUTSIDE this
        // transaction — another transaction, a fetch, WebCrypto — and the rest
        // of its work can never land.
        let done = false;
        pending.then(
            v => { value = v; done = true; },
            e => {
                failed = e;
                done = true;
                // Aborting is best-effort. tx.abort() THROWS once the
                // transaction has already finished, and the previous
                // `.catch(e => tx.abort() || reject(e))` let that throw skip
                // the reject() entirely — the promise then stayed pending
                // forever, so the caller's catch never ran, no error surfaced,
                // and the write silently disappeared. A stalled promise is far
                // worse than a failed one.
                try { tx.abort(); } catch { /* already committed or aborted */ }
            }
        );

        // Whichever way the transaction ends, settle exactly once, with the
        // original cause whenever there was one.
        //
        // If `fn` is still running here, the transaction has committed without
        // it. Resolving now would report success for a write that did not
        // happen — and would then discard whatever the callback throws later,
        // which is how a dropped record turned into a silent "it worked". Say
        // so instead.
        const settle = () => {
            if (!done && !failed) failed = new TransactionInactiveError();
            return failed ? reject(failed) : resolve(value);
        };
        const txError = () => (tx.error?.name === "ConstraintError"
            ? new ActiveSessionExistsError()
            : tx.error);

        tx.oncomplete = settle;
        tx.onerror = () => reject(failed || txError());
        tx.onabort = () => reject(failed || txError() || new Error("transaction_aborted"));
    }));
}

export function req(r) {
    return new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}