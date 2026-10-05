import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { bus } from "../../app/bus.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";
import { uiIcon } from "../icons.js";
import { action, listRow, badge, toolbar } from "./ui.js";
import { formatClock } from "../../domain/time.js";
import {
    ACCEPT,
    PHOTO_LONG_EDGE,
    PHOTO_QUALITY,
    MAX_MEDIA_BYTES,
    MAX_PHOTOS_PER_NOTE,
    ATTACHMENT_KINDS,
    byteCeilingFor,
    countOf,
    displayName,
    extensionOf,
    kindForFile,
    newDescriptor,
    roomFor
} from "../../domain/attachments.js";
import { pickFiles, probeMedia, probeImage, shrinkPhoto } from "../../app/capture.js";
import { recordAudio, recordVideo } from "./recorder.js";

// What a note is carrying, and the four buttons that add to it.
//
// TWO PLACES, ONE COMPONENT. The edit form needs the whole thing — pick, stage,
// remove, open — and a Later row needs one line saying what is attached. They
// are the same knowledge (which kinds, which icons, which limits, which
// wording), so it lives here once and `attachmentSummary` is the small half the
// row uses.
//
// NOTHING IS WRITTEN UNTIL THE FORM IS SAVED. Files are staged in memory as
// Blobs and committed by the form's own submit handler, so Cancel really
// cancels and a user who picked four photographs and then changed their mind
// leaves nothing behind. The cost is that the staged bytes are in RAM: at most
// MAX_MEDIA_BYTES, and `admit` refuses a pick that would take it past that, so
// the number is a bound and not a hope.

// The kind a picked file belongs to, or a refusal. One place, so the picker, a
// shared file and a downloaded file are all classified by the same rule and
// none of them can quietly widen it.
function classify(file) {
    const kind = kindForFile(file);
    if (!kind) toast.show("error.attachment_kind");
    return kind;
}

// The shape a staged attachment is stored in while the form is open: the
// description the note will carry, plus the Blob the description cannot.
function stage(input, { at, id }) {
    return { ...newDescriptor(input, { id, now: at }), blob: input.blob };
}

// Turn a picked File into a stager. A photograph is downscaled on the way in
// (that is what lets a note hold five of them), and the two media kinds have
// their duration read out of the file rather than believed — the five-second
// minimum and the thirty-second cap are rules about TIME, and a file's name says
// nothing about how long it is.
async function prepare(file, kind) {
    const blob = kind === "photo"
        ? await shrinkPhoto(file, { longEdge: PHOTO_LONG_EDGE, quality: PHOTO_QUALITY })
        : file;
    const base = {
        kind,
        name: displayName(file.name, kind),
        type: blob.type || file.type || null,
        size: blob.size,
        blob
    };
    if (kind === "photo") {
        const { width, height } = await probeImage(blob);
        return { ...base, width, height, durationMs: null };
    }
    const { durationMs, width, height } = await probeMedia(blob);
    return { ...base, width, height, durationMs };
}

// A size in words: 3.0 MB, 412 KB, 900 B. A unit a person can act on, as
// opposed to a byte count they cannot.
export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The one line under a thumbnail: how big, how long when there is a length, and
// how many pixels when there are any.
//
// formatClock, not formatShort: the second is for TIME TRACKED, where a 20-second
// session really is "<1m" and claiming otherwise would overstate it. A 20-second
// clip is 20 seconds long, and "<1m" on a video somebody just watched is a
// different and wrong number.
function describeOne(entry) {
    const bits = [formatBytes(entry.size)];
    if (entry.durationMs) bits.push(formatClock(entry.durationMs));
    if (entry.width && entry.height) bits.push(`${entry.width}×${entry.height}`);
    return bits.join(" · ");
}

const KIND_ICONS = Object.freeze({
    photo: "image",
    audio: "mic",
    video: "video",
    document: "file"
});

/** The icon for a kind, from the one registry. */
export function attachmentIcon(kind) {
    return KIND_ICONS[kind] ?? "file";
}

// The count for a kind, in words.
//
// The singular form is a SEPARATE key rather than a plural rule, because the
// translation layer substitutes parameters and nothing more — and the result of
// not caring was a list row reading "1 photos" and a share button reading
// "Save 1 shared file(s) as a note". Arabic needs the same split for the same
// reason: a number against a noun is not a form a translation layer can derive.
function countLabel(kind, count) {
    const name = `${kind[0].toUpperCase()}${kind.slice(1)}`;
    const key = count === 1 ? `attachments.one${name}` : `attachments.count${name}`;
    return t(key, { count });
}

/** "3 photos · 1 video", or null when the note carries nothing. */
export function attachmentCountsLabel(attachments) {
    return attachmentSummary(attachments, counts => counts
        .map(({ kind, count }) => countLabel(kind, count))
        .join(" · "));
}

/**
 * What a note carries, as counts per kind.
 *
 * `describe` is the caller's formatter, so this module produces no English of
 * its own. Without one it returns the raw counts, which is what a row wants when
 * it has an icon to put next to them.
 */
export function attachmentSummary(attachments, describe = null) {
    const list = Array.isArray(attachments) ? attachments : [];
    if (!list.length) return null;
    const counts = ATTACHMENT_KINDS
        .map(kind => ({ kind, count: countOf(list, kind) }))
        .filter(x => x.count > 0);
    if (!describe) return counts;
    return describe(counts);
}

/**
 * Is this item its media rather than a note about something?
 *
 * Attachments AND no words. The "no words" half is what makes this safe to act
 * on: a note with a caption and a photograph reads as a note with a photograph,
 * and moving its media above the caption would move something the user was
 * reading. A note with nothing but photographs has nothing to read, so the media
 * is the first thing there is to see — and one definition, because a list row and
 * a form disagreeing about which items are photographs is how a list of them
 * stops lining up.
 */
export function isMediaLed(item) {
    const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
    if (!attachments.length) return false;
    return !String(item?.content ?? "").trim();
}

/** The first photograph on an item, or null. The one a row draws. */
export function leadPhoto(item) {
    const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
    return attachments.find(x => x?.kind === "photo") ?? null;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/**
 * The attachments block of the note form.
 *
 * `attachments` is what the note already carries (descriptions, without their
 * bytes) and `onChange` is called with the full staged list — every entry
 * carrying its Blob — whenever it changes. The form commits; this only collects.
 */
export function attachmentSection({ attachments = [], onChange = null, disabled = false, loadBlob = null } = {}) {
    // A description with no `blob` is an attachment that arrived from another
    // device: shown, counted, and not openable. That is the honest state, and
    // `openOne` says so in words rather than showing a broken player.
    const staged = attachments.map(a => ({ ...a, blob: null }));
    const urls = new Map();

    const grid = h("div", { class: "attachment-grid" });
    const status = h("p", { class: "attachment-status muted", role: "status" });
    const adders = toolbar();

    // An object URL per staged blob, created when a thumbnail needs it and
    // revoked when the entry goes or the page is left. Not on every repaint: a
    // URL revoked and recreated per repaint makes the image flash and re-decodes
    // the photograph each time.
    const urlFor = entry => {
        if (!entry.blob) return null;
        if (!urls.has(entry.id)) urls.set(entry.id, URL.createObjectURL(entry.blob));
        return urls.get(entry.id);
    };
    const release = () => {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
    };
    // Releasing on the route change rather than on a MutationObserver: the app
    // tears a page down by replacing #app's children, and the one signal that
    // fires reliably for "this screen is gone" is the route event dialog.js
    // already uses. A blob URL pins its photograph for the life of the document,
    // and the note form is the screen a user opens and abandons repeatedly.
    //
    // GUARDED BY `element.isConnected`, and it has to be. The router emits
    // "route" at the END of every navigate(), including the one that mounted
    // this form — so an unguarded release ran on the screen that had just
    // drawn its thumbnails and took the URLs out from under them. Guarding is
    // also what keeps this honest for a form that is mounted and repainted
    // later: the bytes are read after the route event, so the URLs exist after
    // it, and only a navigation that actually detached this element may take
    // them away.
    const offRoute = bus.on("route", () => {
        if (!element.isConnected) release();
    });

    // Adding is refused HERE, at the tap, rather than at save. A user choosing a
    // sixth photograph is told while they are still looking at the five, not
    // three seconds later after a save.
    const admit = (kind, entries) => {
        const room = roomFor(staged, kind);
        let accepted = entries;
        if (accepted.length > room) {
            accepted = accepted.slice(0, room);
            toast.show(kind === "photo" ? "error.photos_limit" : "error.attachments_limit");
        }
        // The per-KIND byte ceiling, at pick time, for the same reason the count
        // is: the whole point of refusing a file is to say so while the user is
        // still holding the alternative. Left to the service it surfaced as a
        // toast on Save, after the file had been shown in the strip as though it
        // were going to be kept.
        // A kind with no per-file byte ceiling — audio, which was given a length
        // rather than a size — must not be filtered against `null`. `size <= null`
        // is `size <= 0`, so the comparison dropped EVERY voice memo at the pick
        // and then reported it with a code that exists in no language file.
        const ceiling = byteCeilingFor(kind);
        if (ceiling !== null) {
            const withinBytes = accepted.filter(x => x.size <= ceiling);
            if (withinBytes.length !== accepted.length) {
                accepted = withinBytes;
                toast.show(`error.${kind}_too_large`);
            }
        }
        if (noteBytes() + accepted.reduce((sum, x) => sum + x.size, 0) > MAX_MEDIA_BYTES) {
            accepted = [];
            toast.show("error.attachments_too_large");
        }
        if (!accepted.length) return;
        const at = Date.now();
        for (const entry of accepted) {
            // No `size` here: attachmentService.commit() measures every blob it is
            // given, for every caller, and a second measurement in the UI is a
            // second rule to disagree with it.
            staged.push(stage(entry, { at, id: crypto.randomUUID() }));
        }
        changed();
    };

    const noteBytes = () => staged.filter(x => x.blob).reduce((sum, x) => sum + x.size, 0);

    const changed = () => {
        paint();
        onChange?.(staged.map(x => ({ ...x })));
    };

    // --- the four ways in ---------------------------------------------------

    const addPhotos = async () => {
        if (!roomFor(staged, "photo")) return toast.show("error.photos_limit");
        const files = await pickFiles({ accept: ACCEPT.photo, multiple: true });
        const entries = [];
        for (const file of files) {
            if (classify(file) === "photo") entries.push(await prepare(file, "photo"));
        }
        admit("photo", entries);
    };

    // The one "anything else" button. It accepts every kind rather than only
    // documents, so a voice memo or a clip already in the phone's storage is
    // one tap away instead of unreachable — `classify` puts each chosen file in
    // the right kind on the way in, so a wide accept list costs nothing but
    // convenience.
    const addFiles = async () => {
        const files = await pickFiles({ accept: ACCEPT.any, multiple: true });
        const byKind = new Map();
        for (const file of files) {
            const kind = classify(file);
            if (!kind) continue;
            if (!byKind.has(kind)) byKind.set(kind, []);
            byKind.get(kind).push(await prepare(file, kind));
        }
        // Photos go last, so a mixed selection that runs out of room drops the
        // file the user was least likely to have meant rather than the five
        // photographs they had already chosen.
        for (const kind of ["document", "audio", "video", "photo"]) {
            if (byKind.has(kind)) admit(kind, byKind.get(kind));
        }
    };

    const record = async kind => {
        const captured = kind === "video" ? await recordVideo() : await recordAudio();
        if (!captured?.blob?.size) return;
        const key = kind === "video" ? "defaultVideoName" : "defaultAudioName";
        admit(kind, [{
            kind,
            name: displayName(t(`attachments.${key}`), kind),
            type: captured.blob.type,
            size: captured.blob.size,
            durationMs: captured.durationMs,
            width: null,
            height: null,
            blob: captured.blob
        }]);
    };

    // --- the one thing a thumbnail does -------------------------------------

    // A photograph is a picture; a recording is a play glyph and its length; a
    // document is a sheet and its extension, in capitals, because "PDF" is what
    // a person recognises about a document at a glance and it costs four
    // characters.
    const thumb = entry => {
        const url = urlFor(entry);
        let glyph;
        if (entry.kind === "photo") {
            glyph = url
                ? h("img", { class: "attachment-thumb-img", src: url, alt: "", loading: "lazy" })
                : uiIcon("image", { className: "icon attachment-thumb-glyph" });
        } else if (entry.kind === "document") {
            glyph = h("span", { class: "attachment-thumb-glyph" },
                uiIcon("file"),
                h("span", { class: "attachment-thumb-ext" }, extensionOf(entry.name).toUpperCase()));
        } else {
            glyph = h("span", { class: "attachment-thumb-glyph" },
                uiIcon(attachmentIcon(entry.kind)),
                h("span", { class: "attachment-thumb-time" }, formatClock(entry.durationMs ?? 0)));
        }
        return h("div", { class: "attachment-thumb", dataset: { kind: entry.kind, local: entry.blob ? "yes" : "no" } },
            h("button", {
                class: "attachment-thumb-open",
                type: "button",
                onClick: () => openOne(entry),
                "aria-label": t("attachments.openNamed", { name: entry.name })
            }, glyph),
            h("span", { class: "attachment-thumb-name" }, entry.name),
            h("button", {
                class: "attachment-remove",
                type: "button",
                "aria-label": t("attachments.removeNamed", { name: entry.name }),
                onClick: () => {
                    const at = staged.findIndex(x => x.id === entry.id);
                    if (at < 0) return;
                    const [gone] = staged.splice(at, 1);
                    if (gone.blob && urls.has(gone.id)) {
                        URL.revokeObjectURL(urls.get(gone.id));
                        urls.delete(gone.id);
                    }
                    changed();
                }
            }, uiIcon("close"))
        );
    };

    // The viewer. It lives here rather than in its own module because it is only
    // ever reached from a thumbnail, and because it is the one place that has to
    // cope with "described here, bytes elsewhere" — the state every attachment
    // on a second device is in.
    const openOne = entry => {
        if (!entry.blob) {
            toast.show("error.attachment_not_here");
            return;
        }
        const url = urlFor(entry);
        const media = entry.kind === "photo"
            ? h("img", { class: "attachment-view-img", src: url, alt: entry.name })
            : entry.kind === "video"
                ? h("video", { class: "attachment-view-media", src: url, controls: true, playsInline: true })
                : entry.kind === "audio"
                    ? h("audio", { class: "attachment-view-audio", src: url, controls: true, autoplay: true })
                    : h("p", { class: "muted" }, t("attachments.documentOnlyName", { name: entry.name }));
        dialog.form(null, {
            titleKey: "attachments.viewing",
            submit: null,
            body: () => h("div", { class: "attachment-view" },
                media,
                listRow({
                    icon: attachmentIcon(entry.kind),
                    title: entry.name,
                    subtitle: describeOne(entry),
                    meta: [badge(t("attachments.storedOnDevice"), { icon: "device" })]
                })
            )
        });
        // Nothing to do with the answer, and nothing that can go wrong: the dialog
        // RESOLVES with CANCELLED when it is dismissed, it does not reject, and a
        // viewer has no result to act on either way.
    };

    // --- paint --------------------------------------------------------------

    const paint = () => {
        grid.replaceChildren(...staged.map(thumb));
        grid.hidden = !staged.length;

        const photosLeft = roomFor(staged, "photo");
        const filesLeft = roomFor(staged, "document");
        adders.replaceChildren(
            action({
                label: t("attachments.addPhotos"),
                icon: "image",
                disabled: disabled || photosLeft <= 0,
                onClick: addPhotos
            }),
            action({
                label: t("attachments.addAudio"),
                icon: "mic",
                disabled,
                onClick: () => record("audio")
            }),
            action({
                label: t("attachments.addVideo"),
                icon: "video",
                disabled,
                onClick: () => record("video")
            }),
            action({
                label: t("attachments.addFile"),
                icon: "file",
                disabled: disabled || filesLeft <= 0,
                onClick: addFiles
            })
        );

        // What is staged, and how much of the photograph allowance is left. The
        // second half only appears when it is running out: a permanent "5
        // remaining" on a screen with nothing attached is a number nobody reads.
        const parts = [];
        const summary = attachmentSummary(staged, counts => counts
            .map(({ kind, count }) => countLabel(kind, count))
            .join(" · "));
        if (summary) parts.push(summary);
        if (noteBytes()) parts.push(formatBytes(noteBytes()));
        if (staged.length && photosLeft <= 2) {
            parts.push(t("attachments.photosLeft", { count: photosLeft, max: MAX_PHOTOS_PER_NOTE }));
        }
        if (!staged.length) parts.push(t("attachments.empty"));
        status.textContent = parts.join(" · ");
    };

    const element = h("div", { class: "attachment-section" },
        h("h3", { class: "attachment-heading" }, t("attachments.title")),
        status,
        grid,
        adders
    );

    paint();

    // The bytes for the entries this section was GIVEN, loaded here rather than by
    // the caller.
    //
    // The section owns `staged`, and it always did: the add button pushes into it,
    // the remove button splices out of it, and `onChange` reports it. A caller
    // that loaded the blobs into a copy of its own was writing to an array
    // nothing renders, and the photograph that had been saved came back as a
    // glyph — the note said "1 photo" and the note could not open it. That is the
    // whole of "the file stayed on the device it was added from": the description
    // synced, the bytes were already gone, and only this list knew where to look.
    //
    // So `loadBlob(attachmentId)` is asked per attachment, each blob is written
    // into the entry it belongs to, and the grid is painted again. One owner, one
    // list, and a liveness check so a form abandoned mid-read paints nothing.
    //
    // LIVENESS IS `element.isConnected`, NOT A ROUTE EVENT, and the difference is
    // the whole of "images do not appear until you tap them".
    //
    // The router emits "route" at the END of every navigate() — including the one
    // that MOUNTED this form. So a `disposed` flag set by that event was already
    // true before the first IndexedDB read could resolve, `paint()` was skipped on
    // every path, and the grid kept drawing the glyph it starts with. The bytes
    // were loaded and written into their entries correctly, which is why tapping
    // the glyph opened the photograph and the note was otherwise intact: the
    // picture was there and simply had never been drawn. A saved photo came back
    // as a placeholder, and the only way to see it was to open it.
    //
    // `isConnected` is asked at the moment the answer matters — after the reads,
    // before the repaint — and the router detaches the old view by replacing
    // #app's children, so a form the user has navigated away from is not
    // connected and paints nothing. It is also a property of the thing being
    // painted rather than of an unrelated global event, which means there is no
    // subscription to leak: the old listener was only removed on the success
    // path, so every abandoned form left one behind for the life of the document.
    if (loadBlob && attachments.length) {
        Promise.all(attachments.map(async a => {
            const blob = await loadBlob(a.id);
            const entry = staged.find(x => x.id === a.id);
            if (entry && blob) entry.blob = blob;
        })).then(() => {
            if (!element.isConnected) return;
            paint();
            // The caller is told, because its copy of the list has to agree: it is
            // what gets submitted, and a list without the bytes would delete them.
            onChange?.(staged.map(x => ({ ...x })));
        }).catch(() => {
            // Nothing to undo and nothing to repaint: an attachment whose bytes
            // could not be read keeps the glyph it is already drawn with, which
            // is the honest state, and the status line still counts it.
        });
    }

    return {
        element,
        /** The staged list, for a caller that wants it without a change event. */
        list: () => staged.map(x => ({ ...x })),
        release
    };
}
