// Attachments, end to end: the ceilings, the pure logic, the schema, and the
// service layer running on the fake IndexedDB.
//
// The feature is a split, and most of what follows is that split asked from
// different angles:
//
//   the DESCRIPTION  — an `attachments` array on the note record. Ordinary JSON,
//                      so it syncs, so a backup carries it, so another device can
//                      say what the note holds;
//   the BYTES        — the `noteMedia` store, on this device only.
//
// The invariant every test here is really about: a description never points at
// bytes that are not there. The other way round is an attachment the user can
// see and cannot open, and can only get rid of by deleting the note.

import test from "node:test";
import assert from "node:assert/strict";

import {
    ATTACHMENT_KINDS,
    MAX_ATTACHMENTS_PER_NOTE,
    MAX_AUDIO_BYTES,
    MAX_AUDIO_MS,
    MAX_DOCUMENT_BYTES,
    MAX_MEDIA_BYTES,
    MAX_PHOTOS_PER_NOTE,
    MAX_PHOTO_BYTES,
    MAX_VIDEO_BYTES,
    MAX_VIDEO_MS,
    MIN_AUDIO_MS,
    attachmentList,
    bytesOf,
    countOf,
    defaultName,
    displayName,
    extensionOf,
    kindForFile,
    newDescriptor,
    roomFor,
    summarise
} from "../app/js/domain/attachments.js";
import {
    validateLaterInput,
    validateAttachments,
    assertLaterRecords,
    assertImportShape,
    MAX_TITLE
} from "../app/js/domain/validation.js";
import { laterLabel, createLaterItem } from "../app/js/domain/later.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Source scanning, for the two files whose bug was in a list's OWNERSHIP rather
// than in any function's return value. The rest of this file imports the modules
// and calls them; there is no DOM here, so the parts of the UI that decide which
// array a blob goes into are read instead. Comments are stripped, because several
// of them quote the very code these look for.
const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
import { migrations } from "../app/js/data/migrations.js";
import { DB_VERSION } from "../app/js/config.js";
import { ValidationError, NotFoundError, ImportError } from "../app/js/domain/errors.js";

const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();
const MiB = 1024 * 1024;

const rejects = (input, field, code) => assert.throws(
    () => validateAttachments(input),
    e => e instanceof ValidationError && e.field === field && e.code === code,
    `${field}/${code} expected`
);

/** A description that is valid, so a test can break exactly one thing about it. */
const photo = (over = {}) => ({
    id: over.id ?? "m1",
    kind: "photo",
    name: "IMG_0042.jpg",
    type: "image/jpeg",
    size: 300 * 1024,
    durationMs: null,
    width: 1600,
    height: 1200,
    createdAt: NOW,
    ...over
});

const audio = (over = {}) => ({
    id: over.id ?? "a1",
    kind: "audio",
    name: "Voice memo",
    type: "audio/webm",
    size: 2 * MiB,
    durationMs: 60_000,
    createdAt: NOW,
    ...over
});

const video = (over = {}) => ({
    id: over.id ?? "v1",
    kind: "video",
    name: "Clip",
    type: "video/webm",
    size: 3 * MiB,
    durationMs: 20_000,
    createdAt: NOW,
    ...over
});

const document = (over = {}) => ({
    id: over.id ?? "d1",
    kind: "document",
    name: "receipt.pdf",
    type: "application/pdf",
    size: 400 * 1024,
    createdAt: NOW,
    ...over
});

// ----------------------------------------------------------------- the shape

test("the ceilings are the ones that were asked for", () => {
    // These numbers are the feature. A test that re-states them is worth having
    // precisely because they are also written down in the recorder, in the form's
    // button state and in three places in strings.js.
    assert.equal(MAX_PHOTOS_PER_NOTE, 5);
    assert.equal(MIN_AUDIO_MS, 5000);
    assert.equal(MAX_AUDIO_MS, 30 * 60 * 1000);
    assert.equal(MAX_VIDEO_MS, 30000);
    assert.equal(MAX_VIDEO_BYTES, 5 * MiB);
    assert.equal(MAX_DOCUMENT_BYTES, 3 * MiB);
});

test("every kind has a name, an icon-worthy identity and a byte ceiling", () => {
    assert.deepEqual([...ATTACHMENT_KINDS], ["photo", "audio", "video", "document"]);
    // Audio is the one kind with a duration pair and no per-file byte ceiling in
    // the LIMITS table: what the user asked for was a length, and at a voice
    // bitrate thirty minutes is a few megabytes. The total is still bounded.
    assert.equal(countOf([audio(), audio({ id: "a2" })], "audio"), 2);
    assert.ok(MAX_AUDIO_BYTES > 0);
    assert.ok(MAX_AUDIO_BYTES < MAX_MEDIA_BYTES, "a whole note is bounded, not just one file");
});

// ---------------------------------------------------------------- classifying

test("a file is classified by its type, then by its extension", () => {
    assert.equal(kindForFile({ type: "image/jpeg", name: "a.jpg" }), "photo");
    assert.equal(kindForFile({ type: "video/mp4", name: "a.mp4" }), "video");
    assert.equal(kindForFile({ type: "audio/webm;codecs=opus", name: "a.webm" }), "audio");
    // A phone's Files app often sends no type at all, or a useless one.
    assert.equal(kindForFile({ type: "", name: "scan.PDF" }), "document");
    assert.equal(kindForFile({ type: "application/octet-stream", name: "notes.md" }), "document");
    assert.equal(kindForFile({ type: "image/heic", name: "IMG.heic" }), "photo");
    // And a type it does not know, with no extension, is nothing.
    assert.equal(kindForFile({ type: "", name: "LICENSE" }), null);
    assert.equal(kindForFile({ type: "application/x-msdownload", name: "setup.exe" }), null);
    assert.equal(kindForFile(null), null);
    // The two types a browser could be made to EXECUTE in this origin are not
    // documents and are not images-for-us, so nothing routes them anywhere.
    assert.equal(kindForFile({ type: "text/html", name: "a.html" }), null);
    assert.equal(kindForFile({ type: "image/svg+xml", name: "a.svg" }), null);
});

test("extensionOf and displayName are about what a person can read", () => {
    assert.equal(extensionOf("a.JPG"), "jpg");
    assert.equal(extensionOf("a.tar.gz"), "gz");
    assert.equal(extensionOf("no-extension"), "");
    assert.equal(extensionOf(".hidden"), "", "a dotfile is a name, not an extension");
    assert.equal(extensionOf("trailing."), "");
    assert.equal(extensionOf(null), "");

    assert.equal(displayName("IMG_0042.jpg", "photo"), "IMG_0042.jpg");
    // A long name is cut, and the extension is kept: it is what tells two files
    // with the same stem apart at the end of a truncated row.
    const long = displayName("Screen Recording 2026-01-01 at 10.15.03.mp4", "video");
    assert.ok(long.length <= 120, `a name is bounded, got ${long.length}`);
    assert.ok(long.endsWith(".mp4"), `the extension survives, got "${long}"`);
    // A name the sender left empty still has something to show.
    assert.equal(defaultName("photo"), "Photo");
    assert.equal(displayName("", "audio"), "Recording");
});

// ---------------------------------------------------------------- the ceilings

test("a note may hold five photographs and not six", () => {
    const five = Array.from({ length: 5 }, (_, i) => photo({ id: `m${i}` }));
    assert.equal(validateAttachments(five).length, 5);
    rejects([...five, photo({ id: "m5" })], "attachments", "photos_limit");
    // …and the count is per kind, not per note: twenty documents is allowed, and
    // five of them may be photographs as well.
    const docs = Array.from({ length: 15 }, (_, i) => document({ id: `d${i}` }));
    assert.equal(validateAttachments([...five, ...docs]).length, 20);
    rejects([...five, ...docs, document({ id: "d15" })], "attachments", "attachments_limit");
    assert.equal(roomFor(five, "photo"), 0);
    assert.equal(roomFor(five, "document"), MAX_ATTACHMENTS_PER_NOTE - 5);
});

test("a voice memo is between five seconds and thirty minutes", () => {
    assert.equal(validateAttachments([audio({ durationMs: MIN_AUDIO_MS })]).length, 1);
    assert.equal(validateAttachments([audio({ durationMs: MAX_AUDIO_MS })]).length, 1);
    rejects([audio({ durationMs: MIN_AUDIO_MS - 1 })], "attachments", "audio_too_short");
    rejects([audio({ durationMs: MAX_AUDIO_MS + 1 })], "attachments", "audio_too_long");
    // A duration the app could not read is not a reason to refuse: the file is
    // kept and simply has no length shown. Refusing it would lose a recording
    // because one engine reported no metadata.
    assert.equal(validateAttachments([audio({ durationMs: null })])[0].durationMs, null);
});

test("a video is thirty seconds and five megabytes", () => {
    assert.equal(validateAttachments([video({ durationMs: MAX_VIDEO_MS })])[0].durationMs, MAX_VIDEO_MS);
    rejects([video({ durationMs: MAX_VIDEO_MS + 1 })], "attachments", "video_too_long");
    assert.equal(validateAttachments([video({ size: MAX_VIDEO_BYTES })])[0].size, MAX_VIDEO_BYTES);
    rejects([video({ size: MAX_VIDEO_BYTES + 1 })], "attachments", "video_too_large");
    // A video's duration is optional, unlike audio's: a clip whose length could
    // not be read is still a clip.
    assert.equal(validateAttachments([video({ durationMs: null })])[0].durationMs, null);
});

test("a document is three megabytes", () => {
    assert.equal(validateAttachments([document({ size: MAX_DOCUMENT_BYTES })])[0].size, MAX_DOCUMENT_BYTES);
    rejects([document({ size: MAX_DOCUMENT_BYTES + 1 })], "attachments", "document_too_large");
    // A photograph's ceiling is on what ARRIVES, not what is kept: the downscale
    // is what holds the stored size down, and refusing a 12 MB original would be
    // refusing the phone's own camera.
    assert.equal(validateAttachments([photo({ size: MAX_PHOTO_BYTES })])[0].size, MAX_PHOTO_BYTES);
    rejects([photo({ size: MAX_PHOTO_BYTES + 1 })], "attachments", "photo_too_large");
});

test("a whole note is bounded in bytes as well as in count", () => {
    const heavy = Array.from({ length: 20 }, (_, i) => document({
        id: `d${i}`, size: Math.floor(MAX_MEDIA_BYTES / 19) + 1
    }));
    rejects(heavy, "attachments", "attachments_too_large");
    // The total is computed from the DESCRIPTORS' own sizes, so the check never
    // has to read a blob to answer it.
    assert.equal(bytesOf([photo(), video(), document()]), 300 * 1024 + 3 * MiB + 400 * 1024);
});

test("a malformed description is refused rather than stored", () => {
    rejects([null], "attachments", "invalid_type");
    rejects([[]], "attachments", "invalid_type");
    rejects([photo({ id: "" })], "attachments", "invalid_type");
    rejects([photo({ id: "x".repeat(129) })], "attachments", "invalid_type");
    rejects([photo({ kind: "spreadsheet" })], "attachments", "attachment_kind");
    rejects([photo({ name: "  " })], "attachments", "invalid_type");
    rejects([photo({ name: "a".repeat(200) })], "attachments", "invalid_type");
    rejects([photo({ size: -1 })], "attachments", "invalid_type");
    rejects([photo({ size: 1.5 })], "attachments", "invalid_type");
    rejects([photo({ type: "image/jpeg\nX-Evil: 1" })], "attachments", "invalid_type");
    rejects([photo({ durationMs: "long" })], "attachments", "invalid_type");
    // A missing field is not a malformed one: a record written by an older build
    // simply has none, and an additive field has to stay additive.
    assert.equal(validateAttachments([{ id: "m1", kind: "photo", name: "a.jpg", size: 10 }]).length, 1);
    assert.equal(validateAttachments(undefined).length, 0);
    assert.equal(validateAttachments(null).length, 0);
    rejects("not a list", "attachments", "invalid_type");
});

// ----------------------------------------------------------------- ordering

test("attachments read in the order they were added, whatever order they arrive in", () => {
    // The same rule as a Later list: the order is derived from createdAt with the
    // id as the tie-breaker, never stored, because a local array order is not
    // trusted across devices. Two devices that added two photographs in the same
    // millisecond must still agree on which is first.
    const late = photo({ id: "b", createdAt: NOW + 10 });
    const early = photo({ id: "a", createdAt: NOW });
    assert.deepEqual(attachmentList({ attachments: [late, early] }).map(x => x.id), ["a", "b"]);
    // …and a tie is broken by the id, not by array position.
    const one = photo({ id: "zz", createdAt: NOW });
    const two = photo({ id: "aa", createdAt: NOW });
    assert.deepEqual(attachmentList({ attachments: [one, two] }).map(x => x.id), ["aa", "zz"]);
    // A record with no field at all is an empty list, not an error.
    assert.deepEqual(attachmentList({}), []);
    assert.deepEqual(attachmentList({ attachments: "junk" }), []);
    // The blobs are not part of a description, so they are dropped on the way
    // through — this is the function that decides what a backup writes.
    const clean = attachmentList({ attachments: [{ ...photo(), blob: "bytes" }] });
    assert.equal("blob" in clean[0], false);
});

test("summarise counts what is there and invents nothing", () => {
    assert.deepEqual(summarise([photo(), photo({ id: "m2" }), audio(), video()]), [
        { kind: "photo", count: 2 },
        { kind: "audio", count: 1 },
        { kind: "video", count: 1 }
    ]);
    assert.deepEqual(summarise([]), []);
    assert.deepEqual(summarise(null), []);
});

// ----------------------------------------------------------------- the note

test("a note with nothing in it is refused; a note with words or a picture is not", () => {
    assert.throws(
        () => validateLaterInput({ type: "note" }),
        e => e instanceof ValidationError && e.field === "content" && e.code === "required"
    );
    assert.throws(
        () => validateLaterInput({ type: "note", content: "   " }),
        e => e instanceof ValidationError && e.field === "content" && e.code === "required"
    );
    // A note that is three photographs and no words is a note, and refusing it
    // would mean the camera could not be the first thing somebody did.
    const withPhoto = validateLaterInput({ type: "note", content: null, attachments: [photo()] });
    assert.equal(withPhoto.content, null);
    assert.equal(withPhoto.attachments.length, 1);
    // A link is a link whatever else it carries: the url is the row's action, and
    // a photograph is never a substitute for it.
    assert.throws(
        () => validateLaterInput({ type: "link", url: null, attachments: [photo()] }),
        e => e instanceof ValidationError && e.field === "url" && e.code === "required"
    );
});

test("the note record carries the descriptions and nothing else", () => {
    const item = createLaterItem(
        validateLaterInput({ type: "note", content: "look at this", attachments: [photo()] }),
        { now: NOW, id: "l1" }
    );
    assert.equal(item.attachments.length, 1);
    // No blob, and nothing that would serialise one: a record is encrypted JSON
    // and pushed through a 1 MiB request, so a base64 photograph in here is the
    // failure this whole design exists to prevent.
    for (const a of item.attachments) {
        assert.equal("blob" in a, false, "a description carries no bytes");
        assert.equal(JSON.stringify(a).length < 400, true, "a description is a few hundred bytes");
    }
});

test("a note with only attachments still has a label", () => {
    // "Untitled" on every photograph-only note is a worse label than saying what
    // is on the page, and the wording is the caller's — a domain module has no
    // business producing words in either language.
    const item = { type: "note", title: null, content: null, attachments: [photo(), photo({ id: "m2" })] };
    assert.equal(laterLabel(item), null, "with no formatter there is nothing to say");
    assert.equal(laterLabel(item, list => `${list.length} things`), "2 things");
    // The usual fallbacks still win over it: a title, then a host, then the text.
    assert.equal(laterLabel({ ...item, title: "The whiteboard" }, () => "x"), "The whiteboard");
    assert.equal(laterLabel({ ...item, content: "first line\nsecond" }, () => "x"), "first line");
    assert.equal(
        laterLabel({ type: "link", url: "https://www.example.com/a", attachments: [] }, () => "x"),
        "example.com"
    );
    // …and a note with no words AND nothing attached is the empty case again.
    assert.equal(laterLabel({ type: "note", title: null, content: null }, () => "x"), null);
});

// ------------------------------------------------------- records and imports

test("a synced or restored record is held to the same ceilings", () => {
    const base = {
        id: "l1", type: "note", title: null, content: "hi", url: null,
        attachments: [], createdAt: NOW, updatedAt: NOW, completedAt: null
    };
    assert.equal(assertLaterRecords([base]), true);
    // A record with no attachments field at all is every record written before
    // this feature existed, and it is not a failure.
    const { attachments, ...legacy } = base;
    assert.equal(assertLaterRecords([legacy]), true);
    // A note with nothing to show is a record nothing can render.
    assert.throws(
        () => assertLaterRecords([{ ...base, content: null }]),
        e => e instanceof ImportError
    );
    assert.equal(assertLaterRecords([{ ...base, content: null, attachments: [photo()] }]), true);
    // A hostile payload cannot put a 400 MB "photograph" into a backup.
    for (const bad of [
        [photo({ id: "x".repeat(200) })],
        [photo({ kind: "exe" })],
        [photo({ size: 10 ** 12 })],
        Array.from({ length: 6 }, (_, i) => photo({ id: `m${i}` })),
        "not a list"
    ]) {
        assert.throws(
            () => assertLaterRecords([{ ...base, attachments: bad }]),
            e => e instanceof ImportError,
            `a payload with ${JSON.stringify(bad).slice(0, 40)} must not import`
        );
    }
});

test("attachments are additive on the import format, so the version does not move", () => {
    const base = {
        app: "task-timer", version: 1,
        tasks: [], sessions: [], events: [], settings: {}
    };
    // A backup written before attachments existed imports unchanged.
    assert.equal(assertImportShape(base), true);
    const withLater = { ...base, later: [] };
    assert.equal(assertImportShape(withLater), true);
    // …and one that carries them is still a v1 backup.
    assert.equal(assertImportShape({
        ...withLater,
        later: [{
            id: "l1", type: "note", title: null, content: null, url: null,
            attachments: [photo()], createdAt: NOW, updatedAt: NOW, completedAt: null
        }]
    }), true);
    assert.throws(
        () => assertImportShape({
            ...withLater,
            later: [{
                id: "l1", type: "note", title: null, content: "x", url: null,
                attachments: [{ ...photo(), size: 10 ** 9 }], createdAt: NOW, updatedAt: NOW, completedAt: null
            }]
        }),
        e => e instanceof ImportError
    );
});

// ------------------------------------------------------------------- schema

// The real IDBDatabase throws on createObjectStore for a name that exists, and
// that is the whole assertion behind "a migration is frozen": a database at
// version 8 never runs Migration 8 again, and a database that somehow did would
// have to fail rather than quietly end up with the store rebuilt.
function stubDb() {
    const stores = new Map();
    return {
        stores,
        createObjectStore(name, { keyPath }) {
            assert.equal(stores.has(name), false, `${name} must not already exist`);
            const indexes = new Set();
            stores.set(name, { name, keyPath, indexes, rows: [] });
            return {
                keyPath,
                indexNames: { contains: i => indexes.has(i) },
                createIndex: (i) => indexes.add(i),
                put: row => stores.get(name).rows.push(row)
            };
        },
        objectStoreNames: { contains: name => stores.has(name) }
    };
}

test("DB_VERSION has moved past the attachment migration, which is still 8", () => {
    // The point of this test is that migration 8 does not change. DB_VERSION moves
    // on as new stores are added (9 is the Kanban board), so the assertion is that
    // it has GROWN past 8 rather than that it still equals it.
    assert.ok(DB_VERSION > 8, `DB_VERSION should have moved past 8, is ${DB_VERSION}`);
    assert.equal(typeof migrations[8], "function");
    const db = stubDb();
    migrations[8](db);
    assert.deepEqual([...db.stores.keys()], ["noteMedia"]);
    assert.equal(db.stores.get("noteMedia").keyPath, "id");
    // The index is the cascade. A note deleted on ANOTHER device arrives with its
    // attachments already gone from it, so the ids that pointed at those bytes are
    // gone too and only a query from the note can say which blobs are orphaned.
    assert.deepEqual([...db.stores.get("noteMedia").indexes], ["noteId"]);
    // Frozen: re-running it throws, and a database at version 8 never runs it again.
    assert.throws(() => migrations[8](db));
});

// --------------------------------------------------------- the service layer

// Everything below runs the real service layer on the in-memory IndexedDB, so
// the order of the two writes and the cascade are exercised as the app performs
// them rather than as a description of them says it does.
//
// The stub is installed ONCE, not per test: db.js caches its open connection in a
// module-level promise. wipe() is what each test needs — schema and connection
// stay, the records go.
let harness = null;

async function withService() {
    if (!harness) {
        const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
        const idb = installFakeIndexedDB();
        const { openDb } = await import("../app/js/data/db.js");
        await openDb();
        const { laterService } = await import("../app/js/services/later-service.js");
        const { attachmentService } = await import("../app/js/services/attachment-service.js");
        const { syncService } = await import("../app/js/services/sync-service.js");
        harness = { idb, laterService, attachmentService, syncService };
    }
    harness.idb.wipe();
    return harness;
}

function fakeBlob(size, type = "image/jpeg") {
    const body = new Uint8Array(size).fill(7);
    return new Blob([body], { type });
}

const media = async () => {
    const { withTx, req } = await import("../app/js/data/db.js");
    return withTx(["noteMedia"], "readonly", r => req(r.noteMedia.getAll()));
};

const outbox = async () => {
    const { withTx, req } = await import("../app/js/data/db.js");
    return withTx(["outbox"], "readonly", r => req(r.outbox.getAll()));
};

test("adding an attachment writes the bytes and the description, and neither alone", async () => {
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "the whiteboard" });

    const saved = await attachmentService.add(note.id, {
        kind: "photo", name: "IMG_1.jpg", type: "image/jpeg",
        width: 1600, height: 1200, blob: fakeBlob(2048)
    });
    assert.equal(saved.kind, "photo");
    assert.equal(saved.size, 2048, "the size is the blob's, not the caller's word for it");

    // The record describes it…
    const reread = await laterService.get(note.id);
    assert.equal(reread.attachments.length, 1);
    assert.equal(reread.attachments[0].id, saved.id);
    assert.equal("blob" in reread.attachments[0], false);

    // …and the bytes are here, under the same id, on this device.
    const rows = await media();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, saved.id);
    assert.equal(rows[0].noteId, note.id);
    assert.equal(rows[0].blob.size, 2048);
    assert.equal(await attachmentService.blobOf(note.id, saved.id) !== null, true);
});

test("the size the record stores is the size the blob has", async () => {
    // A declared size that disagrees with the bytes is exactly how a per-file
    // ceiling gets bypassed, so the blob is measured and the declaration is not
    // believed.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    const saved = await attachmentService.add(note.id, {
        kind: "document", name: "receipt.pdf", type: "application/pdf",
        size: 1, blob: fakeBlob(MAX_DOCUMENT_BYTES, "application/pdf")
    });
    assert.equal(saved.size, MAX_DOCUMENT_BYTES);
});

test("a commit refuses a pick that breaks a ceiling, before anything is written", async () => {
    // The order inside `commit`: validate the descriptors, then write the bytes,
    // then rewrite the record. A form is open with the message next to the field
    // when this returns, which is the only reason the order is worth stating.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    const six = Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`, kind: "photo", name: `IMG_${i}.jpg`, type: "image/jpeg", blob: fakeBlob(64)
    }));
    await assert.rejects(
        () => attachmentService.commit(note.id, six),
        e => e instanceof ValidationError && e.code === "photos_limit"
    );
    assert.equal((await media()).length, 0, "nothing was written");
    assert.equal((await laterService.get(note.id)).attachments.length, 0, "and the record is untouched");
});

test("a commit writes the bytes before the record that describes them", async () => {
    // The invariant, asserted as an ordering rather than as a comment: if the
    // record write came first and then failed, the user would have an attachment
    // they can see and cannot open, and the only way to get rid of it would be to
    // delete the note. The sweep below is what collects the other failure.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    await attachmentService.commit(note.id, [
        { id: "m1", kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(2048) }
    ]);
    // A staged entry with no blob is an attachment from another device, and it is
    // described without being written — the other way round is the one that is
    // never allowed.
    const remote = await attachmentService.commit(note.id, [
        (await laterService.get(note.id)).attachments[0],
        { id: "m2", kind: "photo", name: "b.jpg", type: "image/jpeg", size: 10 }
    ]);
    assert.equal(remote.length, 2);
    assert.equal((await media()).length, 1, "only the entry that carried bytes wrote any");
    assert.equal(await attachmentService.blobOf(note.id, remote[1].id), null);
    assert.equal(await attachmentService.blobOf(note.id, remote[0].id) !== null, true);
});

test("a commit also collects the bytes of an attachment the form removed", async () => {
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    const two = await attachmentService.commit(note.id, [
        { id: "m1", kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64) },
        { id: "m2", kind: "photo", name: "b.jpg", type: "image/jpeg", blob: fakeBlob(64) }
    ]);
    assert.equal((await media()).length, 2);
    const one = await attachmentService.commit(note.id, [two[0]]);
    assert.equal(one.length, 1);
    assert.equal((await media()).length, 1, "the removed attachment's bytes are gone");
    assert.equal((await media())[0].id, two[0].id);
});

test("removing an attachment takes the description and the bytes", async () => {
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    const saved = await attachmentService.add(note.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    const left = await attachmentService.remove(note.id, saved.id);
    assert.equal(left.length, 0);
    assert.equal((await laterService.get(note.id)).attachments.length, 0);
    assert.equal((await media()).length, 0);
    await assert.rejects(
        () => attachmentService.remove(note.id, saved.id),
        e => e instanceof NotFoundError,
        "removing it twice is a not-found, not a silent success"
    );
});

test("deleting a note takes its bytes with it, in one transaction", async () => {
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    await attachmentService.add(note.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    await laterService.remove(note.id);
    assert.equal((await media()).length, 0,
        "two writes would leave a window in which the note is gone and a photograph is not");
    // …and the other devices hear about it through the ordinary tombstone, not
    // through anything attachment-shaped: a blob is not a record.
    const queued = await outbox();
    assert.deepEqual(queued.map(x => `${x.key}:${x.op}`), ["later:" + note.id + ":delete"]);
});

test("an attachment never reaches the outbox, and the record that carries it does", async () => {
    // A push of base64 would be refused by the server's own 1 MiB ceiling long
    // before it reached a database, so nothing here is enqueued except the record
    // — and what the record carries is a few hundred bytes of description.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    await attachmentService.add(note.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64 * 1024)
    });
    // ONE change, for the record. The outbox is keyed by `type:id`, so the write
    // that added the attachment replaced the one that created the note rather
    // than queueing beside it — which is the behaviour worth asserting, because
    // "an attachment is a second queued change" is exactly the shape that would
    // make a device push the same note twice.
    const queued = await outbox();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].key, `later:${note.id}`);
    assert.equal(queued[0].type, "later", "only the record syncs");
    assert.equal("blob" in (queued[0].data.attachments?.[0] ?? {}), false);
    // A 64 KB photograph went in. What is queued is a few hundred bytes of
    // description, so the 1 MiB request ceiling is nowhere near it.
    assert.ok(JSON.stringify(queued[0].data).length < 1000,
        "what is pushed is a description, not a photograph");
});

test("a blob is only handed to the note that owns it", async () => {
    // An id is a uuid, so asking with the wrong note is a bug rather than an
    // attack — but a media row belonging to a different note is a row a caller
    // must not be handed by asking for the wrong one.
    const { laterService, attachmentService } = await withService();
    const one = await laterService.create({ type: "note", content: "one" });
    const two = await laterService.create({ type: "note", content: "two" });
    const saved = await attachmentService.add(one.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    assert.equal(await attachmentService.blobOf(one.id, saved.id) !== null, true);
    assert.equal(await attachmentService.blobOf(two.id, saved.id), null);
    assert.equal(await attachmentService.blobOf(one.id, "no-such-id"), null);
});

test("the sweep deletes bytes no record describes, and nothing else", async () => {
    // The two ways a row goes stale, neither of which any delete call sees: a
    // note deleted on ANOTHER device arrives with its attachments already gone
    // from it, and a commit interrupted between the two writes leaves bytes
    // nothing mentions. Neither is visible in the app, so the only symptom is
    // storage that never comes back.
    const { laterService, attachmentService } = await withService();
    const kept = await laterService.create({ type: "note", content: "kept" });
    const doomed = await laterService.create({ type: "note", content: "doomed" });
    const orphanNote = await laterService.create({ type: "note", content: "orphan" });
    const onKept = await attachmentService.add(kept.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    await attachmentService.add(doomed.id, {
        kind: "photo", name: "b.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    // A note deleted here takes its own bytes with it, so the orphan has to be
    // created the way the other device would: bytes present, record gone.
    await laterService.remove(doomed.id);
    const { withTx } = await import("../app/js/data/db.js");
    const { localReader } = await import("../app/js/data/stores.js");
    const mediaRepo = localReader("noteMedia");
    await withTx(["noteMedia"], "readwrite", r => mediaRepo(r).put({
        id: "left-behind", noteId: orphanNote.id, blob: fakeBlob(64)
    }));
    // Two rows: the one a live record still describes, and the debris. The note
    // deleted HERE took its own bytes with it — the cascade is the easy case, and
    // `left-behind` is the one that needs the sweep.
    assert.deepEqual((await media()).map(x => x.id).sort(), ["left-behind", onKept.id].sort(),
        "the debris is there to be swept");

    const swept = await attachmentService.sweep();
    assert.equal(swept, 1);
    assert.deepEqual((await media()).map(x => x.id), [onKept.id],
        "the bytes a live record still describes are not touched");
    assert.equal(await attachmentService.sweep(), 0, "a second sweep finds nothing");
    assert.equal(await attachmentService.blobOf(kept.id, onKept.id) !== null, true);
});

test("an attachment for a note that is not there is refused, not stored", async () => {
    // A commit for a note deleted on another device while the form was open is a
    // write into the void, and saying so beats storing bytes nothing points at.
    const { attachmentService } = await withService();
    await assert.rejects(
        () => attachmentService.add("no-such-note", {
            kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
        }),
        e => e instanceof NotFoundError
    );
    assert.equal((await media()).length, 0);
});

test("the whole store can be emptied, which is what frees the phone", async () => {
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    await attachmentService.add(note.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(4096)
    });
    assert.equal(await attachmentService.byteUsage(), 4096);
    assert.equal(await attachmentService.clearAll(), 4096, "it reports what it freed");
    assert.equal((await media()).length, 0);
    // The DESCRIPTIONS survive: the notes still say what they carried, and the
    // other devices still agree. Only the bytes went.
    assert.equal((await laterService.get(note.id)).attachments.length, 1);
    assert.equal(await attachmentService.blobOf(note.id, (await laterService.get(note.id)).attachments[0].id), null);
});

test("a title longer than the note's own limit is still the note's limit", async () => {
    // Nothing about attachments relaxed any other rule on the record; this is the
    // cheapest way to say so, and it would catch a change that widened a shared
    // validator by accident.
    assert.throws(
        () => validateLaterInput({ type: "note", content: "x", title: "a".repeat(MAX_TITLE + 1), attachments: [] }),
        e => e instanceof ValidationError && e.code === "too_long"
    );
});

test("newDescriptor fills the fields a capture cannot know", () => {
    const made = newDescriptor(
        { kind: "video", name: "Clip", type: "video/webm", size: 12, durationMs: 9000 },
        { id: "v9", now: NOW }
    );
    assert.deepEqual(made, {
        id: "v9",
        kind: "video",
        name: "Clip",
        type: "video/webm",
        size: 12,
        durationMs: 9000,
        // A recording has no pixel dimensions and a photograph has no duration,
        // and both are null rather than absent: a description has the same keys
        // whichever kind wrote it.
        width: null,
        height: null,
        createdAt: NOW
    });
    assert.equal(newDescriptor({ kind: "audio" }, { id: "a", now: NOW }).durationMs, null);
});

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

// The file picker is where this feature was silently broken, and both halves of
// what went wrong are testable without a browser — which is the only reason they
// are tested here at all.
//
// WHAT HAPPENED: `pickFiles` listened for `focus` on the window and settled the
// promise 400ms later, unconditionally. On Android and iOS the window regains
// focus as soon as the picker sheet opens, which is long before anybody has
// touched anything, so the promise settled with an EMPTY list, the input was
// removed from the page, and the file the user then chose fired `change` on a
// detached element that had already been settled. No attachment, no error, and
// nothing on screen that said why. The photograph simply did not save.
//
// So the behaviour these assert is not "the picker works" — it is that a focus
// event CANNOT settle a picker on an engine that reports `cancel` itself, and
// that it still can on one that does not.
function withFakeDom({ supportsCancel }) {
    const listeners = new Map();
    const created = [];
    // A record of what the fake was asked to do, so a test can assert the input
    // was actually clicked rather than only that it exists.
    const fired = [];

    const makeInput = () => {
        const el = {
            type: "",
            accept: "",
            multiple: false,
            className: "",
            tabIndex: 0,
            files: [],
            removed: false,
            // Namespaced the same way the window's are, so `fire("input", …)`
            // reaches them: without the prefix they were stored under a bare
            // "change" and the test hung on a promise nothing could settle.
            addEventListener(type, fn) {
                const key = `input:${type}`;
                listeners.set(key, [...(listeners.get(key) ?? []), fn]);
            },
            remove() { el.removed = true; },
            click() { fired.push("click"); }
        };
        created.push(el);
        return el;
    };

    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        HTMLInputElement: globalThis.HTMLInputElement
    };

    const proto = supportsCancel ? { cancel: null } : {};
    globalThis.HTMLInputElement = function HTMLInputElement() {};
    globalThis.HTMLInputElement.prototype = proto;
    globalThis.window = {
        addEventListener(type, fn) {
            const key = `window:${type}`;
            listeners.set(key, [...(listeners.get(key) ?? []), fn]);
        }
    };
    globalThis.document = {
        createElement: makeInput,
        body: { append() {} }
    };

    return {
        input: () => created.at(-1),
        fire(target, type, event = {}) {
            for (const fn of listeners.get(`${target}:${type}`) ?? []) fn(event);
        },
        hasListener(target, type) {
            return (listeners.get(`${target}:${type}`) ?? []).length > 0;
        },
        restore() {
            globalThis.document = previous.document;
            globalThis.window = previous.window;
            globalThis.HTMLInputElement = previous.HTMLInputElement;
        }
    };
}

test("on an engine that reports cancel, a focus event cannot lose the choice", async () => {
    const dom = withFakeDom({ supportsCancel: true });
    try {
        const { pickFiles } = await import("../app/js/app/capture.js");
        const pending = pickFiles({ accept: "image/*", multiple: true });
        const input = dom.input();

        // The window regains focus the moment the sheet opens — which is what
        // Android and iOS do, and what the old unconditional listener treated as
        // "the picker closed".
        dom.fire("window", "focus");
        await new Promise(r => setTimeout(r, 500));

        // The person then picks a photograph. It must survive.
        const file = { name: "board.jpg", type: "image/jpeg", size: 10 };
        input.files = [file];
        dom.fire("input", "change");

        const got = await pending;
        assert.deepEqual(got, [file],
            "the chosen file was discarded by a focus event that meant nothing");
        assert.equal(input.removed, true, "and the input is cleaned up afterwards");
    } finally {
        dom.restore();
    }
});

test("on an engine without cancel, a dismissed picker resolves empty", async () => {
    const dom = withFakeDom({ supportsCancel: false });
    try {
        const { pickFiles } = await import("../app/js/app/capture.js");
        const pending = pickFiles({ accept: "image/*" });
        assert.equal(dom.hasListener("window", "focus"), true,
            "an engine with no cancel event has nothing else to notice a dismissal");
        assert.equal(dom.hasListener("input", "cancel"), false);

        // Focus returns with nothing chosen, and the fallback reports the cancel
        // rather than waiting for a change that will never come.
        dom.fire("window", "focus");
        const got = await pending;
        assert.deepEqual(got, [], "a picker that was dismissed is an empty result, not a hang");
    } finally {
        dom.restore();
    }
});

test("a picker is never left on the page, whichever way it ends", async () => {
    // The old fallback was registered even on the engines that did not need it,
    // and the element it removed was the only thing that had been keeping the
    // promise from hanging. Both paths must remove it.
    for (const supportsCancel of [true, false]) {
        const dom = withFakeDom({ supportsCancel });
        try {
            const { pickFiles } = await import("../app/js/app/capture.js");
            const pending = pickFiles({});
            const input = dom.input();
            if (supportsCancel) {
                dom.fire("input", "cancel");
            } else {
                dom.fire("window", "focus");
                await new Promise(r => setTimeout(r, 1600));
            }
            await pending;
            assert.equal(input.removed, true, `input left behind (supportsCancel=${supportsCancel})`);
        } finally {
            dom.restore();
        }
    }
});

// ---------------------------------------------------------------------------
// Asking the browser, before it refuses
// ---------------------------------------------------------------------------

// A fake navigator, restored afterwards. `navigator` is a getter on globalThis
// in modern Node, so plain assignment does not take — which is a detail worth
// knowing before writing a test that silently replaced nothing.
function withNavigator(nav, win = { isSecureContext: true }) {
    const previous = {
        navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
        window: Object.getOwnPropertyDescriptor(globalThis, "window")
    };
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
    return () => {
        for (const [k, d] of Object.entries(previous)) {
            if (d) Object.defineProperty(globalThis, k, d);
            else delete globalThis[k];
        }
    };
}

/** A getUserMedia that records what it was asked for and hands back a stream. */
function fakeDevices({ onAsk = () => {} } = {}) {
    const asked = [];
    return {
        asked,
        mediaDevices: {
            getUserMedia: async c => {
                asked.push(c);
                onAsk(c);
                return { getTracks: () => [{ stop() {} }] };
            }
        }
    };
}

// The self-hosted copy of this app, reached from a phone over the LAN address,
// is served over plain http — and `navigator.mediaDevices` does not exist
// outside a secure context. That failure used to arrive as the generic "this
// browser cannot record here", which is true and useless: the browser is fine,
// the ADDRESS is the problem, and nothing in a permission menu will ever fix
// it. It needs its own answer so the message can name the address.
test("a page that cannot ask says so, and says why", async () => {
    const restore = withNavigator({}, { isSecureContext: false });
    try {
        const { captureAvailability, openStream, captureErrorCode } =
            await import("../app/js/app/capture.js");
        assert.equal(captureAvailability(), "insecure");
        await assert.rejects(
            () => openStream({ audio: true }),
            e => captureErrorCode(e) === "capture_insecure"
        );
    } finally {
        restore();
    }
});

// Every refusal the user can act on must have its own code. One code for all of
// them is what turned "open it over https" into "buy a different browser".
test("each refusal the user can act on keeps its own code", async () => {
    const { captureErrorCode } = await import("../app/js/app/capture.js");
    const named = name => Object.assign(new Error(name), { name });
    const cases = [
        ["InsecureContextError", "capture_insecure"],
        ["NotAllowedError", "capture_denied"],
        ["SecurityError", "capture_denied"],
        ["NotFoundError", "capture_no_device"],
        ["OverconstrainedError", "capture_no_device"],
        ["NotReadableError", "capture_busy"],
        ["NotSupportedError", "capture_unsupported"],
        ["TypeError", "capture_unsupported"],
        ["WhateverElse", "capture_failed"]
    ];
    for (const [name, code] of cases) {
        assert.equal(captureErrorCode(named(name)), code, name);
    }
});

// THE SILENT ONE. The fallback for a video that cannot satisfy `facingMode`
// built one constraints object, put `video` on it, and handed it over — so the
// audio constraint never made it into the request. A video asking for sound came
// back with no microphone track: recorded perfectly, played silently, and looked
// like a working feature to everybody including the tests.
test("relaxing the camera never drops the microphone with it", async () => {
    const restore = withNavigator({});
    try {
        const { openStream } = await import("../app/js/app/capture.js");
        const devices = fakeDevices({
            onAsk: c => {
                // The first request asks for the back camera; nothing here has
                // one, which is the case the fallback exists for.
                if (c.video && c.video.facingMode === "environment") {
                    throw Object.assign(new Error("no back camera"), { name: "OverconstrainedError" });
                }
            }
        });
        globalThis.navigator.mediaDevices = devices.mediaDevices;

        await openStream({ video: { facingMode: "environment" }, audio: true });

        assert.ok(devices.asked.length > 1, "the fallback should have been tried");
        for (const c of devices.asked) {
            assert.ok(c.audio === true,
                `a request reached getUserMedia with no microphone: ${JSON.stringify(c)}`);
        }
    } finally {
        restore();
    }
});

// Safari implements `navigator.permissions` and REJECTS the `camera` and
// `microphone` names with a TypeError. So "the query failed" and "the browser
// has no opinion" both answer "unknown" — and "unknown" has to mean "let
// getUserMedia ask", never "refuse". Refusing on the strength of an unsupported
// query would refuse a recording that works perfectly in the browser asking.
test("an engine that cannot answer is told to ask, not to refuse", async () => {
    const restore = withNavigator({});
    try {
        const { permissionState, captureAvailability } = await import("../app/js/app/capture.js");

        // No Permissions API at all.
        globalThis.navigator.mediaDevices = fakeDevices().mediaDevices;
        assert.equal(await permissionState("audio"), "unknown");

        // The API is there and rejects the name — Safari's exact shape.
        globalThis.navigator.permissions = { query: async () => { throw new TypeError("nope"); } };
        assert.equal(await permissionState("video"), "unknown");

        // And a browser that HAS the API is still believed.
        globalThis.navigator.permissions = { query: async () => ({ state: "denied" }) };
        assert.equal(await permissionState("audio"), "denied");
        assert.equal(captureAvailability(), "granted");
    } finally {
        restore();
    }
});

// THE ONE THAT LOOKED LIKE A FIXTURE AND WAS THE BUG. The Permissions API's
// answer is a snapshot taken when the page loaded: Chrome and Edge go on
// reporting "denied" for an origin until the tab is reloaded, even after the
// user has allowed the camera in the browser's own settings. So a "refused
// permission must not be re-requested" rule took a permission the user had
// already granted and refused to record it — without ever calling getUserMedia,
// so without a prompt ever appearing. The only way out was a reload nothing in
// the app mentioned.
//
// This one pins the opposite: a stale "denied" must NOT stop the real attempt.
// The answer is consulted for its verdict only after getUserMedia has spoken.
test("a stale refusal must not stop the attempt that would have worked", async () => {
    const restore = withNavigator({});
    try {
        const { requestCapturePermission } = await import("../app/js/app/capture.js");
        // What the browser reports...
        globalThis.navigator.permissions = { query: async () => ({ state: "denied" }) };
        // ...against what it actually does when asked.
        const devices = fakeDevices();
        globalThis.navigator.mediaDevices = devices.mediaDevices;

        assert.equal(await requestCapturePermission("audio"), "granted");
        assert.equal(devices.asked.length, 1,
            "the permission was reported refused, so getUserMedia was never asked");
    } finally {
        restore();
    }
});

// The opposite mistake, and the reason the rule above is not "always ignore the
// answer": when the browser is asked and says no, that IS final — it comes from
// getUserMedia itself, not from a snapshot, and it is what lets Settings drop
// the button rather than leave a control it has seen fail.
test("a refusal the browser confirms on the ask is reported as a refusal", async () => {
    const restore = withNavigator({});
    try {
        const { requestCapturePermission } = await import("../app/js/app/capture.js");
        globalThis.navigator.permissions = { query: async () => ({ state: "prompt" }) };
        globalThis.navigator.mediaDevices = {
            getUserMedia: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); }
        };

        assert.equal(await requestCapturePermission("audio"), "denied");
    } finally {
        restore();
    }
});

// `getUserMedia` IS the request — there is no separate permission call for a
// camera — so the one that makes the browser ask has to open a stream and then
// give it straight back. A microphone left open here is a recording light that
// stays on for as long as Settings stays open.
test("asking for the permission gives the stream straight back", async () => {
    const restore = withNavigator({});
    try {
        const { requestCapturePermission } = await import("../app/js/app/capture.js");
        let stopped = 0;
        globalThis.navigator.mediaDevices = {
            getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] })
        };
        globalThis.navigator.permissions = { query: async () => ({ state: "prompt" }) };

        assert.equal(await requestCapturePermission("audio"), "granted");
        assert.equal(stopped, 1, "the stream opened to raise the prompt was left open");
    } finally {
        restore();
    }
});

// A control that cannot do what it says is worse than no control — which is the
// rule the whole device section of Settings is arranged around. The Allow
// button exists for everything except a permission already granted, and the
// case that has to stay is `denied`: that answer is a load-time snapshot, so
// hiding the button there is what left somebody who had already unblocked
// themselves with nothing left to press.
test("Settings offers the camera permission unless it is already granted", () => {
    const settings = code(read("app/js/ui/pages/settings.js"));
    assert.match(settings, /requestCapturePermission\(/,
        "Settings must be able to ask for the camera and microphone");
    assert.match(settings, /permissionState\(/,
        "Settings must report what the browser has already decided");

    // The only state that gets no button is `granted` — there is nothing left
    // to allow. The one that MUST keep its button is `denied`, and that is the
    // case this rule used to get backwards.
    assert.match(settings, /state === "granted"\)\s*return;/,
        "an already-granted permission needs no Allow button");

    const row = settings.slice(settings.indexOf('permissionState("audio")'));
    assert.doesNotMatch(row, /state !== "prompt" && state !== "unknown"\)\s*return;/,
        "the Allow button must not be withheld from a permission the snapshot calls refused");

    // A settled answer still removes the button — that one came from
    // getUserMedia itself, so it is a real answer and not a snapshot.
    assert.match(row, /answer !== "prompt" && answer !== "unknown"/,
        "a settled answer should be the one that removes the button");
});

// The recorder opens the stream BEFORE its dialog, so that a permission prompt
// is a prompt rather than a dialog that then asks for one. What cannot be
// prompted at all is answered before the call; what merely MIGHT already be
// refused is not, because a refusal guessed from a snapshot costs a working
// camera and a prompt that never appears.
test("the recorder refuses only what cannot be prompted, and never on a guess", () => {
    const src = code(read("app/js/ui/components/recorder.js"));
    const guard = src.indexOf("captureAvailability()");
    const ask = src.indexOf("openStream(");
    assert.ok(guard !== -1, "the recorder must check whether a stream can be had at all");
    assert.ok(guard < ask, "and must do so BEFORE asking for one");

    // The regression this replaced: a `permissionState(kind) === "denied"`
    // early-return between the two, which meant no prompt could ever be shown.
    assert.doesNotMatch(src, /permissionState\(/,
        "the recorder must not gate the capture on a permission snapshot");
    assert.doesNotMatch(src, /permissionState\b/,
        "and must not import one, since there is nothing left for it to decide");
});

// ---------------------------------------------------------------------------
// The bytes outlive the form
// ---------------------------------------------------------------------------

// The bug this whole section is about, and it was silent in the worst way: the
// record said the note carried a photograph, the photograph's bytes were gone,
// and nothing on the screen could undo it. It is worth stating the chain.
//
// A note is saved with one photograph. It is opened again and saved again
// WITHOUT touching the attachment section. The form's list of what it is about to
// commit is empty — nothing told it the note had a photograph, because the list
// it was holding was not the list the section was drawing — so `commit` was handed
// an empty list. `commit` deletes the bytes of every attachment the list does not
// mention. The note kept its description, because the description is what the
// record holds, and the record still said "1 photo".
//
// `missingBytes()` is how this is now stated as a fact about a device rather than
// discovered from a thumbnail that will not load.
test("saving a note again without touching its attachments keeps the bytes", async () => {
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "the whiteboard" });
    const saved = await attachmentService.add(note.id, {
        kind: "photo", name: "board.jpg", type: "image/jpeg", blob: fakeBlob(4096)
    });
    assert.deepEqual(await attachmentService.missingBytes(note.id), [],
        "the attachment is there to begin with");

    // The form is opened again and saved again WITHOUT the attachment section
    // ever reporting a change, which is the case that destroyed the photograph:
    // the form's list came from `let staged = []` instead of from the record, so
    // it submitted nothing, and `commit` deleted the bytes of an attachment the
    // record still described. The fix is that the list starts from the record, so
    // this is the form's real submit, and it must round-trip.
    const staged = attachmentList(await laterService.get(note.id));
    const descriptors = staged.map(({ blob, ...d }) => d);
    await laterService.update(note.id, { content: "the whiteboard, again", attachments: descriptors });
    await attachmentService.commit(note.id, staged);

    assert.deepEqual(await attachmentService.missingBytes(note.id), [],
        "a re-save that changes nothing must leave every attachment openable");
    assert.notEqual(await attachmentService.blobOf(note.id, saved.id), null,
        "and the photograph's bytes are still there");
    assert.equal((await laterService.get(note.id)).attachments.length, 1,
        "and the record still describes it");
});

test("committing an empty list really does clear the note", async () => {
    // The other side of the same coin, and the reason the fix above is in the form
    // and not in `commit`. An empty list IS a legitimate instruction — "remove
    // every attachment" — and the delete branch has to keep working, or removing
    // the last photograph from a note would silently leave its bytes behind.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    await attachmentService.add(note.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    await laterService.update(note.id, { attachments: [] });
    await attachmentService.commit(note.id, []);

    assert.deepEqual(await attachmentService.missingBytes(note.id), [], "nothing is claimed");
    assert.equal((await media()).length, 0, "and nothing is held");
});

test("a removed attachment really is removed, bytes and all", async () => {
    // The other direction, because the fix above must not turn `commit`'s delete
    // branch into something that never deletes. The difference is the RECORD: a
    // removal rewrites the record first, and only then is the delete right.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    const kept = await attachmentService.add(note.id, {
        kind: "photo", name: "a.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    const dropped = await attachmentService.add(note.id, {
        kind: "photo", name: "b.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });

    await attachmentService.remove(note.id, dropped.id);
    const item = await laterService.get(note.id);
    assert.deepEqual(item.attachments.map(x => x.id), [kept.id], "the record no longer lists it");
    assert.deepEqual(await attachmentService.missingBytes(note.id), [], "so nothing is missing");
    assert.equal(await attachmentService.blobOf(note.id, dropped.id), null, "and its bytes are gone");
    assert.notEqual(await attachmentService.blobOf(note.id, kept.id), null, "the other one survives");
});

test("missingBytes names exactly the attachments whose bytes are absent", async () => {
    // The honest state, and the one the UI turns into "only its details synced
    // here": a description arrived from another device and the bytes did not.
    const { laterService, attachmentService } = await withService();
    const note = await laterService.create({ type: "note", content: "x" });
    const here = await attachmentService.add(note.id, {
        kind: "photo", name: "here.jpg", type: "image/jpeg", blob: fakeBlob(64)
    });
    // A description for bytes that were never on this device.
    await laterService.update(note.id, {
        attachments: [...attachmentList(await laterService.get(note.id)), {
            id: "from-elsewhere", kind: "audio", name: "memo.webm", type: "audio/webm",
            size: 2048, durationMs: 6000, createdAt: Date.now()
        }]
    });
    assert.deepEqual(await attachmentService.missingBytes(note.id), ["from-elsewhere"],
        "the one whose bytes are not here, and not the one that is");
    assert.notEqual(await attachmentService.blobOf(note.id, here.id), null);
});

// The section's byte-loading, and the form's starting list, used to be guarded
// here by two tests that read the source and matched a regex. Both are gone, and
// both were replaced rather than deleted: see attachment-display.test.mjs, which
// builds the real section and the real form and asserts what they drew and what
// they handed back. A regex can tell you the line `entry.blob = blob` is still
// spelled that way; it cannot tell you the grid repainted, that the caller's list
// — the one that gets submitted — ended up holding the bytes, or that tapping a
// recording opens a player instead of saying the file is on another device. Those
// are the questions these two were standing in for, and they were the reason a
// break in the module that decides what the user sees could not have been caught.

// Two renders of the same list overlap, because `loadThumbs` awaits IndexedDB and
// a re-render can start while the previous one is still waiting. When the slower
// run finished last it published its own map and revoked the URLs the newer one
// had just created and was drawing — `net::ERR_FILE_NOT_FOUND` on a blob URL that
// was correct a moment earlier.
test("a superseded thumbnail load cannot revoke the live URLs", () => {
    const src = code(read("app/js/ui/pages/later.js"));
    assert.match(src, /let\s+thumbRun\s*=\s*0/, "the load is numbered");
    assert.match(src, /const\s+run\s*=\s*\+\+thumbRun/, "and every load takes a number");
    // Checked after the await, before a URL is made: a superseded run must not
    // create one at all.
    assert.match(src, /await[\s\S]*?if\s*\(run\s*!==\s*thumbRun\)\s*return/,
        "and gives up once it is superseded");
    // Checked again before it publishes, and everything it made is revoked.
    assert.match(src, /if\s*\(run\s*!==\s*thumbRun\)\s*\{[\s\S]*?revokeObjectURL/,
        "a superseded run revokes what it made instead of publishing it");
    // Unmount bumps it too, so a load still waiting cannot repopulate a map the
    // screen has already given up.
    assert.match(src, /thumbRun\+\+/, "leaving the screen invalidates the run in flight");
});

// ---------------------------------------------------------------------------
// The three ways a capture or a thumbnail vanished without an error
//
// All three were silent, and all three had the same shape: something went wrong
// on a path where a throw was swallowed, a repaint was skipped, or a URL was
// revoked one instruction too early. None failed a test and none said anything
// on screen.
//
// The capture dialog is exercised for real rather than read as source, because
// that is the one whose failure mode was "the promise resolved with nothing and
// nobody noticed" — which is exactly the kind of bug a source scan cannot see.
// ---------------------------------------------------------------------------

// The smallest DOM that `h()`, `dialog.js` and this dialog's own preview build
// honestly need: element creation (HTML and SVG), attributes, text, children,
// and the two selectors the dialog uses on the result.
function installDom() {
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        URL: globalThis.URL,
        Node: globalThis.Node
    };

    const urls = new Map();
    const revoked = new Set();
    let seq = 0;

    class FakeNode {
        constructor(tag) {
            this.tagName = String(tag).toUpperCase();
            this.childNodes = [];
            this.attributes = {};
            this.listeners = new Map();
            this.style = {};
            this.dataset = {};
            this.parentNode = null;
            this.value = "";
            this.textContent = "";
            this.isConnected = true;
            this.className = "";
            this.classList = { add() {}, remove() {}, toggle() {} };
        }
        setAttribute(k, v) { this.attributes[k] = String(v); }
        getAttribute(k) { return this.attributes[k] ?? null; }
        removeAttribute(k) { delete this.attributes[k]; }
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(fn);
        }
        removeEventListener() {}
        append(...nodes) {
            for (const n of nodes) {
                if (n == null || n === false) continue;
                const node = n instanceof FakeNode ? n : new FakeText(String(n));
                node.parentNode = this;
                this.childNodes.push(node);
            }
        }
        appendChild(n) { this.append(n); return n; }
        removeChild(n) {
            const i = this.childNodes.indexOf(n);
            if (i >= 0) this.childNodes.splice(i, 1);
            return n;
        }
        replaceChildren(...nodes) {
            for (const c of this.childNodes) c.parentNode = null;
            this.childNodes = [];
            this.append(...nodes);
        }
        remove() {
            if (this.parentNode) this.parentNode.removeChild(this);
            this.isConnected = false;
        }
        focus() {}
        descendants() {
            return this.childNodes.flatMap(c => (c instanceof FakeNode
                ? [c, ...c.descendants()]
                : []));
        }
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] ?? null;
        }
        querySelectorAll(sel) {
            return this.descendants().filter(el => (
                sel.split(",").map(s => s.trim()).filter(Boolean).some(w => matches(el, w))
            ));
        }
    }

    class FakeText {
        constructor(text) { this.text = text; this.parentNode = null; }
    }

    // Tag, #id and .class selectors, compound and comma-separated — which is all
    // dialog.js and this dialog's preview issue. A shim that only understood one
    // of those forms would hand a test a button the real page does not have.
    const matches = (el, sel) => {
        const parts = sel.match(/[.#]?[\w-]+/g) ?? [];
        if (!parts.length) return false;
        return parts.every(part => {
            if (part.startsWith(".")) return String(el.className).split(/\s+/).includes(part.slice(1));
            if (part.startsWith("#")) return el.attributes.id === part.slice(1);
            return el.tagName === part.toUpperCase();
        });
    };

    const dialogRoot = new FakeNode("div");
    dialogRoot.setAttribute("id", "dialog-root");

    globalThis.Node = FakeNode;
    globalThis.document = {
        createElement: tag => new FakeNode(tag),
        createElementNS: (_ns, tag) => new FakeNode(tag),
        createTextNode: text => new FakeText(text),
        querySelector: sel => (sel === "#dialog-root" ? dialogRoot : null),
        addEventListener() {},
        removeEventListener() {},
        body: new FakeNode("body")
    };
    globalThis.window = { addEventListener() {} };
    globalThis.URL = {
        createObjectURL(blob) {
            const url = `blob:test/${seq++}`;
            urls.set(url, blob);
            return url;
        },
        revokeObjectURL(url) {
            revoked.add(url);
            urls.delete(url);
        }
    };

    return {
        dialogRoot,
        urls,
        revoked,
        // The dialog's own two answers, chosen the way the stylesheet names
        // them rather than by position: the head also carries a close button,
        // and pressing that is a CANCEL — which is how a test that guesses
        // "the first button" passes while asserting nothing.
        confirm: () => dialogRoot.querySelector(".btn.primary"),
        cancel: () => dialogRoot.querySelectorAll(".btn").at(-1),
        press(node) {
            assert.ok(node, "the dialog rendered no such button");
            for (const fn of node.listeners.get("click") ?? []) fn({});
        },
        restore() {
            globalThis.document = previous.document;
            globalThis.window = previous.window;
            globalThis.URL = previous.URL;
            globalThis.Node = previous.Node;
        }
    };
}

// The capture dialog's bug was not "it returned the wrong value" — it was that
// its promise never settled at all, because the throw on the exit path left the
// second, settling call to be skipped. So every assertion here races the pending
// promise against a deadline: a hang must FAIL a test, not stop the run.
const settlesWithin = (pending, ms = 2000) => Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(
        () => reject(new Error("the capture dialog never settled — the caller would wait forever")),
        ms
    ))
]);

const PHOTO = {
    kind: "photo",
    name: "board.jpg",
    type: "image/jpeg",
    size: 12,
    durationMs: null,
    width: 4,
    height: 4,
    blob: { size: 12, type: "image/jpeg" }
};

// The capture dialog's exit path used to reference an identifier that did not
// exist in its scope, which threw on EVERY exit — accepted or cancelled. The
// throw happened inside a `.then()`, so the promise still resolved, and the
// `.catch()` that followed called the same function again, found it already
// settled and returned early. The caller received `null` for a photograph it had
// just taken: the dialog closed, no note was written, and nothing was said.
test("an accepted capture resolves with the stager, not with null", async () => {
    const dom = installDom();
    try {
        const { describeAndConfirm } = await import("../app/js/ui/components/media-capture.js");
        const pending = describeAndConfirm([{ ...PHOTO }], { multi: false });

        // The dialog focuses its first field; the confirm button carries the
        // action, so that is the one the user presses.
        assert.ok(dom.confirm(), "the dialog offers a confirm");
        assert.ok(dom.cancel(), "and a way out");
        dom.press(dom.confirm());

        const got = await settlesWithin(pending);
        assert.notEqual(got, null,
            "an accepted capture resolved with null — the photograph was thrown away");
        assert.equal(got.length, 1);
        assert.equal(got[0].name, "board.jpg", "and it is the stager that was captured");
        assert.equal(got[0].blob, PHOTO.blob, "with its bytes still attached");
        assert.equal(dom.revoked.size, 1, "and its preview URL released on the way out");
    } finally {
        dom.restore();
    }
});

// The name the user typed becomes the note's title, so this is the line a
// mis-wired dialog would silently drop.
test("the name typed into the capture dialog comes back on the stager", async () => {
    const dom = installDom();
    try {
        const { describeAndConfirm } = await import("../app/js/ui/components/media-capture.js");
        const pending = describeAndConfirm([{ ...PHOTO }], { multi: false });
        const input = dom.dialogRoot.descendants().find(el => el.tagName === "INPUT");
        assert.ok(input, "the dialog asks for a name");
        input.value = "shelf labels";
        dom.press(dom.confirm());

        const got = await settlesWithin(pending);
        assert.equal(got[0].name, "shelf labels");
    } finally {
        dom.restore();
    }
});

// A cancelled capture must still resolve — with null — rather than hanging, and
// must release its preview URL on the way out.
test("a cancelled capture resolves with null and still releases its preview", async () => {
    const dom = installDom();
    try {
        const { describeAndConfirm } = await import("../app/js/ui/components/media-capture.js");
        const pending = describeAndConfirm([{ ...PHOTO }], { multi: false });
        dom.press(dom.cancel());

        const got = await settlesWithin(pending);
        assert.equal(got, null, "a dismissed capture is null");
        assert.equal(dom.revoked.size, 1, "and it does not pin its preview for the life of the document");
    } finally {
        dom.restore();
    }
});

// Two photographs, two previews, two released URLs — and both stagers back, in
// order, under one name.
test("a multi-capture returns every stager and releases every preview", async () => {
    const dom = installDom();
    try {
        const { describeAndConfirm } = await import("../app/js/ui/components/media-capture.js");
        const second = { ...PHOTO, name: "ceiling.jpg", blob: { size: 20, type: "image/jpeg" } };
        const pending = describeAndConfirm([{ ...PHOTO }, second], { multi: true });
        const images = dom.dialogRoot.descendants().filter(el => el.tagName === "IMG");
        assert.equal(images.length, 2, "each photograph is previewed");
        dom.press(dom.confirm());

        const got = await settlesWithin(pending);
        assert.equal(got.length, 2);
        assert.deepEqual(got.map(x => x.name), ["board.jpg", "ceiling.jpg"]);
        assert.equal(dom.revoked.size, 2, "both preview URLs are released");
    } finally {
        dom.restore();
    }
});

// The router emits "route" at the END of every navigation — including the one
// that MOUNTED the screen. Both the list and the note form used to read that as
// "this screen is gone", so the note form skipped the repaint that draws its
// loaded photographs (a saved photo came back as a glyph that only showed the
// picture once tapped) and the list revoked the object URLs its own rows were
// drawing (a blank frame, and `net::ERR_FILE_NOT_FOUND` on a URL that was
// correct a moment earlier).
//
// What means "gone" is that the node is no longer connected, because the router
// detaches the old view by replacing #app's children. Asserted by reading the
// handlers: this is a property of a subscription's shape, not of a return value.
test("a route that only mounted the screen does not dispose what it just drew", () => {
    for (const file of ["app/js/ui/components/attachments.js", "app/js/ui/pages/later.js"]) {
        const src = code(read(file));
        // Every `bus.on("route", …)` whose body releases or disposes must first
        // ask whether the thing it belongs to is still on the page.
        const handlers = [...src.matchAll(/bus\.on\(\s*"route"\s*,[\s\S]{0,240}?\}\s*\)/g)];
        assert.ok(handlers.length > 0, `${file}: expected a route subscription to check`);
        for (const [handler] of handlers) {
            const disposes = /\brelease\s*\(|releaseThumbs\s*\(|disposed\s*=\s*true/.test(handler);
            if (!disposes) continue;
            assert.match(handler, /isConnected/,
                `${file}: a route handler that releases or disposes must check isConnected — the `
                + "route event fires for the navigation that mounted the screen too, so an unguarded "
                + "one takes the URLs out from under the rows that just drew them");
        }
    }
});

// And the form must never repaint a section the user has already left — which is
// what the isConnected check replaced.
test("the note form repaints its thumbnails only while it is still on the page", () => {
    const src = code(read("app/js/ui/components/attachments.js"));
    assert.match(src, /if\s*\(!element\.isConnected\)\s*return;/,
        "a blob load that resolves after the form was left must paint nothing");
    // The flag is gone entirely: it was set by the mounting route event, so it
    // was already true before the first read could resolve, and the repaint that
    // draws a saved photograph never ran at all.
    assert.ok(!/disposed\s*=\s*true/.test(src),
        "the disposed flag suppressed every repaint and must not come back");
});
