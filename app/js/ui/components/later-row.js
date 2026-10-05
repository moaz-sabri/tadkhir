import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { laterLabel, hostOf, isDone } from "../../domain/later.js";
import { richTextLines } from "../../domain/rich-text.js";
import { formatDateTime } from "../../domain/time.js";
import { listRow, rowAction, badge } from "./ui.js";
import {
    attachmentIcon,
    attachmentCountsLabel,
    attachmentSummary,
    isMediaLed,
    leadPhoto
} from "./attachments.js";

// One item in the Later list. The row itself is a link to the edit page, exactly
// like a task or a transaction row, and the actions sit beside it as icons —
// the same shape as every other list in the app.
//
// Whether there is a link to open is read off the item rather than passed in: a
// note has no url, so the button would have nothing to point at. `onDone` is the
// same callback either way — the row says which way it would move the item, the
// service decides.
//
// `onAddToBoard` is passed only for an item that is NOT already on the board.
// The board is a view over records from other services, so a row here is the one
// door into it; an item already on the board simply does not offer the button,
// because a second "add" that quietly does nothing is worse than no button.
export function laterRow(item, { onDone = null, onDelete = null, onAddToBoard = null, thumbUrl = null } = {}) {
    const done = isDone(item);
    // A note that is three photographs and no words still has a label, and it
    // says what is on it rather than repeating "Untitled" on every such row.
    const label = laterLabel(item, attachmentCountsLabel) ?? t("later.untitled");
    // The second line never repeats the first. A titled link has no line of its
    // own to show, so its preview is where it points; an untitled link is already
    // labelled by its host, so its preview is the reason it was saved; a note is
    // labelled by its first line, so its preview is what follows it.
    const titled = Boolean((item.title ?? "").trim());
    const preview = item.type === "link"
        ? (titled ? hostOf(item.url) : textPreview(item, false))
        : textPreview(item, true);

    return listRow({
        href: `/later/${item.id}`,
        // A picture when the item IS one, and a glyph otherwise. The bytes have
        // to be fetched to draw it, so the URL is passed in by the page — a row
        // that has no bytes on this device gets the glyph, which is the honest
        // answer rather than an empty frame.
        thumb: thumbUrl ? h("img", { src: thumbUrl, alt: "", loading: "lazy" }) : null,
        icon: item.type === "link" ? "link" : isMediaLed(item) ? "image" : "note",
        title: label,
        subtitle: preview,
        // A followed-up item says so in words, not only by being dimmed: the
        // date alone does not tell a reader whether the item is still open.
        meta: [
            badge(
                done
                    ? t("later.doneAt", { date: formatDateTime(item.completedAt) })
                    : formatDateTime(item.createdAt),
                { icon: done ? "checked" : "calendar" }
            ),
            // What the note carries, as a second badge. Only when it carries
            // something: a badge on every row saying nothing is furniture.
            attachmentSummary(item.attachments)
                ? badge(attachmentCountsLabel(item.attachments), {
                    // The icon of what is attached, not a generic "attachment"
                    // mark: a row of voice memos and a row of receipts should not
                    // be told apart by the same glyph.
                    icon: attachmentIcon(leadPhoto(item) ? "photo" : (item.attachments?.[0]?.kind ?? "file"))
                })
                : null
        ].filter(Boolean),
        actions: [
            item.type === "link"
                ? rowAction({
                    label: t("later.openLink"),
                    icon: "external",
                    href: item.url,
                    external: true
                })
                : null,
            onDone
                ? rowAction({
                    label: done ? t("later.reopen") : t("later.markDone"),
                    icon: done ? "undo" : "check",
                    onClick: onDone
                })
                : null,
            // Only on the OPEN list: an item already followed up does not need to
            // be on a board, and putting a finished item on one would ask the
            // board to show something the user has already dealt with.
            onAddToBoard && !done
                ? rowAction({
                    label: t("kanban.addToBoard"),
                    icon: "kanban",
                    onClick: onAddToBoard
                })
                : null,
            onDelete
                ? rowAction({ label: t("common.delete"), icon: "trash", onClick: onDelete })
                : null
        ].filter(Boolean)
    });
}

// The item's text, flattened to one clamped line. `skipFirstLine` leaves out the
// line the row is already labelled with; empty when nothing is left, and the
// caller renders no second line at all rather than an empty one.
//
// The formatting is parsed away rather than shown raw: a note whose second line
// is "see **the docs** at https://…" should read as a sentence in a list, not as
// the source it happens to be stored as. One line is not a place to show bold.
function textPreview(item, skipFirstLine) {
    const lines = richTextLines(item.content).map(l => l.trim()).filter(Boolean);
    return (skipFirstLine ? lines.slice(1) : lines).join(" ").slice(0, 140);
}
