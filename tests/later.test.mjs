import test from "node:test";
import assert from "node:assert/strict";
import {
    createLaterItem,
    splitLater,
    isDone,
    hostOf,
    laterLabel,
    fromSharePayload
} from "../app/js/domain/later.js";
import {
    validateLaterInput,
    assertLaterRecords,
    assertImportShape,
    LATER_TYPES,
    MAX_LATER_ITEMS,
    MAX_LATER_URL,
    MAX_TITLE,
    MAX_NOTE
} from "../app/js/domain/validation.js";
import { migrations } from "../app/js/data/migrations.js";
import { DB_VERSION } from "../app/js/config.js";
import { ValidationError, ImportError } from "../app/js/domain/errors.js";

const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime();
const HOUR = 3600000;

const link = (over = {}) => ({ type: "link", url: "https://example.com/a", ...over });
const note = (over = {}) => ({ type: "note", content: "read the docs", ...over });

// Assert that validating throws a ValidationError with this exact field + code,
// so a rule cannot quietly change into a different failure.
const rejects = (input, field, code) => {
    assert.throws(
        () => validateLaterInput(input),
        e => e instanceof ValidationError && e.field === field && e.code === code,
        `${field}/${code} expected`
    );
};

// ---------------------------------------------------------------- validation

test("Later is two kinds and nothing more", () => {
    assert.deepEqual(LATER_TYPES, ["link", "note"]);
    // A holding pen, not an archive: 500 is far more than anyone keeps.
    assert.equal(MAX_LATER_ITEMS, 500);
});

test("the kind is required, and nothing else is", () => {
    rejects({ url: "https://example.com" }, "type", "invalid_type");
    rejects({ type: "bookmark" }, "type", "invalid_type");
    rejects({}, "type", "invalid_type");

    // A note needs nothing but its text; a link needs nothing but its url. The
    // two absent fields are normalized to null rather than left undefined, so
    // every stored record has the same shape whichever form wrote it — and
    // `attachments` is normalized to an empty list for the same reason, so a
    // record written before attachments existed has the same keys as one written
    // after.
    assert.deepEqual(validateLaterInput(note()), { type: "note", content: "read the docs", title: null, url: null, attachments: [] });
    assert.deepEqual(validateLaterInput(link()), { type: "link", url: "https://example.com/a", title: null, content: null, attachments: [] });
});

// A note is its text OR its attachments. This is the one rule that had to change
// when attachments arrived, and it changed in the permissive direction on
// purpose: a note that is three photographs and no words is a note, and refusing
// it would mean the camera could not be the first thing somebody did.
test("a note needs text or an attachment, and a link needs neither", () => {
    rejects({ type: "note" }, "content", "required");
    rejects({ type: "note", content: "   " }, "content", "required");

    const photo = { id: "m1", kind: "photo", name: "IMG_1.jpg", type: "image/jpeg", size: 1024, durationMs: null, createdAt: NOW };
    const saved = validateLaterInput({ type: "note", content: null, attachments: [photo] });
    assert.equal(saved.content, null);
    assert.deepEqual(saved.attachments.map(x => x.id), ["m1"]);

    // A link is a link whatever else it carries: the url is the row's action, so
    // it is never satisfied by a picture.
    rejects({ type: "link", url: null, attachments: [photo] }, "url", "required");
});

test("a link needs a url, and gets the scheme it was typed without", () => {
    rejects({ type: "link" }, "url", "required");
    rejects({ type: "link", url: "   " }, "url", "required");

    // Typing a bare host is the normal case, and the stored value is absolute so
    // the row never has to guess how to open it.
    assert.equal(validateLaterInput({ type: "link", url: "example.com/x" }).url, "https://example.com/x");
    assert.equal(validateLaterInput({ type: "link", url: "  https://a.dev/b  " }).url, "https://a.dev/b");
    rejects({ type: "link", url: "x".repeat(MAX_LATER_URL + 1) }, "url", "too_long");
});

test("only http(s) can be stored as a link", () => {
    // A shared string is not trusted: a javascript: or data: url in an href is
    // the one thing this feature must never store.
    rejects({ type: "link", url: "javascript:alert(1)" }, "url", "invalid_type");
    rejects({ type: "link", url: "data:text/html,<b>x" }, "url", "invalid_type");
    rejects({ type: "link", url: "mailto:a@b.c" }, "url", "invalid_type");
    rejects({ type: "link", url: "https://" }, "url", "invalid_type");
    rejects({ type: "link", url: "not a host" }, "url", "invalid_type");
    rejects({ type: "link", url: 42 }, "url", "invalid_type");

    assert.equal(validateLaterInput(link({ url: "http://a.dev" })).url, "http://a.dev/");
});

test("a note is its text, and cannot be empty", () => {
    rejects({ type: "note" }, "content", "required");
    rejects({ type: "note", content: "   \n " }, "content", "required");
    rejects({ type: "note", content: "x".repeat(MAX_NOTE + 1) }, "content", "too_long");

    // A link's text is the reason it was saved, so it is optional; a note's is
    // not.
    assert.equal(validateLaterInput(link()).content, null);
    assert.equal(validateLaterInput(link({ content: "  why  " })).content, "why");
    assert.equal(validateLaterInput(note({ content: "  a thought  " })).content, "a thought");
});

test("a note never keeps a url, so switching a link to a note just works", () => {
    // The kind decides the shape, and this is the case the edit form relies on:
    // changing the kind must not need a second field to clear the old one.
    assert.equal(validateLaterInput({ ...link(), type: "note", content: "just a thought" }).url, null);
    // An empty title is no title at all, not "".
    assert.equal(validateLaterInput(note({ title: "   " })).title, null);
    assert.equal(validateLaterInput(note({ title: " Why " })).title, "Why");
});

test("a title is one short line", () => {
    rejects({ type: "note", content: "x", title: "y".repeat(MAX_TITLE + 1) }, "title", "too_long");
    // It labels a list row, so a newline or a control character in it would
    // break the row it is supposed to name.
    rejects({ type: "note", content: "x", title: "a\nb" }, "title", "invalid_type");
    rejects({ type: "note", content: "x", title: 7 }, "title", "invalid_type");
});

// ------------------------------------------------------------------- records

test("createLaterItem produces exactly the record the feature promised", () => {
    const item = createLaterItem(validateLaterInput(link()), { now: NOW, id: "l1" });
    assert.deepEqual(item, {
        id: "l1",
        type: "link",
        title: null,
        content: null,
        url: "https://example.com/a",
        // What the note CARRIES, not what it holds: the descriptions travel and
        // the bytes stay on the device that captured them. See
        // domain/attachments.js for the whole argument.
        attachments: [],
        // Open until something stamps it: no separate boolean that could
        // disagree with the date.
        completedAt: null,
        createdAt: NOW,
        updatedAt: NOW
    });
    assert.deepEqual(Object.keys(item).sort(), [
        "attachments", "completedAt", "content", "createdAt", "id", "title", "type", "updatedAt", "url"
    ]);
});

test("isDone reads the stamp and nothing else", () => {
    assert.equal(isDone({ completedAt: null }), false);
    assert.equal(isDone({}), false);
    assert.equal(isDone({ completedAt: 0 }), false);
    assert.equal(isDone({ completedAt: NOW }), true);
});

test("splitLater shows the open items first, newest first, then what is done", () => {
    const items = [
        { id: "old", type: "note", content: "a", createdAt: NOW - 3 * HOUR, completedAt: null },
        { id: "new", type: "note", content: "b", createdAt: NOW, completedAt: null },
        { id: "mid", type: "note", content: "c", createdAt: NOW - HOUR, completedAt: null },
        // Followed up in the opposite order to how they were saved, so the two
        // groups cannot both be sorting on createdAt.
        { id: "done-long-ago", type: "note", content: "d", createdAt: NOW, completedAt: NOW - 5 * HOUR },
        { id: "done-recently", type: "note", content: "e", createdAt: NOW - 9 * HOUR, completedAt: NOW - HOUR }
    ];
    const { open, done } = splitLater(items);
    assert.deepEqual(open.map(x => x.id), ["new", "mid", "old"]);
    // The done group is ordered by when it was followed up, not by when it was
    // saved: the most recent decision is the one the user is looking for.
    assert.deepEqual(done.map(x => x.id), ["done-recently", "done-long-ago"]);
    // The input is not reordered underneath the caller.
    assert.deepEqual(items.map(x => x.id), ["old", "new", "mid", "done-long-ago", "done-recently"]);
});

test("splitLater breaks a tie by id, so two devices agree on the order", () => {
    // Same millisecond on both devices: without a deterministic tie-break the
    // two of them would show the same two items in opposite order, and the list
    // would appear to shuffle on every sync.
    const at = NOW;
    const a = { id: "b", type: "note", content: "x", createdAt: at, completedAt: null };
    const b = { id: "a", type: "note", content: "y", createdAt: at, completedAt: null };
    assert.deepEqual(splitLater([a, b]).open.map(x => x.id), ["a", "b"]);
    assert.deepEqual(splitLater([b, a]).open.map(x => x.id), ["a", "b"]);
});

test("splitLater survives a missing or empty list", () => {
    assert.deepEqual(splitLater([]), { open: [], done: [] });
    assert.deepEqual(splitLater(null), { open: [], done: [] });
});

test("a row is labelled by the title, else the host, else the first line", () => {
    assert.equal(laterLabel({ type: "link", title: "Friday", url: "https://a.dev/x" }), "Friday");
    assert.equal(laterLabel({ type: "link", title: "  ", url: "https://www.a.dev/x" }), "a.dev");
    assert.equal(laterLabel({ type: "note", title: null, content: "first\nsecond" }), "first");
    assert.equal(laterLabel({ type: "note", content: "\n\n  spaced  \nrest" }), "spaced");
    // Nothing to show at all is null, and the caller decides the wording.
    assert.equal(laterLabel({ type: "note", content: "   " }), null);
});

test("hostOf strips the www and never throws on rubbish", () => {
    assert.equal(hostOf("https://www.example.com/a/b?c=1#d"), "example.com");
    assert.equal(hostOf("http://sub.example.co.uk/"), "sub.example.co.uk");
    assert.equal(hostOf("not a url"), "");
    assert.equal(hostOf(""), "");
    assert.equal(hostOf(null), "");
});

// --------------------------------------------------------------------- share

test("a shared link arrives as a link, with the page title as its title", () => {
    const out = fromSharePayload({
        url: "https://example.com/article",
        title: "How timers work",
        text: "read this on the train"
    });
    assert.deepEqual(out, {
        type: "link",
        title: "How timers work",
        content: "read this on the train",
        url: "https://example.com/article",
        attachments: []
    });
});

test("a link shared inside the text is still a link, not a note", () => {
    // Some apps share only `text`, and some share the url in it.
    const out = fromSharePayload({ text: "look at this https://example.com/a when you can" });
    assert.equal(out.type, "link");
    assert.equal(out.url, "https://example.com/a");
    // The reason it was saved survives; the link does not sit in the text twice.
    assert.equal(out.content, "look at this when you can");
});

test("sentence punctuation around a shared link is not part of it", () => {
    const out = fromSharePayload({ text: "see https://example.com/a." });
    assert.equal(out.url, "https://example.com/a");
    assert.equal(out.content, "see");
    // A bare www. host is a link too, and gets the scheme it was shared without.
    assert.equal(fromSharePayload({ text: "www.example.com/b" }).url, "https://www.example.com/b");
});

test("a title that is only the link again is dropped, not shown twice", () => {
    const out = fromSharePayload({ url: "https://example.com/a", title: "https://example.com/a" });
    assert.equal(out.title, null);
    assert.equal(out.type, "link");
    assert.equal(out.url, "https://example.com/a");
});

test("shared text with no link is a note", () => {
    const out = fromSharePayload({ text: "look into offline sync for the timer" });
    assert.deepEqual(out, {
        type: "note",
        title: null,
        content: "look into offline sync for the timer",
        url: null,
        attachments: []
    });
    // A title with no link of its own is a note's title.
    assert.equal(fromSharePayload({ text: "an idea", title: "For Later" }).title, "For Later");
});

test("text that only looks like a link stays a note", () => {
    // "v1.0" and a bare domain are far more likely to be words than a link, and
    // a note is the harmless mistake: it is one tap from a link.
    assert.equal(fromSharePayload({ text: "ship v1.0 on friday" }).type, "note");
    assert.equal(fromSharePayload({ text: "read chapter 3.5 later" }).type, "note");
});

test("an empty share saves nothing at all", () => {
    for (const payload of [{}, { text: "" }, { text: "   " }, { url: "" }, { url: null, text: null, title: null }]) {
        assert.throws(
            () => fromSharePayload(payload),
            e => e instanceof ValidationError && e.code === "required",
            "an empty share must not create an item"
        );
    }
});

test("a share cannot smuggle a non-http link in", () => {
    assert.throws(
        () => fromSharePayload({ url: "javascript:alert(1)", title: "x" }),
        e => e instanceof ValidationError && e.field === "url"
    );
});

// -------------------------------------------------------------------- import

test("assertLaterRecords accepts a real set and refuses a broken one", () => {
    const ok = [
        { id: "l1", type: "link", title: "T", content: null, url: "https://a.dev/", completedAt: null, createdAt: NOW, updatedAt: NOW },
        { id: "l2", type: "note", title: null, content: "a thought", url: null, completedAt: NOW, createdAt: NOW, updatedAt: NOW }
    ];
    assert.equal(assertLaterRecords(ok), true);
    assert.equal(assertLaterRecords([]), true);

    const bad = [
        { id: "", type: "link", url: "https://a.dev/", createdAt: NOW, updatedAt: NOW },
        { id: "l3", type: "bookmark", createdAt: NOW, updatedAt: NOW },
        { id: "l3", type: "link", url: "javascript:x", createdAt: NOW, updatedAt: NOW },
        { id: "l3", type: "link", createdAt: NOW, updatedAt: NOW },
        { id: "l3", type: "note", content: "   ", url: null, createdAt: NOW, updatedAt: NOW },
        { id: "l3", type: "note", content: "x", url: "https://a.dev/", createdAt: NOW, updatedAt: NOW },
        { id: "l3", type: "note", content: "x", createdAt: 0, updatedAt: NOW },
        { id: "l3", type: "note", content: "x", createdAt: NOW, updatedAt: NOW, completedAt: "today" },
        "not a record"
    ];
    for (const record of bad) {
        assert.throws(
            () => assertLaterRecords([record]),
            e => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "later",
            `must refuse ${JSON.stringify(record)}`
        );
    }
    assert.throws(() => assertLaterRecords(null), ImportError);
});

test("a backup without Later still imports, and one with it is still a v1 backup", () => {
    const base = {
        app: "task-timer",
        version: 1,
        tasks: [],
        sessions: [],
        events: [],
        settings: {}
    };
    // Additive, exactly like finance: the format version does not move, so an
    // old file is readable and a new one is still readable by an old build that
    // simply ignores the key.
    assert.equal(assertImportShape(base), true);
    assert.equal(assertImportShape({ ...base, later: [] }), true);
    assert.throws(
        () => assertImportShape({ ...base, later: [{ id: "l1", type: "nope" }] }),
        e => e instanceof ImportError && e.detail === "later"
    );
});

// ---------------------------------------------------------------- migrations

// The minimal slice of IDBDatabase a migration touches — real IndexedDB is not
// available in node:test and the project has no test dependency.
function stubDb() {
    const stores = new Map();
    return {
        stores,
        createObjectStore(name) {
            assert.equal(stores.has(name), false, `${name} must not already exist`);
            const indexes = new Set();
            stores.set(name, { name, indexes, rows: [] });
            return {
                indexNames: { contains: i => indexes.has(i) },
                createIndex: i => indexes.add(i),
                put: row => stores.get(name).rows.push(row)
            };
        },
        objectStoreNames: { contains: name => stores.has(name) }
    };
}

// The upgrade transaction, which is how a migration reaches a store that an
// earlier migration already created.
function stubTx(db) {
    return {
        objectStore(name) {
            assert.ok(db.stores.has(name), name + " must exist before it can be reopened");
            const store = db.stores.get(name);
            return {
                indexNames: { contains: i => store.indexes.has(i) },
                createIndex: i => store.indexes.add(i)
            };
        }
    };
}

const indexNames = (db, store) => [...db.stores.get(store).indexes];

// The schema is at 7 now (Pages), but migration 6 is still the Later migration
// and is still frozen: a device that already ran it will never run it again, and
// this test is here to notice if anyone ever edits it.
test("DB_VERSION has moved past the Later migration, which is still 6", () => {
    // The version MOVES and the migration does not: Migration 6 is frozen, and
    // everything since has been additive. This test is the one that says so.
    assert.ok(DB_VERSION > 6, `DB_VERSION should have moved past 6, is ${DB_VERSION}`);
    assert.equal(typeof migrations[6], "function");
});

test("migration 6 adds one store and no indexes", () => {
    const db = stubDb();
    migrations[6](db);
    assert.deepEqual([...db.stores.keys()], ["later"]);
    // Deliberate: the list is read whole on every screen and sorted in JS, so
    // an index would be a promise no read path uses.
    assert.deepEqual(indexNames(db, "later"), []);
    // Nothing is seeded — an empty store is a valid state.
    assert.deepEqual(db.stores.get("later").rows, []);
});

test("migration 6 is additive: an existing database is left exactly as it was", () => {
    // The upgrade path that matters: 1..5 already ran on this device and will
    // never run again, so 6 is the only chance to add the store — and it must
    // not need to touch anything else to do it.
    const db = stubDb();
    for (let v = 1; v <= 5; v++) migrations[v](db, stubTx(db));
    const before = new Map([...db.stores].map(([k, v]) => [k, [...v.indexes]]));

    migrations[6](db);

    for (const [name, indexes] of before) {
        assert.deepEqual(indexNames(db, name), indexes, `${name} must be unchanged`);
    }
    assert.ok(db.stores.has("later"));
    assert.equal(db.stores.size, before.size + 1);
});
