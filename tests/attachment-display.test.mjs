// What a saved recording does when the note is opened again.
//
// Every other attachment test in this suite is about the SERVICE: the two writes,
// the order, the cascade, the ceilings. Those all passed for a voice memo and a
// video clip — a recorded attachment round-trips through `commit` and comes back
// byte for byte. Which left the other half of the sentence with nothing at all
// covering it: whether the note DISPLAYS it.
//
// And that half was covered by regexes. `assert.match(src, /entry\.blob = blob/)`
// can tell you the assignment is still spelled the way it was spelled. It cannot
// tell you the grid repainted, that the caller's list — the one that gets
// submitted — ended up holding the bytes, or that tapping the thumbnail opens a
// player instead of saying the file is on another device. So the module that
// decides what the user sees could break completely without a single test going
// red, which is exactly the kind of debt that gets discovered by a person.
//
// So these tests build the real section on a stub DOM and look at what it drew.

import test from "node:test";
import assert from "node:assert/strict";
import { installStubDOM } from "./helpers/stub-dom.mjs";

installStubDOM();

const { installFakeIndexedDB } = await import("./helpers/fake-indexeddb.mjs");
const idb = installFakeIndexedDB();
const { openDb } = await import("../app/js/data/db.js");
await openDb();
const { laterService } = await import("../app/js/services/later-service.js");
const { attachmentService } = await import("../app/js/services/attachment-service.js");
const { attachmentSection } = await import("../app/js/ui/components/attachments.js");
const { laterForm } = await import("../app/js/ui/components/later-form.js");
const { attachmentList } = await import("../app/js/domain/attachments.js");

// --- what the recorder hands over ------------------------------------------
//
// The exact shape `ui/components/attachments.js` `record()` builds and `stage()`
// wraps: a description the record can carry, and the Blob it cannot. Audio and
// video only, because those are the two kinds only the recorder can produce — a
// picked file is a `File`, and the whole question here is whether a blob the app
// made itself survives the same trip.

const RECORDER_TYPES = {
    audio: "audio/webm;codecs=opus",
    video: "video/webm;codecs=vp8,opus"
};

function recorded(kind, { bytes = 8192, durationMs } = {}) {
    const type = RECORDER_TYPES[kind];
    return {
        id: `${kind}-1`,
        kind,
        name: kind === "video" ? "Video" : "Recording",
        type,
        size: bytes,
        durationMs: durationMs ?? (kind === "video" ? 12000 : 7000),
        width: null,
        height: null,
        createdAt: 1700000000000,
        blob: new Blob([new Uint8Array(bytes).fill(3)], { type })
    };
}

const descriptorsOf = entries => entries.map(({ blob, ...d }) => d);

/** A note carrying `entries`, created the way both real flows create it. */
async function noteWith(entries, { title = "Recording", content = null } = {}) {
    const note = await laterService.create({
        type: "note", title, content, url: null, attachments: descriptorsOf(entries)
    });
    await attachmentService.commit(note.id, entries);
    return note;
}

/** Open a saved note the way `laterDetail` does. */
function openNote(item) {
    let reported = null;
    const section = attachmentSection({
        attachments: attachmentList(item),
        loadBlob: id => attachmentService.blobOf(item.id, id),
        onChange: list => { reported = list; }
    });
    return { section, reported: () => reported };
}

/** Let the section's `loadBlob` reads settle. */
const settled = () => new Promise(r => setTimeout(r, 25));

// A save the form never performed, as a value rather than as a hang.
//
// The form's submit handler is not awaitable, so a test waits on the work it asked
// for. Waiting on a plain timer instead lets this test's own writes still be in
// flight when the next test wipes the database — and when the form refuses the
// note outright, which is exactly what an empty starting list makes it do, the
// thing being waited on never settles. A test that hangs is worse than one that
// fails: it takes the whole run down with it and says nothing about why.
const STALLED = Symbol("the save never finished");
const whenSaved = done => Promise.race([
    done,
    new Promise(r => setTimeout(() => r(STALLED), 3000))
]);

// ---------------------------------------------------------------------------

test("a recording is saved, and the note that carries it is still openable", async () => {
    // The service half, stated for the kind the recorder actually produces. It was
    // never covered for audio or video, only for a picked photograph.
    idb.wipe();
    const rec = recorded("audio");
    const note = await noteWith([rec]);

    const item = await laterService.get(note.id);
    assert.equal(item.attachments.length, 1);
    assert.equal(item.attachments[0].kind, "audio");
    assert.equal(item.attachments[0].durationMs, 7000, "the length the recorder measured is kept");
    assert.equal("blob" in item.attachments[0], false, "and the record carries no bytes");

    assert.deepEqual(await attachmentService.missingBytes(note.id), []);
    const blob = await attachmentService.blobOf(note.id, rec.id);
    assert.ok(blob, "the bytes are on this device");
    assert.equal(blob.size, rec.size);
    // The type matters: it is what makes the file PLAYABLE rather than merely
    // present, and a blob stored without its type is a file the browser sniffs.
    assert.equal(blob.type, RECORDER_TYPES.audio);
});

test("reopening the note displays the recording, and says the bytes are here", async () => {
    // The report, as a fact about the screen: before the read lands the
    // thumbnail is drawn as NOT local, and after it lands the SAME thumbnail is
    // drawn as local. `data-local` is what the stylesheet and the whole "described
    // here, bytes elsewhere" distinction are built on, so it is the thing to assert.
    idb.wipe();
    const note = await noteWith([recorded("audio")]);
    const item = await laterService.get(note.id);

    const { section } = openNote(item);
    const thumb = () => section.element.one(n =>
        String(n.className || "").split(/\s+/).includes("attachment-thumb"));
    assert.equal(thumb().dataset.local, "no", "drawn without its bytes, it must not claim them");

    await settled();
    assert.equal(thumb().dataset.local, "yes", "and drawn with them");
});

test("the note counts the recording in words, with its size", async () => {
    idb.wipe();
    const note = await noteWith([recorded("audio", { bytes: 4096 })]);
    const item = await laterService.get(note.id);

    const { section } = openNote(item);
    await settled();
    const status = section.element.byClass("attachment-status")[0];
    // "1 voice memo · 4 KB" — the count in words, because a number against a noun
    // is not a form a translation layer can derive, and the size because a note
    // that holds bytes should say how many.
    assert.match(status.textContent, /1 voice memo/);
    assert.match(status.textContent, /4 KB/);
});

test("the caller is handed the bytes back, because its copy is what gets submitted", async () => {
    // The half that is not a screenshot. The section owns `staged`; the form owns
    // its own list; if the section loaded into its own and stayed quiet, the form
    // would submit descriptors with no blobs — and `commit` would then write
    // nothing while still deleting everything not re-described. Silent, and
    // permanent: the attachment would be gone with the record still naming it.
    idb.wipe();
    const note = await noteWith([recorded("audio")]);
    const item = await laterService.get(note.id);

    const { section, reported } = openNote(item);
    await settled();
    assert.equal(reported().length, 1);
    assert.ok(reported()[0].blob, "the submitted list carries the bytes, not just their description");
    assert.equal(reported()[0].blob.size, 8192);
    assert.ok(section.element, "and the section is the one that drew it");
});

test("tapping a recording opens a player, not a refusal", async () => {
    // `openOne` has two exits and the wrong one is silent-ish: a toast saying the
    // file stayed on the device it was added from, for a file that is on this
    // device. So the exit is asserted, not the absence of a crash.
    idb.wipe();
    const note = await noteWith([recorded("audio")]);
    const item = await laterService.get(note.id);

    const { section } = openNote(item);
    await settled();

    const root = (await import("../app/js/ui/components/dialog.js")) && globalThis.document;
    const dialogRoot = root.querySelector("#dialog-root");
    dialogRoot.replaceChildren();

    section.element.one(n =>
        String(n.className || "").split(/\s+/).includes("attachment-thumb-open")).click();
    await settled();

    const audio = dialogRoot.byTag("audio");
    assert.equal(audio.length, 1, "an <audio> element is what a voice memo opens as");
    assert.equal(audio[0].controls, true, "with controls, or it is not playable");
    assert.match(audio[0].src, /^blob:/, "pointing at this device's own bytes");
});

test("a video opens as a video", async () => {
    idb.wipe();
    const note = await noteWith([recorded("video")]);
    const item = await laterService.get(note.id);

    const { section } = openNote(item);
    await settled();
    const dialogRoot = globalThis.document.querySelector("#dialog-root");
    dialogRoot.replaceChildren();

    section.element.one(n =>
        String(n.className || "").split(/\s+/).includes("attachment-thumb-open")).click();
    await settled();

    const video = dialogRoot.byTag("video");
    assert.equal(video.length, 1, "a clip opens as a <video>, with the picture as well as the sound");
    assert.equal(video[0].playsInline, true, "inline, or it takes over the screen on a phone");
});

test("a recording whose bytes are elsewhere is drawn as not here, and says so on tap", async () => {
    // The honest state, and the one that must NOT be mistaken for the bug above:
    // the description synced, the bytes never left the other device. It is drawn
    // differently and refused on tap, and this test exists so that the two are
    // never confused — a section that cannot tell them apart would show a broken
    // player rather than an honest refusal.
    idb.wipe();
    const rec = recorded("audio");
    const note = await noteWith([rec]);
    // The record keeps describing it; only the bytes go, which is what another
    // device's pull leaves behind.
    await attachmentService.clearAll();

    const item = await laterService.get(note.id);
    assert.equal(item.attachments.length, 1, "the description is still there");

    const { section } = openNote(item);
    await settled();
    assert.equal(section.element.one(n =>
        String(n.className || "").split(/\s+/).includes("attachment-thumb")).dataset.local, "no",
    "and it is drawn as not being on this device");

    assert.deepEqual(await attachmentService.missingBytes(note.id), [rec.id],
        "missingBytes names exactly it");
});

test("saving a note again, without touching the recording, keeps it openable", async () => {
    // The form's own submit, run on a note holding a recording. The photograph
    // version of this exists; the recorded version did not, and this is the path a
    // recording takes every single time the note is edited afterwards.
    idb.wipe();
    const note = await noteWith([recorded("audio")]);
    const item = await laterService.get(note.id);

    // The save is captured and awaited through `whenSaved`, so a form that refuses
    // the note instead of saving it fails here with a reason.
    let done;
    const saved = new Promise(r => { done = r; });
    const el = laterForm(item, async (patch, files) => {
        await laterService.update(item.id, patch);
        await attachmentService.commit(item.id, files ?? []);
        done();
    });
    await settled();

    const form = el.byTag("form")[0];
    assert.ok(form, "the note form is a form");
    form.fire("submit");
    assert.notEqual(await whenSaved(saved), STALLED,
        "the form never saved: an empty starting list makes it refuse the note as having no content");

    assert.deepEqual(await attachmentService.missingBytes(note.id), [],
        "a re-save that changed nothing must leave the recording openable");
    assert.ok(await attachmentService.blobOf(note.id, "audio-1"), "bytes and all");
    assert.equal((await laterService.get(note.id)).attachments.length, 1,
        "and the record still describes it");
});

test("the note form leads with the recording, because there are no words to read", async () => {
    // `isMediaLed` says a note whose whole content is media opens on its media, not
    // on an empty caption field with the picture below the fold. For a recording
    // that is the only thing on the form, so it is the whole screen.
    idb.wipe();
    const note = await noteWith([recorded("audio")]);
    const item = await laterService.get(note.id);

    const el = laterForm(item, async () => {});
    await settled();
    const lead = el.one(n => String(n.className || "").split(/\s+/).includes("attachment-field-lead"));
    assert.ok(lead, "a note that is only a recording leads with the attachment section");
    assert.equal(el.byClass("attachment-status")[0].textContent.includes("1 voice memo"), true);
});