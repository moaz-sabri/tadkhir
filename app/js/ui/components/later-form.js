import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { iconPicker } from "./icon-picker.js";
import { markdownEditor } from "./markdown-editor.js";
import { field, fieldError, formShell, saveButton } from "./fields.js";
import { attachmentSection, isMediaLed } from "./attachments.js";
import { attachmentService } from "../../services/attachment-service.js";
import { MAX_TITLE, MAX_NOTE, LATER_TYPES } from "../../domain/validation.js";
import { attachmentList } from "../../domain/attachments.js";

// The Later form, used for both a new item and an edit — the only difference
// between them is whether a record was passed in.
//
// Three fields, no more: a kind, a title that is always optional, and then the
// one body the chosen kind needs. The kind decides which of the two bodies is
// on screen, so a link never asks for a note it does not need and a note never
// asks for a url it cannot store.
//
// A chain for a link, a page of lines for a note. Both named in the registry
// rather than drawn here, like every other glyph in the app.
const KIND_ICONS = {
    link: "link",
    note: "note"
};

export function laterForm(item, onSave) {
    const kind = iconPicker({
        group: "later-kind",
        label: t("later.type"),
        icons: KIND_ICONS,
        labels: { link: t("later.url"), note: t("later.note") },
        // note first in the list, so it is also the default for a new item: a
        // thought is the common case, and a link is the one that can be shared
        // in without opening the app at all.
        options: LATER_TYPES,
        value: item?.type ?? "note"
    });

    const titleErrorId = "later-title-error";
    const title = h("input", {
        type: "text",
        maxLength: MAX_TITLE,
        value: item?.title ?? "",
        autocomplete: "off",
        placeholder: t("later.titlePlaceholder"),
        "aria-describedby": titleErrorId
    });
    const titleError = fieldError(titleErrorId);

    const urlErrorId = "later-url-error";
    const url = h("input", {
        type: "url",
        inputMode: "url",
        autocomplete: "off",
        placeholder: t("later.urlPlaceholder"),
        value: item?.url ?? "",
        "aria-describedby": urlErrorId
    });
    const urlError = fieldError(urlErrorId);
    // A bare host is accepted on purpose, so `type=url` (which would reject
    // "example.com" before the app ever sees it) cannot be the gate: the
    // service normalizes the scheme, and it is the one that decides.
    const urlNode = field(t("later.url"), url, urlError);

    // The note body is the app's other free-text field, so it is the same
    // formatting editor a page line is: bold, italic, code, links and bullets,
    // with a live preview. What is saved is still a plain string, so a note is
    // still a note — the same record, the same limits, the same sync.
    const contentErrorId = "later-content-error";
    const noteEditor = markdownEditor({
        value: item?.content ?? "",
        maxLength: MAX_NOTE,
        placeholder: t("later.notePlaceholder"),
        describedBy: contentErrorId,
        onSubmit: () => form.requestSubmit()
    });
    const content = noteEditor.textarea;
    const contentError = fieldError(contentErrorId);
    // On a media-led form the body is a caption on the picture above it, not the
    // note itself, and the caption is optional — the item is already complete
    // without it. Saying so is the difference between a field that looks required
    // and is not, and a field that is neither.
    const contentNode = field(
        isMediaLed(item) ? t("later.captionField") : t("later.note"),
        noteEditor.element,
        contentError
    );
    contentNode.classList.add("note-body-field");

    // Photos, recordings and documents. The section only ever STAGES them: the
    // submit handler below is the one thing that writes, so a note abandoned
    // after four photographs leaves nothing on the device — and, more to the
    // point, a half-typed note with three attachments is one Cancel away from
    // not existing at all.
    // Seeded from the item, NOT left empty. This list is what the form submits,
    // and `attachmentService.commit()` deletes the bytes of any attachment the
    // record still describes but this list does not mention. So a form that opened
    // on a note with a photograph and was saved without touching the attachment
    // section submitted an EMPTY list, the photograph's bytes were deleted, and
    // the note was left saying "1 photo" with nothing behind it — which is what
    // "the file stayed on the device it was added from" turned out to be. The
    // descriptors come from the record, so the record is where this starts.
    let staged = attachmentList(item);
    const section = attachmentSection({
        attachments: staged,
        // The section loads the bytes for what it was given, and reports the list
        // back. See attachments.js: the section owns the list, and a caller
        // holding a second copy of it is how a saved photograph came back a glyph.
        loadBlob: item?.id ? id => attachmentService.blobOf(item.id, id) : null,
        onChange: list => {
            staged = list;
            // The note body stops being required the moment the note carries
            // something to look at instead of words. Re-checked here rather than
            // only on submit, so the caption on the field and the requirement
            // cannot disagree about what a complete note is.
            applyKind();
        }
    });
    // The section reports its own refusals — a status line that counts what is
    // staged, and a toast naming the ceiling that was hit — so no field-error
    // node is declared here. An error line that can never carry an error is worse
    // than none: it is a promise the markup makes and the code does not keep.
    const attachmentsNode = h("div", { class: "attachment-field" }, section.element);

    // One field visible at a time, driven by the kind. Nothing is thrown away on
    // a switch in either direction: the service keeps what fits and drops what
    // the new kind cannot store (a note has no url).
    function applyKind() {
        const isLink = kind.read() === "link";
        urlNode.hidden = !isLink;
        content.required = !isLink && !staged.length;
    }
    kind.onChange(applyKind);
    applyKind();

    const save = saveButton();

    // WHERE THE MEDIA GOES IS THE WHO OF THIS FORM.
    //
    // A note that is three photographs and no words opens on a form whose first
    // field is an empty text box and whose picture is below the fold. That is the
    // item the user came to look at, and the form does not show it: they open
    // "a note", see a caption field with nothing in it, and have to scroll to
    // discover there is anything to edit at all.
    //
    // So a media-led item leads with its media, and a note with words does not.
    // The rule is the one `isMediaLed` states rather than a second opinion held
    // here: attachments and no caption. Nothing the user was reading moves, because
    // on such an item there is nothing to read.
    const mediaLed = isMediaLed(item);
    const fields = mediaLed
        ? [kind.node, attachmentsNode, field(t("later.titleField"), title, titleError), urlNode, contentNode]
        : [kind.node, field(t("later.titleField"), title, titleError), urlNode, contentNode, attachmentsNode];
    if (mediaLed) attachmentsNode.classList.add("attachment-field-lead");

    const form = formShell(fields, save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        titleError.textContent = "";
        urlError.textContent = "";
        contentError.textContent = "";

        const patch = {
            type: kind.read(),
            title: title.value.trim() || null,
            content: content.value.trim() || null,
            url: url.value.trim() || null,
            // The DESCRIPTIONS, with the blobs left out. This is the half that
            // belongs to the record and travels; the blobs are the half that
            // does not, and they go to the caller separately.
            attachments: staged.map(({ blob, ...descriptor }) => descriptor)
        };
        // The two checks a form can make without knowing the rules: a link needs
        // a url, a note needs text or something to look at. Lengths, the url
        // scheme and the attachment ceilings belong to the service, and come
        // back as these same field-level messages.
        if (patch.type === "link" && !patch.url) {
            urlError.textContent = t("error.required");
            url.focus();
            return;
        }
        if (patch.type === "note" && !patch.content && !staged.length) {
            contentError.textContent = t("error.required");
            content.focus();
            return;
        }

        save.disabled = true;
        try {
            // Two arguments, and the split is the whole design of the feature:
            // the patch is what the record is made of, and `files` is the bytes
            // that record will describe but will not carry. The page knows how
            // to put both in the right places.
            await onSave(patch, staged);
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
