import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { rowAction } from "./ui.js";
import { richTextInto } from "./rich-text.js";

// A textarea that can format: the same plain control the app already had, plus a
// small bar of formatting buttons and a live preview of what the text will read
// as. It STORES the source, not a rendered document — see domain/rich-text.js
// for why that is the decision and not an accident.
//
// Three parts, and each one is there for a reason:
//
//   bar      — five actions: bold, italic, code, link, and a bullet on the
//              selected lines. They act on the selection, which is the only
//              thing a plain textarea has to work with, and they insert the
//              markers the parser already knows. There is no state to keep in
//              step with anything, because the source IS the state.
//   preview  — the text as it will read, rebuilt from the same parser the read
//              view uses. `aria-hidden`, because it repeats a field the user is
//              already inside, and a screen reader should not read it twice.
//   textarea — unchanged, and it saves itself exactly as before.
//
// The bar and the preview appear only while the field has focus, and that is
// done in CSS (`.md:focus-within`) rather than in JavaScript. It matters here:
// a page can hold a thousand lines, and a thousand toolbars and a thousand
// preview subtrees in the document is a thousand times the work for a control
// nobody is looking at. The preview subtree is additionally emptied on blur, so
// the cost is only ever paid for the line being edited.

/** What the bar can do, in the order it does it. A table, because the parser
 *  is what these insert and the two must not be allowed to disagree. */
const TOOLS = [
    { key: "bold", icon: "bold", wrap: "**" },
    { key: "italic", icon: "italic", wrap: "*" },
    { key: "code", icon: "code", wrap: "`" },
    { key: "link", icon: "link", link: true },
    { key: "list", icon: "list", prefix: "- " }
];

// The preview is a visual echo, so it may lag a little — but not so much that it
// answers a question the user is no longer asking. Also why it is not rebuilt on
// the keystroke itself: a 4000-character line is a few hundred tokens, and doing
// that per letter is the kind of cost that only shows up on a slow phone.
const PREVIEW_MS = 300;

/**
 * A formatting textarea.
 *
 * `onInput` fires for typing AND for a button press, because both change the
 * value; a caller that autosaves listens to that one event and does not care
 * which it was. The change is announced with a real `input` event, so the
 * caller's own listener and any others still fire — nothing here writes to the
 * DOM around the field, which is what keeps the caret where the user left it.
 *
 * `singleLine` is for a heading: Enter saves and leaves rather than opening a
 * second line the service would refuse.
 */
export function markdownEditor({
    value = "",
    placeholder = "",
    ariaLabel = null,
    describedBy = null,
    rows = 3,
    maxLength = null,
    onInput = null,
    onSubmit = null,
    singleLine = false,
    className = "page-text"
} = {}) {
    const textarea = h("textarea", {
        class: className,
        rows,
        maxLength,
        placeholder,
        "aria-label": ariaLabel,
        "aria-describedby": describedBy
    }, value);

    const preview = h("div", { class: "md-preview prose", "aria-hidden": "true" });
    let previewTimer = null;
    let previewLive = false;

    // Rebuilt in place, never replaced: a fresh element would reset its scroll
    // position, and a long note scrolled to the middle must stay there.
    const refreshPreview = () => richTextInto(preview, textarea.value);
    const schedulePreview = () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            previewTimer = null;
            if (previewLive) refreshPreview();
        }, PREVIEW_MS);
    };

    const bar = h("div", { class: "md-bar" },
        ...TOOLS.map(tool => rowAction({
            // rowAction, not action: these are icon-only controls, and the kit's
            // own rule for one is that the word becomes the accessible name AND
            // the tooltip while the drawing stays a square. A bare `action()`
            // with a label puts the word in the tooltip only — correct for a
            // button that shows it, wrong for one that does not.
            label: t(`richText.${tool.key}`),
            // The same word as the tooltip as well, which rowAction leaves to the
            // caller. Worth passing here and worth saying why: three of these
            // have a keyboard shortcut, and a shortcut nobody can discover is not
            // a shortcut. The visible tooltip is the only place a pointer user
            // will ever see it.
            title: t(`richText.${tool.key}`),
            icon: tool.icon,
            onClick: () => applyTool(tool)
        }))
    );

    function applyTool(tool) {
        if (tool.link) insertLink(textarea);
        else if (tool.prefix) togglePrefix(textarea, tool.prefix);
        else wrapSelection(textarea, tool.wrap);
        // The preview is the user looking at the result of the button they just
        // pressed, so it is not debounced here.
        if (previewLive) refreshPreview();
    }

    textarea.addEventListener("focus", () => {
        previewLive = true;
        refreshPreview();
    });
    textarea.addEventListener("blur", () => {
        clearTimeout(previewTimer);
        previewTimer = null;
        previewLive = false;
        // Emptied, not hidden: a thousand empty divs cost nothing, a thousand
        // rendered paragraphs cost a great deal.
        preview.replaceChildren();
    });
    textarea.addEventListener("input", schedulePreview);
    if (onInput) textarea.addEventListener("input", () => onInput(textarea.value));

    textarea.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (onSubmit) onSubmit();
            return;
        }
        if (e.key === "Enter" && singleLine && !e.shiftKey) {
            // A heading is one line: Enter saves and leaves the field rather than
            // opening a second one the service would refuse.
            e.preventDefault();
            textarea.blur();
            return;
        }
        // The three everyone already has in muscle memory. `e.key` rather than
        // `e.code`, so a layout where the letter moves still gets the letter.
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const shortcut = { b: "bold", i: "italic", k: "link" }[e.key.toLowerCase()];
        const tool = shortcut && TOOLS.find(x => x.key === shortcut);
        if (!tool) return;
        e.preventDefault();
        applyTool(tool);
    });

    return {
        element: h("div", { class: "md" }, bar, textarea, preview),
        textarea,
        focus: () => textarea.focus()
    };
}

// ------------------------------------------------------------------- editing

// Every one of these ends in the same two steps: write the value, then announce
// it with a real `input` event so the caller's autosave sees a change it did not
// type. The value is written BEFORE the selection is set, because assigning
// `value` collapses the selection to the end of the field.
function committed(textarea, value, from, to) {
    textarea.value = value;
    textarea.focus();
    textarea.setSelectionRange(from, to);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Put a marker on each side of the selection. An empty selection gets the words
// the parser will read between them, so the button always does something
// visible instead of inserting two stars where the caret happened to be.
function wrapSelection(textarea, marker) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const chosen = value.slice(start, end);
    const inside = chosen === "" ? t("richText.example") : chosen;
    committed(
        textarea,
        value.slice(0, start) + marker + inside + marker + value.slice(end),
        start + marker.length,
        start + marker.length + inside.length
    );
}

// `[label](url)`. The label is the selection; the caret lands between the
// parentheses, which is the part the user still has to type. Deliberately no
// scheme is inserted: the parser refuses a link without one, and pre-typing
// `https://` into every link is a habit, not a help.
function insertLink(textarea) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const label = value.slice(start, end);
    const insert = label === "" ? "[text]()" : `[${label}]()`;
    // `insert.length - 1` is the offset of the closing paren from the start of
    // the insertion, and one before that is between the brackets — the same for
    // a chosen label and for the placeholder, because the parens are the last two
    // characters either way.
    const between = start + insert.length - 1;
    committed(textarea, value.slice(0, start) + insert + value.slice(end), between, between);
}

// A marker on every line the selection touches — the one action here that is not
// about a span. A second press takes it off again, because a button that can
// only be pressed once is a trap when the user changes their mind.
function togglePrefix(textarea, prefix) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const from = value.lastIndexOf("\n", start - 1) + 1;
    const stop = value.indexOf("\n", end);
    const to = stop === -1 ? value.length : stop;
    const lines = value.slice(from, to).split("\n");
    const on = lines.every(line => line.startsWith(prefix));
    const rewritten = (on ? lines.map(l => l.slice(prefix.length)) : lines.map(l => prefix + l)).join("\n");
    committed(textarea, value.slice(0, from) + rewritten + value.slice(to), from, from + rewritten.length);
}
