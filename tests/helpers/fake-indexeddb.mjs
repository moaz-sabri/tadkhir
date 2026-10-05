// A minimal in-memory IndexedDB, enough to run app/js/data/db.js and the
// service layer that sits on it under `node --test`.
//
// It is NOT a general implementation. It covers exactly what the repos call:
// get / put / add / delete / clear / getAll / count / openCursor over a store,
// with cursor delete/update, keyPath enforcement and the transaction lifecycle
// withTx() depends on (a transaction stays alive while requests are pending, and
// every request settles asynchronously so awaiting one really does yield to the
// microtask queue). Anything else — IDBKeyRange shapes, cursor directions,
// compound keys — throws loudly rather than answering wrongly, so a test cannot
// pass against a store that is not doing what it claims.
//
// Two behaviours are reproduced faithfully on purpose, because both were the
// cause of real bugs and neither is visible from the happy path:
//   - a value whose keyPath does not yield a key fails the request with a
//     DataError and aborts the transaction, exactly as a browser does;
//   - a transaction commits on the macrotask after its last request settles,
//     so work queued in a promise continuation still lands.

let databases = new Map();

// Opened-transaction and request counters, reset per test through the handle
// installFakeIndexedDB() returns.
const counters = { transactions: 0, requests: 0 };

const nextTick = fn => setTimeout(fn, 0);

const domError = (message, name) => new DOMException(message, name);

/* ------------------------------- the store -------------------------------- */
// The data and the keyPath. One per store name per database, shared by every
// transaction â€” which is what makes a readwrite transaction actually visible to
// the next one.
class FakeStore {
    constructor(name, keyPath) {
        this.name = name;
        this.keyPath = keyPath || null;
        this.rows = new Map();
        this.indexNames = new Set();
    }

    keyOf(value) {
        if (!this.keyPath) {
            throw domError("This stub requires a keyPath on every store.", "NotSupportedError");
        }
        const key = value?.[this.keyPath];
        if (key === undefined || key === null) {
            throw domError(
                `Failed to execute 'put' on 'IDBObjectStore': Evaluating the object store's key path did not yield a value.`,
                "DataError"
            );
        }
        return key;
    }
}

/* ------------------------------ the request ------------------------------- */
class FakeRequest {
    constructor(tx) {
        this.onsuccess = null;
        this.onerror = null;
        this.result = undefined;
        this.error = null;
        this.tx = tx;
    }

    succeed(value) {
        this.result = value;
        nextTick(() => {
            this.tx.release();
            if (this.onsuccess) this.onsuccess({ target: this });
        });
    }

    fail(error) {
        this.error = error;
        // A failed request aborts its transaction, and the abort is what the
        // caller actually observes: withTx rejects with tx.error, which is how
        // a DataError from a bad record reached the user as a bare crash.
        this.tx.abandon(error);
        nextTick(() => {
            this.tx.release();
            if (this.onerror) this.onerror({ target: this });
        });
    }
}

class FakeCursor {
    constructor(request, rows, store) {
        this.request = request;
        this.rows = rows;
        this.store = store;
        this.at = 0;
        // An empty walk hands back null immediately, the same as a browser:
        // `index("activeSlot").get(1)` and an index cursor over a store with
        // no matching rows must not produce a cursor with nothing in it.
        this.value = rows.length ? rows[0].value : null;
        this.key = rows.length ? rows[0].key : null;
        this._armed = false;
    }

    /**
     * Hand the caller the next row, or null at the end.
     *
     * The subtlety worth modelling: an open cursor is a pending request, and it
     * stops being one when nothing more is asked of it. `recent(5)` resolves
     * after five rows and never touches the cursor again, so its hold on the
     * transaction has to come off on the next turn — otherwise the transaction
     * never commits and the withTx() around it never settles. A real browser
     * drops the cursor the same way, which is why that pattern is safe there.
     */
    _deliver() {
        const row = this.rows[this.at];
        const exhausted = !row;
        this.value = exhausted ? null : row.value;
        this.key = exhausted ? null : row.key;
        this.request.result = exhausted ? null : this;
        if (exhausted) {
            this.request.tx.release();
        } else {
            this._armed = true;
            nextTick(() => {
                if (this._armed) this.request.tx.release();
            });
        }
        if (this.request.onsuccess) this.request.onsuccess({ target: this.request });
    }

    /** First row of the walk. */
    start() {
        nextTick(() => this._deliver());
    }

    continue() {
        // The cursor holds the transaction ONCE, from creation until it is
        // finished with — so continue() must not take another hold, or nothing
        // ever balances and the transaction never commits.
        this._armed = false;
        this.at++;
        nextTick(() => this._deliver());
    }

    /**
     * `delete()` and `update()`: the two cursor methods a cascade needs.
     *
     * debt-payments.deleteByDebt and page-items.deleteByPage are both a cursor
     * walk that removes what it finds, and without these the helper could not
     * exercise either one — the walk reached `c.delete()` and found no method
     * there. Both are requests that take a hold the way every other read does,
     * because the caller awaits nothing between the delete and the continue(): a
     * synchronous delete would settle the cascade on the wrong turn and the
     * transaction would commit out from under the rest of it.
     *
     * The walk itself is a snapshot taken at openCursor time, so removing a row
     * does not shift the rows still to be visited — which is what a browser does
     * too, and is why `continue()` after a `delete()` is safe.
     */
    delete() {
        const row = this.rows[this.at];
        return this._mutate(request => request.succeed(row ? this.store.rows.delete(this._pkOf(row)) : undefined));
    }

    update(value) {
        const row = this.rows[this.at];
        return this._mutate(request => {
            if (row) {
                // keyPath is "id" on every store in this app, and the rows being
                // replaced are the same rows the snapshot was taken from, so the
                // primary key cannot change under a cursor update.
                this.store.rows.set(this._pkOf(row), value);
            }
            request.succeed(value);
        });
    }

    /**
     * The key a delete or an update has to be addressed by: the PRIMARY key, in
     * both cases.
     *
     * A store cursor's rows carry it as `key`. An INDEX cursor's do not — there
     * `key` is the indexed value, and the primary key is a separate field — and a
     * cascade that deleted by the indexed value would quietly remove whichever
     * record happened to be keyed by the page's id (or remove nothing at all),
     * while still reporting that it had deleted the page's items. That is exactly
     * the kind of answer a stub must not give.
     */
    _pkOf(row) {
        return row.primaryKey === undefined ? row.key : row.primaryKey;
    }

    _mutate(apply) {
        const tx = this.request.tx;
        tx.hold();
        counters.requests++;
        const request = new FakeRequest(tx);
        nextTick(() => {
            try { apply(request); } catch (e) { request.fail(e); }
        });
        return request;
    }
}

/* ------------------------------ IDBKeyRange ------------------------------- */
// Only the factories the repos actually call. A range is a plain object the
// index cursor understands, so nothing else has to know about it.
class FakeKeyRange {
    constructor(lower, upper, lowerOpen = false, upperOpen = false) {
        this.lower = lower;
        this.upper = upper;
        this.lowerOpen = lowerOpen;
        this.upperOpen = upperOpen;
    }

    includes(k) {
        if (this.lower !== undefined) {
            if (this.lowerOpen ? k <= this.lower : k < this.lower) return false;
        }
        if (this.upper !== undefined) {
            if (this.upperOpen ? k >= this.upper : k > this.upper) return false;
        }
        return true;
    }
}

/**
 * The four factories, kept apart rather than merged behind one argument-count
 * dispatch: `only(v)` and `lowerBound(v)` take the same arguments and mean
 * different things, and reading them off the argument list is how a range ends
 * up matching nothing.
 */
const keyRange = {
    only: v => new FakeKeyRange(v, v, false, false),
    lowerBound: (v, open) => new FakeKeyRange(v, undefined, Boolean(open), false),
    upperBound: (v, open) => new FakeKeyRange(undefined, v, false, Boolean(open)),
    bound: (l, u, lo, uo) => new FakeKeyRange(l, u, Boolean(lo), Boolean(uo))
};

/* -------------------------------- indexes --------------------------------- */
// An index is the store's rows projected onto one field and sorted by it. Built
// on demand, so it always reflects the rows as they are now â€” which is what a
// real index does, and what makes a write-then-read-in-one-test correct.
class FakeIndex {
    constructor(store, keyPath, tx) {
        this.store = store;
        this.keyPath = keyPath;
        this.tx = tx;
    }

    get name() { return this.keyPath; }

    // A row with no value for the indexed field gets no index entry, exactly as
    // in a browser â€” which is what makes `index("activeSlot").get(1)` answer
    // undefined when nothing is running.
    entries() {
        const out = [];
        for (const [pk, value] of this.store.rows) {
            const k = value?.[this.keyPath];
            if (k === undefined || k === null) continue;
            out.push({ key: k, value, primaryKey: pk });
        }
        out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return out;
    }

    _match(keyOrRange) {
        // null and undefined both mean "no range" â€” that is what an index cursor
        // with no argument is asking for, and it is how recent() walks the whole
        // index. Treating null as a KEY would match nothing at all.
        const range = keyOrRange instanceof FakeKeyRange
            ? keyOrRange
            : (keyOrRange === undefined || keyOrRange === null
                ? null
                : new FakeKeyRange(keyOrRange, keyOrRange, false, false));
        const all = this.entries();
        return range ? all.filter(e => range.includes(e.key)) : all;
    }

    // Every read on an index returns a REQUEST, not a value, exactly like the
    // store: the repos wrap all of them in req(), which waits for onsuccess. A
    // synchronous index read here would leave that promise pending forever.
    _run(fn) {
        if (!this.tx) throw domError("This index is not bound to a transaction.", "InvalidStateError");
        this.tx.hold();
        counters.requests++;
        const request = new FakeRequest(this.tx);
        nextTick(() => {
            try { request.succeed(fn()); } catch (e) { request.fail(e); }
        });
        return request;
    }

    get(key) {
        return this._run(() => {
            const hit = this._match(key);
            return hit.length ? hit[0].value : undefined;
        });
    }

    getAll(keyOrRange, count) {
        return this._run(() => {
            const hits = this._match(keyOrRange);
            return Number.isInteger(count) ? hits.slice(0, count).map(e => e.value) : hits.map(e => e.value);
        });
    }

    count(keyOrRange) {
        return this._run(() => this._match(keyOrRange).length);
    }

    // An index cursor borrows the transaction of the store it reads, so the
    // lifecycle is the one the store cursor already implements.
    openCursor(keyOrRange, direction = "next") {
        if (!this.tx) throw domError("This index is not bound to a transaction.", "InvalidStateError");
        const rows = this._match(keyOrRange);
        if (direction === "prev") rows.reverse();
        this.tx.hold();
        counters.requests++;
        const request = new FakeRequest(this.tx);
        new FakeCursor(request, rows, this.store).start();
        return request;
    }
}

/* ------------------------- a store bound to a transaction ----------------- */
class StoreHandle {
    constructor(store, tx) {
        this.store = store;
        this.tx = tx;
    }

    get name() { return this.store.name; }
    get keyPath() { return this.store.keyPath; }

    get indexNames() { return { contains: n => this.store.indexNames.has(n) }; }
    createIndex(name) { this.store.indexNames.add(name); return { name }; }
    index(name) {
        if (!this.store.indexNames.has(name)) {
            throw domError(`The specified index was not found: "${name}".`, "NotFoundError");
        }
        return new FakeIndex(this.store, name, this.tx);
    }

    _request() {
        this.tx.hold();
        counters.requests++;
        return new FakeRequest(this.tx);
    }

    _run(fn) {
        const request = this._request();
        try { request.succeed(fn()); } catch (e) { request.fail(e); }
        return request;
    }

    get(key) { return this._run(() => this.store.rows.get(key)); }
    put(value) { return this._run(() => { const k = this.store.keyOf(value); this.store.rows.set(k, value); return k; }); }
    add(value) {
        return this._run(() => {
            const key = this.store.keyOf(value);
            if (this.store.rows.has(key)) throw domError("key already exists", "ConstraintError");
            this.store.rows.set(key, value);
            return key;
        });
    }
    delete(key) { return this._run(() => { this.store.rows.delete(key); return undefined; }); }
    clear() { return this._run(() => { this.store.rows.clear(); return undefined; }); }
    getAll() { return this._run(() => [...this.store.rows.values()]); }
    count() { return this._run(() => this.store.rows.size); }

    // An index cursor belongs to the transaction of the store it reads, so it
    // reuses the store cursor's lifecycle rather than inventing one.
    openCursor() {
        const request = this._request();
        const rows = [...this.store.rows.entries()].map(([key, value]) => ({ key, value }));
        if (rows.length === 0) {
            request.succeed(null);
            return request;
        }
        // The cursor holds the transaction open until it runs off the end of the
        // rows, or until the consumer stops asking for more.
        new FakeCursor(request, rows, this.store).start();
        return request;
    }
}

/* ----------------------------- the transaction --------------------------- */
class FakeTransaction {
    constructor(db, names, mode) {
        this.db = db;
        this.mode = mode;
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this._pending = 0;
        this._done = false;
        this._handles = new Map();
        for (const name of names) {
            const store = db.stores.get(name);
            if (!store) throw domError(`The specified object store was not found: "${name}".`, "NotFoundError");
            this._handles.set(name, new StoreHandle(store, this));
        }
        this._settleIfIdle();
    }

    objectStore(name) {
        let handle = this._handles.get(name);
        if (!handle) {
            // Created on demand: the upgrade transaction is built before the
            // migrations run, so it cannot enumerate the stores they are about
            // to create. Migrations 3 and 5 both reach an existing store this
            // way, which is the whole reason they take the transaction.
            const store = this.db.stores.get(name);
            if (!store) throw domError(`The specified object store was not found: "${name}".`, "NotFoundError");
            handle = new StoreHandle(store, this);
            this._handles.set(name, handle);
        }
        return handle;
    }

    hold() { this._pending++; }

    /**
     * A transaction that issues no request at all still commits on the next
     * turn — a browser does, and code does rely on it: a withTx() whose body
     * only reads `indexNames` would otherwise never settle here.
     */
    _settleIfIdle() {
        nextTick(() => {
            if (this._pending <= 0 && !this._done) {
                this._done = true;
                if (this.oncomplete) this.oncomplete();
            }
        });
    }

    release() {
        this._pending--;
        if (this._pending > 0 || this._done) return;
        // The commit check lands on a macrotask, so every promise continuation
        // queued by the awaiting code has already run â€” which is exactly the
        // window a real IndexedDB transaction stays open for.
        nextTick(() => {
            if (this._pending <= 0 && !this._done) {
                this._done = true;
                if (this.oncomplete) this.oncomplete();
            }
        });
    }

    abandon(error) {
        if (this._done) return;
        this.error = error;
        nextTick(() => {
            if (this._done) return;
            this._done = true;
            if (this.onabort) this.onabort();
        });
    }

    abort() {
        if (this._done) throw domError("The transaction is already finished.", "InvalidStateError");
        this.abandon(this.error || domError("The transaction was aborted.", "AbortError"));
    }
}

/* ------------------------------- the database ---------------------------- */
class FakeDatabase {
    constructor(name) {
        this.name = name;
        this.version = 0;
        this.stores = new Map();
    }

    get objectStoreNames() {
        const names = this;
        return { contains: n => names.stores.has(n) };
    }

    createObjectStore(name, { keyPath } = {}) {
        const store = new FakeStore(name, keyPath);
        this.stores.set(name, store);
        // Inside an upgrade the store belongs to the upgrade transaction, so a
        // migration that seeds rows (Migration 5 writes the built-in finance
        // categories) writes them where a browser would.
        return new StoreHandle(store, this._upgrade || null);
    }

    transaction(names, mode = "readonly") {
        counters.transactions++;
        return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
    }

    close() { }
}

class FakeOpenRequest {
    constructor() {
        this.onsuccess = null;
        this.onerror = null;
        this.onupgradeneeded = null;
        this.onblocked = null;
        this.result = null;
        this.error = null;
        this.transaction = null;
    }
}

/**
 * Install the stub on globalThis and return a handle for the test to use.
 * Call reset() between tests for a brand-new, empty database, so no test ever
 * sees another test's records.
 */
export function installFakeIndexedDB() {
    databases = new Map();
    // The repos build key ranges with the global, exactly as in a browser.
    globalThis.IDBKeyRange = keyRange;
    globalThis.indexedDB = {
        open(name, version) {
            const request = new FakeOpenRequest();
            nextTick(() => {
                let db = databases.get(name);
                const fresh = !db;
                if (fresh) {
                    db = new FakeDatabase(name);
                    databases.set(name, db);
                }
                const oldVersion = fresh ? 0 : db.version;
                request.result = db;
                if (fresh || version > oldVersion) {
                    // The upgrade transaction is what migrations 3 and 5 use to
                    // reach a store created by an earlier migration, so it has to
                    // be able to see the stores that already exist.
                    const upgrade = new FakeTransaction(db, [...db.stores.keys()], "versionchange");
                    db._upgrade = upgrade;
                    request.transaction = upgrade;
                    if (request.onupgradeneeded) {
                        request.onupgradeneeded({ target: request, oldVersion });
                    }
                    db._upgrade = null;
                    db.version = version;
                }
                if (request.onsuccess) request.onsuccess({ target: request });
            });
            return request;
        },

        deleteDatabase(name) {
            const request = new FakeOpenRequest();
            nextTick(() => {
                databases.delete(name);
                if (request.onsuccess) request.onsuccess({ target: request });
            });
            return request;
        }
    };
    return {
        reset() { databases = new Map(); },
        // How many transactions were opened and how many store operations ran
        // inside them, so a test can prove that a batch really was ONE
        // transaction rather than one per record.
        stats() { return { transactions: counters.transactions, requests: counters.requests }; },
        resetStats() { counters.transactions = 0; counters.requests = 0; },
        // db.js caches its open database in a module-level promise, so replacing
        // the map between tests would not be seen by anything that already
        // opened it. Emptying the rows is what a test actually needs: the schema
        // and the connection stay, the records go.
        wipe() {
            for (const db of databases.values()) {
                for (const store of db.stores.values()) store.rows.clear();
            }
        },
        names() { return [...databases.keys()]; }
    };
}
