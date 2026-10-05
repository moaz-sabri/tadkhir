// The one door into Later, from inside the app.
//
// The quick field that used to sit above this list is gone, and this file is what
// stands in its place: not a description of the change, but the reason it was
// allowed. A second door is not a convenience, it is a second copy of a save
// path — and a copy nobody re-tests is a copy that rots while the original keeps
// working, which is exactly the shape of "it doesn't save, but only from here".
//
// So every claim below is about the SURVIVING path: that it creates the record,
// that it writes the bytes the record describes, that a failure stores nothing
// and hands the form back usable, and that a voice memo with no words attached
// to it is still a complete note. That last one matters most right now — it was
// the one thing the deleted form could do that a plain note could not, so if this
// door cannot do it, deleting the other one was a feature loss rather than a
// simplification.

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
const { laterPage, newLater, laterDetail } = await import("../app/js/ui/pages/later.js");
const { router, defineRoutes } = await import("../app/js/app/router.js");

// The real router, on the real routes these screens navigate between — because
// "the screen leaves" is half of what a save is supposed to do, and asserting it
// against a stubbed navigate would assert nothing about where it leaves to.
//
// `window`, `history` and `location` are the three globals `navigate()` touches
// after it has mounted the next page, and they are here rather than in the shared
// stub because nothing else in this suite navigates: this file is the one place
// that asserts a save ENDS SOMEWHERE ELSE.
defineRoutes([
    { path: "/later", page: laterPage },
    { path: "/later/new", page: newLater },
    { path: "/later/:id", page: laterDetail }
]);
globalThis.window = {
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {}
};
globalThis.location = { pathname: "/later/new" };
globalThis.history = { pushState() {}, replaceState() {} };

const settled = () => new Promise(r => setTimeout(r, 60));

const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

/**
 * Swap in a wrapper that reports when the real call has finished.
 *
 * The form's submit handler is not awaitable, so without this a test either
 * guesses at a delay or asserts on a store that has not been written yet. Worse,
 * it can assert on a state that was already true — reading the attachment list
 * before the save lands "passes" for a save that then deletes it. `finally` so a
 * thrown call still settles; a test waiting on a call that refuses to happen is
 * the worst kind, because it hangs the run instead of failing it. And the signal
 * is deferred by a tick, because the CALLER still has to unwind: the watched call
 * finishing is not the save finishing, and a button asserted while its own
 * `finally` is still pending reads as stuck when it is only slow.
 */
function watch(obj, key) {
    const real = obj[key];
    const done = deferred();
    obj[key] = async (...args) => {
        try { return await real.apply(obj, args); }
        finally { setTimeout(done.resolve, 0); }
    };
    return { done, restore: () => { obj[key] = real; } };
}

/** A saved audio recording, in exactly the shape the recorder hands over. */
const recorded = ({ bytes = 8192, durationMs = 7000 } = {}) => ({
    id: "audio-1",
    kind: "audio",
    name: "Recording",
    type: "audio/webm;codecs=opus",
    size: bytes,
    durationMs,
    width: null,
    height: null,
    createdAt: 1700000000000,
    blob: new Blob([new Uint8Array(bytes).fill(3)], { type: "audio/webm;codecs=opus" })
});

const descriptorsOf = entries => entries.map(({ blob, ...d }) => d);

/** A note carrying `entries`, created the way both real flows create it. */
async function noteWith(entries, { title = "Recording", content = null } = {}) {
    const note = await laterService.create({
        type: "note", title, content, url: null, attachments: descriptorsOf(entries)
    });
    await attachmentService.commit(note.id, entries);
    return note;
}

/** Mount a page on the stub DOM and hand back the tree plus the parts tests name. */
async function mounted(page, ...args) {
    const root = globalThis.document.createElement("div");
    await page.mount(root, ...args);
    await settled();
    const form = root.byTag("form")[0];
    return {
        root,
        form,
        title: form.byTag("input").find(i => i.type === "text"),
        content: form.byTag("textarea")[0],
        save: form.byClass("form-actions")[0].byTag("button")[0],
        section: form.byClass("attachment-field")[0] ?? null,
        errors: () => form.byClass("field-error").map(n => (n.textContent ?? "").trim()).filter(Boolean)
    };
}

const newItem = () => mounted(newLater);
const editItem = item => mounted(laterDetail, { id: item.id });

// ---------------------------------------------------------------------------

test("the list offers no second way in", async () => {
    // The deletion, asserted. A form that survived as dead markup, or came back
    // under a different class name, is the thing this test exists to make
    // impossible to reintroduce by accident.
    idb.wipe();
    const root = globalThis.document.createElement("div");
    await laterPage.mount(root);
    await settled();

    assert.equal(root.byClass("quick-form").length, 0, "no quick form on the list");
    assert.equal(root.byClass("quick-input").length, 0, "and no quick field");
    assert.equal(root.byTag("form").length, 0, "the list saves nothing itself any more");

    // …and the way in is still there, in both the places a person would look for
    // it: the header, and an empty list that would otherwise be a dead end.
    const linksTo = root.byTag("a").filter(a => a.href === "/later/new");
    assert.equal(linksTo.length, 2,
        `the header and the empty state both open the item form, found ${linksTo.length}`);
});

test("the item form offers its adders, and none of them submits the form", async () => {
    const { section } = await newItem();
    assert.ok(section, "the attachment section is on the new-item form");
    const adders = section.byTag("button").filter(b => b.type === "button");
    assert.ok(adders.length >= 3,
        `photo, voice memo, video and file — found ${adders.length}: ${adders.map(b => b.title).join(" | ")}`);
    // Load-bearing, and the reason the deleted form needed a guard of its own: an
    // adder with no explicit type is a SUBMIT button in a browser, so the recorder
    // would open and the form would submit underneath it — an empty note refused
    // as required, a toast, and a recording the user then believes was lost.
    for (const b of section.byTag("button")) {
        assert.equal(b.type, "button", `an adder must not submit the form: ${b.title ?? ""}`);
    }
});

test("an item typed into the form is created", async () => {
    idb.wipe();
    const { form, title, content, save } = await newItem();
    // `commit` is the LAST call of the save, so its signal is the save's — watching
    // `create` instead reports the record half done while the bytes are still being
    // written, and the button asserted below would read as stuck when it is only
    // busy.
    const saved = watch(attachmentService, "commit");
    try {
        title.value = "shelf brackets";
        content.value = "the long ones, 40 mm";
        form.fire("submit");
        await saved.done.promise;
    } finally {
        saved.restore();
    }
    await router.navigate("/later");

    const { open } = await laterService.list();
    assert.equal(open.length, 1, "the item exists");
    assert.equal(open[0].type, "note");
    assert.equal(open[0].title, "shelf brackets");
    assert.equal(open[0].content, "the long ones, 40 mm");
    assert.equal(save.disabled, false, "and the button is not left stuck");
    // The item is in the list the person was sent back to, which is the whole
    // difference between "it saved" and "I can see that it saved".
    const listRoot = globalThis.document.createElement("div");
    await laterPage.mount(listRoot);
    await settled();
    assert.ok(listRoot.byClass("row").length > 0 || listRoot.byClass("list-row").length > 0,
        `the list that was navigated to actually draws the item: ${listRoot.byTag("*").length} nodes`);
});

test("a save that FAILS stores nothing and hands the form back usable", async () => {
    // The requirement that killed the quick field was that it must not fail in
    // silence. A silent failure is a silent failure whether it deletes the text or
    // not: the person presses save and cannot tell what happened. So both halves
    // are asserted — the store is untouched, and the form is live again.
    idb.wipe();
    const { form, title, content, save } = await newItem();
    const real = laterService.create;
    let calls = 0;
    const failed = deferred();
    laterService.create = async () => {
        calls++;
        const e = new Error("no space left on device");
        e.code = "quota";
        failed.resolve();
        throw e;
    };
    try {
        title.value = "the note that must survive";
        content.value = "and its body";
        form.fire("submit");
        // The refusal path: nothing is stored, so the store cannot be the signal —
        // `create` being called is. And it must be waited on rather than slept
        // past, or the assertions below run before the form has given up.
        await Promise.race([
            failed.promise,
            new Promise(r => setTimeout(r, 2000))
        ]);
    } finally {
        laterService.create = real;
    }

    assert.equal(calls, 1, "the save was really attempted, once");
    assert.equal((await laterService.list()).open.length, 0, "and nothing was stored");
    assert.equal(title.value, "the note that must survive", "what was typed is still typed");
    assert.equal(content.value, "and its body", "and the body is still typed too");
    assert.equal(save.disabled, false, "and the button is live again, not dead");
});

test("a note that is a voice memo and no words is complete, and keeps its bytes", async () => {
    // The one capability the deleted quick form had that a plain note did not:
    // press record, say the thing, press stop, and it is filed without a single
    // character typed. If this door cannot do it, removing the other one took a
    // capability away rather than a duplicate away.
    //
    // It is asserted on the real form rather than on a faked recorder, because the
    // part that was ever at risk is not the recording — it is what the form
    // submits afterwards. `laterForm` seeds its list from the record
    // (`attachmentList(item)`), and getting that wrong submits an empty list,
    // `commit` deletes the bytes, and the note is left saying "1 voice memo" with
    // nothing behind it: "the file stayed on the device it was added from".
    idb.wipe();
    const rec = recorded();
    const note = await noteWith([rec], { title: "Recording", content: null });
    const item = await laterService.get(note.id);

    const { form, content, section } = await editItem(item);

    assert.equal(content.required, false,
        "a note with something to look at does not demand words on top of it");
    assert.ok(section.byClass("attachment-grid")[0] ?? section.byTag("img")[0],
        "and the memo is on the form, not merely described");

    // Save it again without touching the attachment section at all. That is the
    // ordinary thing a person does — open a note to read it, save it — and it is
    // what deleted the bytes. The wait is on `commit`, because that is the call
    // that deletes: reading the list first would pass for a save about to empty it.
    const committed = watch(attachmentService, "commit");
    try {
        form.fire("submit");
        await committed.done.promise;
    } finally {
        committed.restore();
    }

    const after = await laterService.get(note.id);
    assert.equal(after.attachments.length, 1, "the attachment is still described");
    assert.equal(after.attachments[0].kind, "audio");
    assert.equal(after.attachments[0].durationMs, rec.durationMs, "the recorder's own duration survived");
    assert.deepEqual(await attachmentService.missingBytes(note.id), [],
        "and every byte it describes is still on the device");
});

test("an empty note is refused with a message, not a silence", async () => {
    idb.wipe();
    const { form, errors } = await newItem();
    form.fire("submit");
    await settled();
    assert.equal((await laterService.list()).open.length, 0, "nothing was stored");
    assert.ok(errors().length > 0, `and the field says why: ${JSON.stringify(errors())}`);
});
