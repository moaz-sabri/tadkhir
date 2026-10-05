import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";
import { action } from "./ui.js";
import { formatBytes } from "./attachments.js";
import { pickFiles, probeImage, shrinkPhoto } from "../../app/capture.js";
import { recordAudio, recordVideo } from "./recorder.js";
import {
    ACCEPT,
    PHOTO_LONG_EDGE,
    PHOTO_QUALITY,
    byteCeilingFor,
    displayName,
    kindForFile
} from "../../domain/attachments.js";

// "The picture IS the thing I want to come back to."
//
// Everywhere else in the feature, media is something you ADD to a note: open
// the form, find the section, press a button, choose a file. That is four steps
// between wanting to remember a photograph and having remembered it, and for the
// common case — a whiteboard, a receipt, a label — the note has no words in it
// at all, so the form is four steps around an empty text box.
//
// This is the other door: capture or pick, name it if you want to, and it is a
// Later item. The caption is offered afterwards and is genuinely optional, and
// the item that comes out is the ordinary record every other Later item is, so
// everything afterwards — following it up, renaming it, adding a second photo,
// deleting one, deleting the lot — is the same screen as always.
//
// Which is the point. A separate kind of "media item" would be a second thing to
// keep working, and this is a note that happens to lead with a picture.

/**
 * Capture or pick one file, describe it, and hand back a stager.
 *
 * Resolves `null` for anything that is not a usable capture: the picker was
 * dismissed, the type is not one a note can hold, or the recording was too short.
 * A refusal is a message on the screen and not an exception, because every
 * caller here is a button.
 */
export async function captureOne(kind) {
    if (kind === "audio") return fromRecorder("audio");
    if (kind === "video") return fromRecorder("video");

    const files = await pickFiles({ accept: ACCEPT.photo, multiple: true });
    if (!files.length) return null;

    // A short list here, not five. A camera roll of twenty is not "something to
    // remember later", it is a camera roll, and the screen that appears next has
    // room for a decision a person makes about a few things rather than twenty.
    const usable = [];
    let refused = 0;
    for (const file of files.slice(0, 5)) {
        if (kindForFile(file) !== "photo") {
            refused++;
            continue;
        }
        usable.push(await describePhoto(file));
    }
    if (!usable.length) {
        if (refused) toast.show("error.attachment_kind");
        return null;
    }
    if (files.length > 5) toast.show("error.photos_limit");

    return describeAndConfirm(usable, { multi: usable.length > 1 });
}

/** A photograph: downscaled, and measured by the decoder rather than believed. */
async function describePhoto(file) {
    const blob = await shrinkPhoto(file, { longEdge: PHOTO_LONG_EDGE, quality: PHOTO_QUALITY });
    const { width, height } = await probeImage(blob);
    return {
        kind: "photo",
        name: displayName(file.name, "photo"),
        type: blob.type || file.type || "image/jpeg",
        size: blob.size,
        durationMs: null,
        width,
        height,
        blob
    };
}

/** A recording, whose length the recorder measured itself. */
async function fromRecorder(kind) {
    const captured = kind === "video" ? await recordVideo() : await recordAudio();
    if (!captured?.blob?.size) return null;
    const key = kind === "video" ? "defaultVideoName" : "defaultAudioName";
    return describeAndConfirm([{
        kind,
        name: displayName(t(`attachments.${key}`), kind),
        type: captured.blob.type || null,
        size: captured.blob.size,
        durationMs: captured.durationMs,
        width: null,
        height: null,
        blob: captured.blob
    }], { multi: false });
}

/**
 * Show what was captured, let it be named, and hand back the stagers.
 *
 * The preview is the point of this dialog. Without it, a camera button that
 * creates a record is a button that creates a record the person cannot see yet,
 * and the first thing they would want to know is whether they actually got the
 * whiteboard or the ceiling.
 */
export function describeAndConfirm(entries, { multi }) {
    return new Promise(resolve => {
        let settled = false;
        const done = value => {
            if (settled) return;
            settled = true;
            // ONLY the preview URLs are released here. The dialog tears its own
            // DOM down (dialog.js clears #dialog-root), so there is nothing else
            // to remove — and the line that used to say `input.remove()` was
            // referring to an identifier that does not exist in this scope.
            //
            // It was a copy of the picker cleanup in capture.js, and it threw a
            // ReferenceError on the first line of every exit path. That throw
            // happened INSIDE the `.then()` below, so the dialog's own promise
            // still resolved — and `.catch(() => done(null))` swallowed the
            // error and called `done` a second time, which returned early
            // because `settled` was already true. The caller therefore received
            // `null` for a capture it had actually taken: the dialog closed, no
            // note was written, and nothing was said. Every photo, voice memo
            // and clip taken from the quick field vanished with no error, which
            // is the whole of "attaching an image does not work".
            //
            // `resolve` is last so nothing above can throw its way past it.
            for (const url of urls) URL.revokeObjectURL(url);
            resolve(value);
        };

        // One URL per staged blob, revoked on every exit. A dialog that leaks its
        // preview pins a photograph in memory for the life of the document, and
        // this one is opened by a button that people press more than once.
        const urls = entries.map(e => URL.createObjectURL(e.blob));

        const name = h("input", {
            type: "text",
            maxLength: 120,
            value: multi ? "" : entries[0].name,
            placeholder: t("later.mediaNamePlaceholder"),
            "aria-label": t("later.mediaNameField")
        });
        const errorId = "later-media-name-error";
        const error = h("p", { class: "field-error", id: errorId, role: "status" });

        const previews = h("div", { class: "media-previews" }, ...entries.map((entry, i) => {
            const url = urls[i];
            const media = entry.kind === "photo"
                ? h("img", { class: "media-preview-img", src: url, alt: "" })
                : entry.kind === "video"
                    ? h("video", { class: "media-preview-img", src: url, controls: true, playsInline: true })
                    : h("audio", { class: "media-preview-audio", src: url, controls: true, autoplay: true });
            return h("figure", { class: "media-preview" },
                media,
                h("figcaption", { class: "muted small" }, [
                    formatBytes(entry.size),
                    entry.durationMs ? ` · ${Math.round(entry.durationMs / 1000)}s` : null,
                    // The ceiling is named here rather than discovered on save.
                    byteCeilingFor(entry.kind) !== null
                        ? ` · max ${formatBytes(byteCeilingFor(entry.kind))}`
                        : null
                ].filter(Boolean).join(" "))
            );
        }));

        const body = h("div", { class: "media-capture" },
            previews,
            h("label", { class: "field" },
                h("span", { class: "label" }, t("later.mediaNameField")),
                name,
                error
            )
        );

        dialog.form(null, {
            titleKey: multi ? "later.mediaCapturedMany" : "later.mediaCaptured",
            submitLabel: "common.add",
            submitIcon: "check",
            body: () => body,
            submit: close => {
                const label = name.value.trim();
                if (label.length > 120) {
                    error.textContent = t("error.too_long");
                    name.focus();
                    return;
                }
                // The name the user gave becomes the note's TITLE, not the
                // attachment's file name: "Shelf labels" is a thing to come back
                // to, and "IMG_0042.jpg" is not. The file name is kept underneath
                // so a later rename of the item does not lose it.
                close(label ? entries.map(e => ({ ...e, name: label })) : entries);
            }
        }).then(result => {
            if (result === dialog.CANCELLED) done(null);
            else done(result);
        }).catch(() => done(null));
    });
}

/** The four ways in, as a small row of buttons. Used by the list and the form. */
export function mediaButtons({ onPick, disabled = false } = {}) {
    return [
        action({ label: t("later.capturePhoto"), icon: "image", disabled, onClick: () => onPick("photo") }),
        action({ label: t("later.captureAudio"), icon: "mic", disabled, onClick: () => onPick("audio") }),
        action({ label: t("later.captureVideo"), icon: "video", disabled, onClick: () => onPick("video") })
    ];
}
