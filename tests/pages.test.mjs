// Pages, end to end: the rules, the pure logic, the schema, and the service
// layer running on the fake IndexedDB.
//
// The point of the feature is that a page holds NO records of its own except
// words — every line that points at something stores an id and reads the rest
// from the record itself. So most of what follows is really one question asked
// from different angles: can a page ever become a second copy, or a second place
// something is edited?

import test from "node:test";
import assert from "node:assert/strict";

import {
    PAGE_ITEM_ROUTES,
    targetIdOf,
    linkFor,
    pageLabel,
    sortPages,
    sortItems,
    nextPosition,
    createPage,
    createPageItem,
    moveItem,
    itemText
} from "../app/js/domain/pages.js";
import {
    validatePageInput,
    validatePageItemInput,
    assertPageRecords,
    assertPageItemRecords,
    assertImportShape,
    PAGE_ITEM_TYPES,
    PAGE_ITEM_TARGETS,
    MAX_PAGES,
    MAX_PAGE_ITEMS,
    MAX_PAGE_TEXT,
    MAX_TITLE,
    MAX_NOTE
} from "../app/js/domain/validation.js";
import { migrations } from "../app/js/data/migrations.js";
import { DB_VERSION } from "../app/js/config.js";
import { ValidationError, NotFoundError, ImportError } from "../app/js/domain/errors.js";

const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();
const HOUR = 3600000;

const rejectsPage = (input, field, code) => assert.throws(
    () => validatePageInput(input),
    e => e instanceof ValidationError && e.field === field && e.code === code,
    `${field}/${code} expected`
);

const rejectsItem = (input, field, code) => assert.throws(
    () => validatePageItemInput(input),
    e => e instanceof ValidationError && e.field === field && e.code === code,
    `${field}/${code} expected`
);

// ------------------------------------------------------------------ the shape

test("a page item is one of seven kinds, and four of them point at a record", () => {
    assert.deepEqual(PAGE_ITEM_TYPES, [
        "text", "heading", "divider", "task", "session", "reference", "expense"
    ]);
    // The order is the chooser's order: your own words first, then the four
    // pointers, then the divider that is neither.
    assert.deepEqual(PAGE_ITEM_TYPES.filter(t => PAGE_ITEM_TARGETS[t]), [
        "task", "session", "reference", "expense"
    ]);
    assert.deepEqual(PAGE_ITEM_TYPES.filter(t => !PAGE_ITEM_TARGETS[t]), [
        "text", "heading", "divider"
    ]);
    // 100 filed pages is far more than anyone keeps; 1000 lines is the point at
    // which "a page" stops being a page and start-sync-the-whole-thing stops
    // being bounded.
    assert.equal(MAX_PAGES, 100);
    assert.equal(MAX_PAGE_ITEMS, 1000);
});

test("each pointer names the record it points at in the field that kind uses", () => {
    // Three readers have to agree about this map — the validator (which field is
    // required), the domain module (which id the item carries) and the picker
    // (what to write when the user chooses). One table, and the names say what
    // they point at rather than what they are called.
    assert.deepEqual(PAGE_ITEM_TARGETS, {
        task: "taskId",
        session: "sessionId",
        reference: "laterId",
        expense: "transactionId"
    });
});

test("every kind's base address is a real screen in the app", () => {
    // A page adds no screen of its own to open. Each base here is an existing
    // list route with a `:id` detail behind it, which is what makes the promise
    // "tapping a line opens the original" keepable without a new router table.
    assert.deepEqual(PAGE_ITEM_ROUTES, {
        task: "/tasks",
        session: "/sessions",
        reference: "/later",
        expense: "/finance/transactions"
    });
});

// ---------------------------------------------------------------- validation

test("a page may have no title at all", () => {
    // A page is created untitled and named afterwards, so "not written yet" is a
    // real state rather than a rejected input — an empty title is null, not "".
    assert.deepEqual(validatePageInput({}), { title: null, description: null });
    assert.deepEqual(validatePageInput({ title: "   " }).title, null);
    assert.equal(validatePageInput({ title: "  Moving  " }).title, "Moving");

    rejectsPage({ title: 7 }, "title", "invalid_type");
    // A title labels a list row, so a newline in it would break the row.
    rejectsPage({ title: "a\nb" }, "title", "invalid_type");
    rejectsPage({ title: "x".repeat(MAX_TITLE + 1) }, "title", "too_long");
});

test("a description is optional and borrows the note limit", () => {
    assert.equal(validatePageInput({ description: "  about it  " }).description, "about it");
    assert.equal(validatePageInput({ description: "" }).description, null);
    rejectsPage({ description: 5 }, "description", "invalid_type");
    rejectsPage({ description: "x".repeat(MAX_NOTE + 1) }, "description", "too_long");
});

test("the kind is required, and it decides which body is required", () => {
    rejectsItem({ type: "bookmark" }, "type", "invalid_type");
    rejectsItem({}, "type", "invalid_type");
    // An item without a page could never be shown by any screen.
    rejectsItem({ type: "text" }, "pageId", "invalid_type");
    // The position is the page's own order, and a gapless integer index.
    rejectsItem({ type: "text", pageId: "p1", position: -1 }, "position", "out_of_range");
    rejectsItem({ type: "text", pageId: "p1", position: 1.5 }, "position", "out_of_range");
});

test("a pointer needs the id of a record, and keeps only that one field", () => {
    rejectsItem({ type: "task", pageId: "p1", content: {} }, "content", "required");
    rejectsItem({ type: "task", pageId: "p1" }, "content", "invalid_type");
    // An id that is present but not a non-empty string is the same failure as a
    // missing one — one rule, "an item of this kind must carry an id" — rather
    // than two codes the UI would have to translate separately.
    rejectsItem({ type: "task", pageId: "p1", content: { taskId: 7 } }, "content", "required");
    rejectsItem({ type: "task", pageId: "p1", content: { taskId: "" } }, "content", "required");
    rejectsItem({ type: "task", pageId: "p1", content: [] }, "content", "invalid_type");
    rejectsItem({ type: "task", pageId: "p1", content: "t1" }, "content", "invalid_type");

    // Only the field this kind uses survives. Switching a link from a task to a
    // session must not leave the old task's id behind, or the row would keep
    // pointing at something the user never chose.
    assert.deepEqual(validatePageItemInput({
        type: "session", pageId: "p1", content: { taskId: "t1", sessionId: "s1" }
    }).content, { sessionId: "s1" });

    for (const [type, target] of Object.entries(PAGE_ITEM_TARGETS)) {
        assert.deepEqual(
            validatePageItemInput({ type, pageId: "p1", content: { [target]: `${type}-id` } }).content,
            { [target]: `${type}-id` }
        );
    }
});

test("an oversized id is refused, and an id of any real shape is not", () => {
    const big = "x".repeat(MAX_TITLE + 1);
    for (const [type, target] of Object.entries(PAGE_ITEM_TARGETS)) {
        rejectsItem({ type, pageId: "p1", content: { [target]: big } }, "content", "too_long");
        assert.equal(
            validatePageItemInput({ type, pageId: "p1", content: { [target]: "abc-123" } }).content[target],
            "abc-123"
        );
    }
});

test("a paragraph may be long, and may be empty", () => {
    // A page is the one place in the app where prose belongs, so the text limit
    // is much higher than a note's — but still bounded, so a pasted document
    // cannot turn a record into a payload.
    assert.ok(MAX_PAGE_TEXT > MAX_NOTE);
    assert.equal(
        validatePageItemInput({ type: "text", pageId: "p1", content: { text: "x".repeat(MAX_PAGE_TEXT) } })
            .content.text.length,
        MAX_PAGE_TEXT
    );
    rejectsItem(
        { type: "text", pageId: "p1", content: { text: "x".repeat(MAX_PAGE_TEXT + 1) } },
        "content", "too_long"
    );
    // Empty is a state, not a failure: the editor creates the line and the user
    // types into it, so "not written yet" has to survive a round trip. A
    // "required" rule would block every backspace.
    assert.deepEqual(validatePageItemInput({ type: "text", pageId: "p1", content: { text: "" } }).content, { text: "" });
    assert.deepEqual(validatePageItemInput({ type: "text", pageId: "p1", content: {} }).content, { text: "" });
    // Trimmed on the way in, so the stored words are the words and not the
    // paragraph the user left behind with the caret parked on a blank line.
    assert.deepEqual(
        validatePageItemInput({ type: "text", pageId: "p1", content: { text: "  a\nb  " } }).content,
        { text: "a\nb" }
    );
    rejectsItem({ type: "text", pageId: "p1", content: { text: 5 } }, "content", "invalid_type");
});

test("a heading is one line, and may be empty", () => {
    assert.deepEqual(validatePageItemInput({ type: "heading", pageId: "p1", content: { text: "  Bills " } }).content, { text: "Bills" });
    assert.deepEqual(validatePageItemInput({ type: "heading", pageId: "p1", content: { text: "" } }).content, { text: "" });
    // A heading is a title in the middle of a document, so a newline in it would
    // be two headings — and the textarea's Enter key is wired to blur for the
    // same reason.
    rejectsItem({ type: "heading", pageId: "p1", content: { text: "a\nb" } }, "content", "invalid_type");
    rejectsItem(
        { type: "heading", pageId: "p1", content: { text: "x".repeat(MAX_TITLE + 1) } },
        "content", "too_long"
    );
});

test("a divider carries nothing at all", () => {
    assert.deepEqual(validatePageItemInput({ type: "divider", pageId: "p1" }).content, {});
    // Text written on a divider by a hand-edited import must not survive: the
    // kind is the body.
    assert.deepEqual(validatePageItemInput({ type: "divider", pageId: "p1", content: { text: "x" } }).content, {});
});

// --------------------------------------------------------------- the records

test("createPage produces exactly the record the feature promised", () => {
    const page = createPage(validatePageInput({ title: "Flat" }), { now: NOW, id: "p1" });
    assert.deepEqual(page, {
        id: "p1",
        title: "Flat",
        description: null,
        createdAt: NOW,
        updatedAt: NOW
    });
    // No deletedAt: this app tombstones in the outbox and settles by updatedAt,
    // and a soft-delete field anywhere would be a second mechanism to keep right.
    assert.deepEqual(Object.keys(page).sort(), ["createdAt", "description", "id", "title", "updatedAt"]);
});

test("createPageItem produces a record with exactly one position and one body", () => {
    const item = createPageItem(
        validatePageItemInput({ type: "task", pageId: "p1", content: { taskId: "t1" } }),
        { now: NOW, id: "i1", position: 3 }
    );
    assert.deepEqual(item, {
        id: "i1",
        pageId: "p1",
        type: "task",
        position: 3,
        content: { taskId: "t1" },
        createdAt: NOW,
        updatedAt: NOW
    });
    assert.deepEqual(Object.keys(item).sort(), [
        "content", "createdAt", "id", "pageId", "position", "type", "updatedAt"
    ]);
});

test("itemText reads only the two kinds that have words", () => {
    assert.equal(itemText({ type: "text", content: { text: "a" } }), "a");
    assert.equal(itemText({ type: "heading", content: { text: "b" } }), "b");
    // A pointer's words live in the record it points at, not here.
    assert.equal(itemText({ type: "task", content: { taskId: "t1" } }), "");
    assert.equal(itemText({ type: "divider", content: {} }), "");
    assert.equal(itemText(null), "");
    assert.equal(itemText({ type: "text" }), "");
});

test("a page is labelled by its title, else its description, else nothing", () => {
    assert.equal(pageLabel({ title: "Flat", description: "the move" }), "Flat");
    assert.equal(pageLabel({ title: "   ", description: "  the move  \nrest" }), "the move");
    // null, so the caller decides the wording rather than the domain picking
    // "Untitled" — which is a language decision, not a data one.
    assert.equal(pageLabel({ title: null, description: "  \n " }), null);
    assert.equal(pageLabel({}), null);
    assert.equal(pageLabel(null), null);
});

test("targetIdOf and linkFor agree with PAGE_ITEM_TARGETS, or say nothing", () => {
    assert.equal(targetIdOf({ type: "task", content: { taskId: "t1" } }), "t1");
    assert.equal(linkFor({ type: "task", content: { taskId: "t1" } }), "/tasks/t1");
    assert.equal(linkFor({ type: "reference", content: { laterId: "l1" } }), "/later/l1");
    assert.equal(linkFor({ type: "expense", content: { transactionId: "x1" } }), "/finance/transactions/x1");
    assert.equal(linkFor({ type: "session", content: { sessionId: "s1" } }), "/sessions/s1");

    // The three kinds that point at nothing, and a pointer with nothing in it:
    // all null, never a half-built address.
    assert.equal(targetIdOf({ type: "heading", content: { text: "x" } }), null);
    assert.equal(linkFor({ type: "divider", content: {} }), null);
    assert.equal(linkFor({ type: "task", content: {} }), null);
    assert.equal(linkFor({ type: "task", content: { taskId: "" } }), null);
    assert.equal(linkFor(null), null);
    // An id that is not a string is not an id, rather than being stringified into
    // a link that opens a screen for a record called "[object Object]".
    assert.equal(targetIdOf({ type: "task", content: { taskId: 7 } }), null);
});

// --------------------------------------------------------------- the ordering

test("pages are listed newest first, and ties break on id", () => {
    const page = (id, createdAt) => ({ id, createdAt });
    const pages = [page("b", NOW), page("a", NOW), page("old", NOW - HOUR)];
    assert.deepEqual(sortPages(pages).map(x => x.id), ["a", "b", "old"]);
    // The input is not reordered underneath the caller.
    assert.deepEqual(pages.map(x => x.id), ["b", "a", "old"]);

    // Same millisecond on two devices: without a deterministic tie-break the two
    // of them would show the same two pages in opposite order, and the list
    // would appear to shuffle on every sync.
    const same = [page("b", NOW), page("a", NOW)];
    assert.deepEqual(sortPages(same).map(x => x.id), sortPages(same.slice().reverse()).map(x => x.id));

    assert.deepEqual(sortPages([]), []);
    assert.deepEqual(sortPages(null), []);
});

test("items come back in the page's order, and the input is left alone", () => {
    const items = [
        { id: "c", position: 2 },
        { id: "a", position: 0 },
        { id: "b", position: 1 }
    ];
    assert.deepEqual(sortItems(items).map(x => x.id), ["a", "b", "c"]);
    assert.deepEqual(items.map(x => x.id), ["c", "a", "b"]);
    assert.deepEqual(sortItems([]), []);
    assert.deepEqual(sortItems(null), []);
});

test("a new item goes on the end and never renumbers the ones already there", () => {
    // An add is an append. Inserting between two items would rewrite the whole
    // page on every device that has it, for no reason the user asked for.
    assert.equal(nextPosition([]), 0);
    assert.equal(nextPosition([{ position: 0 }, { position: 1 }]), 2);
    assert.equal(nextPosition([{ position: 3 }, { position: 4 }]), 5);
    // The input is not sorted first, so a gap left by a manual import still gets
    // its next position from the highest one rather than from the length.
    assert.equal(nextPosition([{ position: 9 }, { position: 1 }]), 10);
    // A row with a nonsense position must not be allowed to produce a duplicate.
    assert.equal(nextPosition([{ position: 4 }, { position: "x" }, {}]), 5);
    assert.equal(nextPosition(null), 0);
});

test("a move renumbers to 0..n-1 and leaves the rows that did not move alone", () => {
    const items = [
        { id: "a", position: 0 },
        { id: "b", position: 1 },
        { id: "c", position: 2 }
    ];
    // One step down: the item and the one it passed trade places, and everything
    // after them keeps the number it had. Unchanged rows come back as the SAME
    // objects, not copies with a new date — which is how the service can tell
    // which rows it has to write.
    const down = moveItem(items, "a", 1);
    assert.deepEqual(down.map(x => x.id), ["b", "a", "c"]);
    assert.deepEqual(down.map(x => x.position), [0, 1, 2]);
    assert.notEqual(down[0], items[1], "b really did change place");
    assert.equal(down[2], items[2], "c did not move and must not be rewritten");
    // And the originals are untouched: moveItem is pure.
    assert.deepEqual(items.map(x => [x.id, x.position]), [["a", 0], ["b", 1], ["c", 2]]);

    // The other end, and the whole way across.
    assert.deepEqual(moveItem(items, "c", 0).map(x => x.id), ["c", "a", "b"]);
    // A move to a position already occupied is a swap, not a duplicate.
    assert.deepEqual(moveItem(items, "a", 2).map(x => x.id), ["b", "c", "a"]);
    // Every result is a closed 0..n-1, whatever the target was.
    for (const to of [0, 1, 2, -5, 99, 1.5, null]) {
        assert.deepEqual(moveItem(items, "a", to).map(x => x.position), [0, 1, 2]);
    }
});

test("a move to an impossible place is a no-op, not an error", () => {
    // "Move up" on the first row and "move down" on the last are disabled in the
    // UI, but a stale render can still produce one, and it must come back as a
    // well-formed order rather than throw at the screen.
    const items = [{ id: "a", position: 0 }, { id: "b", position: 1 }];
    // Out of range either side is clamped to the end of the list.
    assert.deepEqual(moveItem(items, "a", -5).map(x => x.id), ["a", "b"]);
    assert.deepEqual(moveItem(items, "a", 99).map(x => x.id), ["b", "a"]);
    // Not a position at all means "leave it where it is", not "position 0".
    for (const to of [null, undefined, 1.5, "1"]) {
        assert.deepEqual(moveItem(items, "a", to).map(x => x.id), ["a", "b"]);
        assert.deepEqual(moveItem(items, "a", to).map(x => x.position), [0, 1]);
    }
    // An item that is not on this page leaves the order alone.
    assert.deepEqual(moveItem(items, "zz", 0).map(x => x.id), ["a", "b"]);
    assert.deepEqual(moveItem([], "a", 0), []);
});

test("a move closes the gap, so the next add still lands at the end", () => {
    // The reason positions are a gapless index rather than a fractional one: a
    // hole in the list has no defined "last", so the next appended item would
    // land inside the hole and appear in the wrong place.
    const items = [
        { id: "a", position: 0 },
        { id: "b", position: 1 },
        { id: "c", position: 2 }
    ];
    const moved = moveItem(items, "a", 2);
    assert.deepEqual(moved.map(x => x.position), [0, 1, 2]);
    assert.equal(nextPosition(moved), 3);
});

// -------------------------------------------------------------------- import

test("assertPageRecords accepts a real set and refuses a broken one", () => {
    const ok = [
        { id: "p1", title: "Flat", description: "the move", createdAt: NOW, updatedAt: NOW },
        { id: "p2", title: null, description: null, createdAt: NOW, updatedAt: NOW }
    ];
    assert.equal(assertPageRecords(ok), true);
    assert.equal(assertPageRecords([]), true);

    const bad = [
        { id: "", title: "T", createdAt: NOW, updatedAt: NOW },
        { id: "p1", title: 7, createdAt: NOW, updatedAt: NOW },
        { id: "p1", title: "a\nb", createdAt: NOW, updatedAt: NOW },
        { id: "p1", title: "x".repeat(MAX_TITLE + 1), createdAt: NOW, updatedAt: NOW },
        { id: "p1", description: 7, createdAt: NOW, updatedAt: NOW },
        { id: "p1", description: "x".repeat(MAX_NOTE + 1), createdAt: NOW, updatedAt: NOW },
        { id: "p1", createdAt: 0, updatedAt: NOW },
        { id: "p1", createdAt: NOW, updatedAt: "now" },
        "not a record"
    ];
    for (const record of bad) {
        assert.throws(
            () => assertPageRecords([record]),
            e => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "pages",
            `must refuse ${JSON.stringify(record)}`
        );
    }
    assert.throws(() => assertPageRecords(null), ImportError);
});

test("assertPageItemRecords accepts a real set and refuses a broken one", () => {
    const ok = [
        { id: "i1", pageId: "p1", type: "heading", position: 0, content: { text: "Bills" }, createdAt: NOW, updatedAt: NOW },
        { id: "i2", pageId: "p1", type: "divider", position: 1, content: {}, createdAt: NOW, updatedAt: NOW },
        { id: "i3", pageId: "p1", type: "task", position: 2, content: { taskId: "t1" }, createdAt: NOW, updatedAt: NOW }
    ];
    assert.equal(assertPageItemRecords(ok), true);
    assert.equal(assertPageItemRecords([]), true);

    const base = { pageId: "p1", position: 0, createdAt: NOW, updatedAt: NOW };
    const bad = [
        { ...base, id: "", type: "text", content: { text: "a" } },
        { ...base, id: "i1", type: "bookmark", content: { text: "a" } },
        // An item with no page can never be reached by any screen.
        { ...base, id: "i1", pageId: "", type: "text", content: { text: "a" } },
        { ...base, id: "i1", pageId: null, type: "text", content: { text: "a" } },
        // The position is a non-negative integer, and a missing one is not the
        // same as 0: the page's order is a stored fact, not a default.
        { ...base, id: "i1", type: "text", content: { text: "a" }, position: -1 },
        { ...base, id: "i1", type: "text", content: { text: "a" }, position: null },
        { ...base, id: "i1", type: "text", content: { text: "a" }, position: 1.5 },
        // Exactly the keys the kind allows, and no others: a carried-over id from
        // a previous kind is how a link would silently start pointing somewhere
        // the user never chose.
        { ...base, id: "i1", type: "task", content: { sessionId: "s1" } },
        { ...base, id: "i1", type: "task", content: { taskId: "t1", sessionId: "s1" } },
        { ...base, id: "i1", type: "task", content: { taskId: "" } },
        { ...base, id: "i1", type: "task", content: { taskId: 7 } },
        { ...base, id: "i1", type: "divider", content: { text: "x" } },
        { ...base, id: "i1", type: "text", content: {} },
        { ...base, id: "i1", type: "text", content: { text: 7 } },
        { ...base, id: "i1", type: "heading", content: { text: "a\nb" } },
        { ...base, id: "i1", type: "heading", content: { text: "x".repeat(MAX_TITLE + 1) } },
        { ...base, id: "i1", type: "text", content: { text: "x".repeat(MAX_PAGE_TEXT + 1) } },
        { ...base, id: "i1", type: "text", content: null },
        { ...base, id: "i1", type: "text", content: "a", createdAt: 0, updatedAt: NOW },
        "not a record"
    ];
    for (const record of bad) {
        assert.throws(
            () => assertPageItemRecords([record]),
            e => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "pageItems",
            `must refuse ${JSON.stringify(record)}`
        );
    }
    assert.throws(() => assertPageItemRecords(null), ImportError);
});

test("a backup without Pages still imports, and one with it is still a v1 backup", () => {
    const base = {
        app: "task-timer",
        version: 1,
        tasks: [],
        sessions: [],
        events: [],
        settings: {}
    };
    // Additive, exactly like finance and Later: the format version does not move,
    // so an old file is readable and a new one is still readable by an old build
    // that simply ignores the key.
    assert.equal(assertImportShape(base), true);
    assert.equal(assertImportShape({ ...base, pages: [], pageItems: [] }), true);
    assert.equal(assertImportShape({
        ...base,
        pages: [{ id: "p1", title: "P", description: null, createdAt: NOW, updatedAt: NOW }]
    }), true);
    assert.throws(
        () => assertImportShape({ ...base, pages: [{ id: "" }] }),
        e => e instanceof ImportError && e.detail === "pages"
    );
    // Either key alone is enough to start checking that side.
    assert.throws(
        () => assertImportShape({ ...base, pageItems: [{ id: "i1", pageId: "p1", type: "nope" }] }),
        e => e instanceof ImportError && e.detail === "pageItems"
    );
});

// ----------------------------------------------------------------- migrations

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

const indexNames = (db, store) => [...db.stores.get(store).indexes];

test("the Pages migration is still 7, and the version has moved past it", () => {
    // Frozen, like every other migration. Migrations 8 (the attachment bytes) and
    // 9 (the Kanban board) came after it and are additive, which is the only
    // reason this is true.
    assert.ok(DB_VERSION > 7, `DB_VERSION should have moved past 7, is ${DB_VERSION}`);
    assert.equal(typeof migrations[7], "function");
});

test("migration 7 adds two stores and one index", () => {
    const db = stubDb();
    migrations[7](db);
    // Page and item are SEPARATE stores, so a reorder and a text edit are two
    // records and last-write-wins settles them independently: a rename on one
    // device cannot clobber an edit made on another.
    assert.deepEqual([...db.stores.keys()], ["pages", "pageItems"]);
    // The list is read whole and sorted in JS, so an index would be a promise no
    // read path uses.
    assert.deepEqual(indexNames(db, "pages"), []);
    // One index, for one page's items: `byPage` reads them and `deleteByPage`
    // takes them away with the page.
    assert.deepEqual(indexNames(db, "pageItems"), ["pageId"]);
    // Nothing is seeded — an empty store is a valid state, and a user who never
    // opens Pages should not have rows in it.
    assert.deepEqual(db.stores.get("pages").rows, []);
    assert.deepEqual(db.stores.get("pageItems").rows, []);
});

test("migration 7 is additive: an existing database is left exactly as it was", () => {
    // The upgrade path that matters: 1..6 already ran on this device and will
    // never run again, so 7 is the only chance to add the stores — and it must
    // not need to touch anything else to do it.
    const db = stubDb();
    for (let v = 1; v <= 6; v++) migrations[v](db);
    const before = [...db.stores.keys()];
    const late = indexNames(db, "later");

    migrations[7](db);

    assert.deepEqual([...db.stores.keys()], [...before, "pages", "pageItems"]);
    // Every store that was already there keeps exactly the indexes it had, and
    // the Later store in particular is not reopened and rebuilt.
    assert.deepEqual(indexNames(db, "later"), late);
    assert.deepEqual(db.stores.get("later").rows, []);
});

test("migration 7 cannot be run twice, and says so", () => {
    // A migration is frozen: re-running it would throw on createObjectStore, and
    // a database that is somehow at version 7 twice must fail loudly rather than
    // silently end up with one store or two.
    const db = stubDb();
    migrations[7](db);
    assert.throws(() => migrations[7](db));
});

// -------------------------------------------------------------- the services

// Everything below runs the real service layer on the in-memory IndexedDB, so the
// cascade, the outbox and the quota are exercised as the app runs them and not as
// a description of them says they are.
//
// The stub is installed ONCE, not per test: db.js caches its open connection in a
// module-level promise, so re-installing would hand the services a database they
// have already been given. What each test needs is an empty one, and wipe() is
// that — the schema and the connection stay, the records go.
let harness = null;

async function withService() {
    if (!harness) {
        const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
        const idb = installFakeIndexedDB();
        // Open it once here so the very first test that touches a service does
        // not have to be the one that pays for the migration.
        const { openDb } = await import("../app/js/data/db.js");
        await openDb();
        const { pageService } = await import("../app/js/services/page-service.js");
        const { syncService } = await import("../app/js/services/sync-service.js");
        harness = { idb, pageService, syncService };
    }
    harness.idb.wipe();
    return harness;
}

const outbox = async () => {
    const { withTx, req } = await import("../app/js/data/db.js");
    return withTx(["outbox"], "readonly", r => req(r.outbox.getAll()));
};

test("a page is created untitled, renamed, and read back as one record", async () => {
    const { pageService, syncService } = await withService();

    const created = await pageService.create({});
    assert.equal(created.title, null);
    assert.equal(created.description, null);
    assert.equal(created.createdAt, created.updatedAt);
    assert.deepEqual((await pageService.list()).map(x => x.id), [created.id]);

    const renamed = await pageService.update(created.id, { title: "Moving flat", description: "what is left" });
    assert.equal(renamed.title, "Moving flat");
    assert.equal(renamed.description, "what is left");
    assert.ok(renamed.updatedAt >= created.updatedAt);
    // One record, not two: a rename must not leave a stale copy behind.
    assert.equal((await pageService.list()).length, 1);

    // An update of nothing still bumps updatedAt — the timestamp is the whole
    // last-write-wins rule, so a no-op has to move it or the write is invisible
    // to the other device.
    const noop = await pageService.update(created.id, {});
    assert.ok(noop.updatedAt >= renamed.updatedAt);

    await syncService.clearOutbox();
});

test("a page with no tasks, sessions or money at all still works", async () => {
    // The feature has to be useful on its own: words and dividers need nothing
    // else to exist, and the pointers a page cannot have yet are simply not
    // there.
    const { pageService, syncService } = await withService();

    const page = await pageService.create({ title: "Empty account" });
    for (const type of ["heading", "text", "divider"]) {
        await pageService.addItem(page.id, { type, content: { text: "" } });
    }
    const items = await pageService.items(page.id);
    assert.deepEqual(items.map(x => x.type), ["heading", "text", "divider"]);
    assert.deepEqual(items.map(x => x.position), [0, 1, 2]);
    // Nothing on this page points at anything, so nothing has to be resolved.
    assert.equal(items.filter(x => PAGE_ITEM_TARGETS[x.type]).length, 0);

    await syncService.clearOutbox();
});

test("items are appended in the order they were added", async () => {
    const { pageService, syncService } = await withService();
    const page = await pageService.create({ title: "P" });

    const ids = [];
    for (const type of ["heading", "text", "divider", "heading"]) {
        const item = await pageService.addItem(page.id, { type, content: { text: type === "divider" ? undefined : type } });
        ids.push(item.id);
    }
    const items = await pageService.items(page.id);
    assert.deepEqual(items.map(x => x.id), ids);
    assert.deepEqual(items.map(x => x.position), [0, 1, 2, 3]);

    // A second page's items are its own: the pageId index answers both reads.
    const other = await pageService.create({ title: "Q" });
    await pageService.addItem(other.id, { type: "divider" });
    assert.equal((await pageService.items(other.id)).length, 1);
    assert.equal((await pageService.items(page.id)).length, 4);

    await syncService.clearOutbox();
});

test("a text line saves its own words and cannot change its kind or its place", async () => {
    const { pageService, syncService } = await withService();
    const page = await pageService.create({ title: "P" });
    const a = await pageService.addItem(page.id, { type: "text", content: { text: "one" } });
    const b = await pageService.addItem(page.id, { type: "heading", content: { text: "two" } });

    const saved = await pageService.updateItem(page.id, a.id, { content: { text: "one and a half" } });
    assert.equal(saved.content.text, "one and a half");

    // The kind is what the body is, and the position belongs to a reorder. If an
    // edit could set either, then a text save would silently reorder the page.
    const forced = await pageService.updateItem(page.id, a.id, { type: "divider", position: 99 });
    assert.equal(forced.type, "text");
    assert.equal(forced.position, 0);
    // And the neighbour did not move either.
    assert.equal((await pageService.items(page.id))[1].position, b.position);

    await syncService.clearOutbox();
});

test("reordering renumbers the page and queues only the rows that moved", async () => {
    const { idb, pageService, syncService } = await withService();
    const page = await pageService.create({ title: "P" });
    const ids = [];
    for (const label of ["a", "b", "c", "d"]) {
        ids.push((await pageService.addItem(page.id, { type: "text", content: { text: label } })).id);
    }
    await syncService.clearOutbox();

    // One step down one place. With a gapless index the item and the one it passed
    // trade numbers and the two after them keep theirs — so TWO of the four rows
    // are written, and a reorder never rewrites the whole page on every device
    // that has it.
    idb.resetStats();
    const moved = await pageService.move(page.id, ids[0], 1);
    assert.deepEqual(moved.map(x => x.id), [ids[1], ids[0], ids[2], ids[3]]);
    // Read the page's items through the index, write the two that moved, and
    // queue them: three transactions, and no fourth for each record in between.
    assert.equal(idb.stats().transactions, 3);

    const queued = (await outbox()).filter(x => x.key.startsWith("pageItem:"));
    assert.equal(queued.length, 2, `a one-step move queued ${queued.length} records`);
    assert.deepEqual(queued.map(x => x.data.id).sort(), [ids[0], ids[1]].sort());

    // The other end, and the worst case. Moving the LAST item to the front
    // renumbers every row, because with a gapless index each of them shifts by
    // one. That is the cost of the choice, stated plainly: an up/down step — which
    // is all the editor offers — renumbers two rows however long the page is, and
    // the alternatives (fractional positions, "insert between 3 and 4") each need
    // a second mechanism to keep them from drifting.
    await syncService.clearOutbox();
    await pageService.move(page.id, ids[3], 0);
    const items = await pageService.items(page.id);
    assert.deepEqual(items.map(x => x.id), [ids[3], ids[1], ids[0], ids[2]]);
    assert.deepEqual(items.map(x => x.position), [0, 1, 2, 3]);
    assert.equal((await outbox()).filter(x => x.key.startsWith("pageItem:")).length, 4);

    // A move to where the item already is writes nothing at all — not even a
    // fresh updatedAt, which would be a needless last-write-wins on a record that
    // did not change.
    await syncService.clearOutbox();
    idb.resetStats();
    const before = (await pageService.items(page.id)).map(x => x.updatedAt);
    await pageService.move(page.id, ids[3], 0);
    assert.deepEqual(await outbox(), []);
    assert.deepEqual((await pageService.items(page.id)).map(x => x.updatedAt), before);

    await syncService.clearOutbox();
});

test("moving to where the item already is leaves the page untouched", async () => {
    const { pageService, syncService } = await withService();
    const page = await pageService.create({ title: "P" });
    const a = await pageService.addItem(page.id, { type: "text", content: { text: "a" } });
    await pageService.addItem(page.id, { type: "text", content: { text: "b" } });

    // A stale render can still produce this: the row's up/down controls were
    // built against an order that has since changed. It must come back as a
    // well-formed order rather than throw at the screen.
    for (const to of [-1, 0, 1, 99]) {
        await assert.doesNotReject(() => pageService.move(page.id, a.id, to));
    }
    assert.deepEqual((await pageService.items(page.id)).map(x => x.position), [0, 1]);

    await syncService.clearOutbox();
});

test("an item cannot be edited or removed through the wrong page", async () => {
    // The page check is not ceremony: a row action built from a stale render must
    // not be able to change or take away a line on a different page.
    const { pageService, syncService } = await withService();
    const a = await pageService.create({ title: "A" });
    const b = await pageService.create({ title: "B" });
    const item = await pageService.addItem(a.id, { type: "text", content: { text: "x" } });

    await assert.rejects(
        () => pageService.updateItem(b.id, item.id, { content: { text: "y" } }),
        e => e instanceof NotFoundError
    );
    await assert.rejects(
        () => pageService.removeItem(b.id, item.id),
        e => e instanceof NotFoundError
    );
    // A move addressed to the wrong page is a no-op rather than a rejection: the
    // item is not in that page's order, so there is nothing to renumber and the
    // item on its own page is untouched. Either way it cannot cross over.
    await assert.doesNotReject(() => pageService.move(b.id, item.id, 0));
    assert.deepEqual(await pageService.items(b.id), []);

    // Still there, untouched.
    assert.equal((await pageService.items(a.id))[0].content.text, "x");

    await syncService.clearOutbox();
});

test("an item cannot be added to a page that is not there", async () => {
    // Otherwise a line could be written to a page that will not be there to show
    // it, and nothing would ever surface it again.
    const { pageService, syncService } = await withService();
    await assert.rejects(
        () => pageService.addItem("nope", { type: "text", content: { text: "x" } }),
        e => e instanceof NotFoundError
    );
    await assert.rejects(() => pageService.get("nope"), e => e instanceof NotFoundError);

    await syncService.clearOutbox();
});

test("removing a line tombstones it, and it stays gone", async () => {
    const { pageService, syncService } = await withService();
    const page = await pageService.create({ title: "P" });
    const keep = await pageService.addItem(page.id, { type: "text", content: { text: "keep" } });
    const drop = await pageService.addItem(page.id, { type: "text", content: { text: "drop" } });

    await pageService.removeItem(page.id, drop.id);
    assert.deepEqual((await pageService.items(page.id)).map(x => x.id), [keep.id]);

    // A tombstone, like every other delete: without it the other devices never
    // learn the line is gone and would push it straight back.
    const queued = (await outbox()).find(x => x.key === `pageItem:${drop.id}`);
    assert.ok(queued, "a removed line must leave a tombstone in the outbox");
    assert.equal(queued.op, "delete");

    await syncService.clearOutbox();
});

test("removing a page takes its items with it, in one outbox batch", async () => {
    const { pageService, syncService } = await withService();
    const page = await pageService.create({ title: "P" });
    const other = await pageService.create({ title: "Q" });
    const itemIds = [];
    for (const label of ["a", "b", "c"]) {
        itemIds.push((await pageService.addItem(page.id, { type: "text", content: { text: label } })).id);
    }
    const survivor = await pageService.addItem(other.id, { type: "text", content: { text: "keep" } });

    await syncService.clearOutbox();
    await pageService.remove(page.id);

    assert.deepEqual((await pageService.list()).map(x => x.id), [other.id]);
    assert.deepEqual(await pageService.items(page.id), []);
    // The other page's line is untouched — the cascade is by page, not by table.
    assert.deepEqual((await pageService.items(other.id)).map(x => x.id), [survivor.id]);

    // Four tombstones, in one batch. An item whose page is gone cannot be reached
    // by any screen, so leaving them behind would be invisible data that still
    // syncs — and a reordering device would resurrect them.
    const queued = await outbox();
    assert.equal(queued.length, 4, `expected 4 tombstones, got ${queued.length}`);
    assert.equal(queued.filter(x => x.key === `page:${page.id}` && x.op === "delete").length, 1);
    for (const id of itemIds) {
        assert.equal(queued.filter(x => x.key === `pageItem:${id}` && x.op === "delete").length, 1);
    }
    assert.equal(queued.filter(x => x.key === `pageItem:${survivor.id}`).length, 0);

    await syncService.clearOutbox();
});

test("the page quota is the number of pages, and it is checked in the write", async () => {
    const { pageService, syncService } = await withService();
    const { withTx, req } = await import("../app/js/data/db.js");

    // Seeded straight to the cap so the test is not a thousand writes long; the
    // guard is the same whichever side of the line the count is on.
    await withTx(["pages"], "readwrite", async r => {
        for (let i = 0; i < MAX_PAGES; i++) {
            await req(r.pages.put({ id: `p${i}`, title: null, description: null, createdAt: NOW, updatedAt: NOW }));
        }
    });
    assert.equal(await pageService.count(), MAX_PAGES);

    await assert.rejects(
        () => pageService.create({ title: "one too many" }),
        e => e instanceof ValidationError && e.field === "pages" && e.code === "pages_limit"
    );
    assert.equal(await pageService.count(), MAX_PAGES);

    await syncService.clearOutbox();
});

test("the item quota is across every page, and is a different message", async () => {
    const { pageService, syncService } = await withService();
    const { withTx, req } = await import("../app/js/data/db.js");

    const page = await pageService.create({ title: "P" });
    await withTx(["pageItems"], "readwrite", async r => {
        for (let i = 0; i < MAX_PAGE_ITEMS; i++) {
            await req(r.pageItems.put({
                id: `i${i}`, pageId: "other", type: "divider", position: i,
                content: {}, createdAt: NOW, updatedAt: NOW
            }));
        }
    });

    // A user who hit this deserves to be told WHICH cap it was: "too many pages"
    // is about how many things they keep filed, "too many lines" is about one of
    // them getting long.
    await assert.rejects(
        () => pageService.addItem(page.id, { type: "divider" }),
        e => e instanceof ValidationError && e.field === "pageItems" && e.code === "page_items_limit"
    );

    await syncService.clearOutbox();
});

test("everything a page writes is queued for sync, and nothing else is", async () => {
    const { pageService, syncService } = await withService();

    const page = await pageService.create({ title: "P" });
    const item = await pageService.addItem(page.id, { type: "task", content: { taskId: "t1" } });
    // A pointer's body cannot be edited into something else, so the only thing
    // that ever changes about a linked line is which record it points at.
    await assert.rejects(
        () => pageService.updateItem(page.id, item.id, { content: { text: "renamed" } }),
        e => e instanceof ValidationError && e.field === "content"
    );
    await pageService.updateItem(page.id, item.id, { content: { taskId: "t2" } });
    assert.equal((await pageService.items(page.id))[0].content.taskId, "t2");
    await pageService.removeItem(page.id, item.id);

    const queued = await outbox();
    assert.deepEqual(new Set(queued.map(x => x.key)), new Set([
        `page:${page.id}`,
        `pageItem:${item.id}`
    ]));
    // Both are the same generic protocol as every other record — { type, id, op,
    // data, updatedAt } in the existing outbox, keyed by type and id — which is
    // why pages needed no transport, no endpoint and no server-side logic of their
    // own. And because the outbox is keyed, the last write for a record is the
    // only one that waits to be pushed: the line's upserts are superseded by its
    // tombstone rather than queued three times.
    assert.deepEqual(new Set(queued.map(x => x.type)), new Set(["page", "pageItem"]));
    assert.equal(queued.find(x => x.key === `pageItem:${item.id}`).op, "delete");
    assert.equal(queued.find(x => x.key === `page:${page.id}`).op, "upsert");

    await syncService.clearOutbox();
});
