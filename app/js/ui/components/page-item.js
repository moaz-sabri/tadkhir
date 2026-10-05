import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { listRow, rowAction, actionRow } from "./ui.js";
import { markdownEditor } from "./markdown-editor.js";
import { onFlush } from "../../app/flush.js";
import { itemText } from "../../domain/pages.js";
import { MAX_PAGE_TEXT } from "../../domain/validation.js";

// One line on a page. Which shape it takes is decided by the item's kind, and
// every decision about that is here rather than in the screen that lists them —
// so a new kind is one case in this file, not one more `if` in the page.
//
// Three shapes, because the three kinds are three different things:
//
//   words     — a heading or a paragraph, edited in place. The user is typing
//               into a document, so it is a real control and it saves itself.
//   a rule    — a divider, which is only a line and the controls around it.
//   a pointer — a link to a record that lives somewhere else, which is the kit's
//               own row: an `<a>` when the record is there, a muted line when it
//               is not, and never a dead href.
//
// The glyphs are named in the icon registry like everything else in the app, and
// deliberately reuse the ones a screen already uses for these things: a heading
// is a tag, a paragraph is a note, a pointer at a task is the same task glyph
// the nav uses. Nothing new is drawn for a new kind.
//
// Exported because the "what are you adding?" chooser draws from the same table:
// the glyph a kind is chosen by and the glyph it is then shown by cannot be two
// different shapes while there is only one map.
export const PAGE_ITEM_ICONS = {
    text: "note",
    heading: "tag",
    divider: "minus",
    task: "tasks",
    session: "clock",
    reference: "bookmark",
    expense: "wallet"
};

// How long after the last keystroke a line saves itself. Long enough that
// ordinary typing is one write rather than one per letter, short enough that
// the words are already stored a moment after you look up.
const AUTOSAVE_MS = 500;

/**
 * One item, in the page's order.
 *
 * `index` and `count` decide which of the two move controls is available: the
 * first line cannot move up and the last cannot move down, so those two are
 * disabled rather than hidden — a control that appears and disappears changes
 * the width of the row beside it, and a line that is not at the end still needs
 * its actions to be where they were.
 *
 * `resolved` is what the screen knows about the record an item points at:
 *   { href, title, subtitle }  — the record exists, and the row opens it
 *   { missing: true }          — it does not (deleted here or on another device)
 * `onText` receives (item, text) and must NOT re-render the page: it would
 * replace this very control and put the caret back at the start of it.
 */
export function pageItemNode(item, { index = 0, count = 1, resolved = null, onMove = null, onRemove = null, onText = null } = {}) {
    const actions = itemActions({ index, count, onMove, onRemove });
    if (item.type === "divider") return dividerLine(actions);
    if (item.type === "text" || item.type === "heading") return textLine(item, { actions, onText });
    return linkLine(item, { actions, resolved });
}

// The two move controls and the remove, in the same order on every kind of line
// so the columns line up down the page. A move that is already at the end is
// disabled and says why in its tooltip, rather than disappearing.
//
// A flat array, because the two shapes want it differently: listRow() wraps its
// own actions in the trailing cluster, while the editable lines build theirs by
// hand (see textLine). Handing listRow an already-wrapped cluster nests one
// `.row-actions` inside another.
function itemActions({ index, count, onMove, onRemove }) {
    return [
        onMove
            ? rowAction({
                label: t("pages.moveUp"),
                icon: "arrowUp",
                onClick: () => onMove(index, index - 1),
                disabled: index <= 0,
                title: index <= 0 ? t("pages.first") : null
            })
            : null,
        onMove
            ? rowAction({
                label: t("pages.moveDown"),
                icon: "arrowDown",
                onClick: () => onMove(index, index + 1),
                disabled: index >= count - 1,
                title: index >= count - 1 ? t("pages.last") : null
            })
            : null,
        onRemove ? rowAction({ label: t("common.delete"), icon: "trash", onClick: onRemove }) : null
    ].filter(Boolean);
}

// A heading or a paragraph, edited where it sits.
//
// Saved as you type and once more on blur: the debounce covers typing, and the
// blur covers the last word typed just before tapping something else. Both are
// needed — without the blur, a save that was still pending when the page was
// navigated away from would be lost, and a debounce alone is a silent loss
// waiting for the user who types one word and immediately presses Back.
//
// The saved value is tracked so a keystroke that changes nothing writes nothing.
//
// The control is the shared formatting editor, so a line can be written with
// bold, italic, code and links and shows a live preview of how it will read.
// What it stores is still a plain string: the markers, not a rendered document.
function textLine(item, { actions, onText }) {
    const heading = item.type === "heading";
    const label = t(heading ? "pages.headingPlaceholder" : "pages.textPlaceholder");
    const editor = markdownEditor({
        value: itemText(item),
        rows: heading ? 1 : 3,
        maxLength: MAX_PAGE_TEXT,
        placeholder: label,
        ariaLabel: label,
        singleLine: heading,
        onInput: () => schedule()
    });
    const box = editor.textarea;

    let timer = null;
    let saved = box.value;
    const commit = () => {
        clearTimeout(timer);
        timer = null;
        if (box.value === saved) return;
        saved = box.value;
        if (onText) onText(item, box.value);
    };
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(commit, AUTOSAVE_MS);
    };
    box.addEventListener("input", schedule);
    box.addEventListener("blur", commit);
    // A save that is still pending when the tab is hidden would be lost with it,
    // and on a phone the tab is hidden and then frozen without warning. The app
    // flushes every registered save when that happens (app/flush.js).
    onFlush(commit);

    return h("div", { class: `page-line page-line-${item.type}` },
        h("span", { class: "page-glyph" }, uiIcon(PAGE_ITEM_ICONS[item.type])),
        editor.element,
        actionRow(...actions)
    );
}

// A divider: a rule, and nothing else. It is still a line with actions, because
// a divider in the middle of a page is a thing the user may well want to move or
// remove.
function dividerLine(actions) {
    return h("div", { class: "page-line page-line-divider", role: "separator" },
        h("span", { class: "page-glyph" }, uiIcon(PAGE_ITEM_ICONS.divider)),
        h("span", { class: "page-rule" }),
        actionRow(...actions)
    );
}

// A pointer at a record somewhere else in the app.
//
// The row is the kit's row and the title is a link to the original, so tapping
// it opens the task, the session, the follow-up or the money record itself —
// which is the whole promise of the feature, and why nothing here is ever a copy
// of what it points at.
//
// A record that no longer exists is a normal state, not an error: it can be
// deleted on another device at any moment. The row says so in plain words, with
// no href to a screen that would not find it, and it can still be moved and
// removed like any other line.
function linkLine(item, { actions, resolved }) {
    const missing = !resolved || resolved.missing === true;
    return listRow({
        href: missing ? null : resolved.href,
        icon: PAGE_ITEM_ICONS[item.type],
        title: missing ? t("pages.missing") : resolved.title,
        titleClass: missing ? "muted" : "",
        subtitle: missing ? null : (resolved.subtitle || null),
        actions
    });
}
