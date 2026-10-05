// Pure rich text: a small markdown subset parsed into a token tree. No DOM, no
// storage, no strings of HTML — the same shape as domain/later.js and
// domain/pages.js, so the rules are testable directly (tests/rich-text.test.mjs).
//
// WHY MARKDOWN SOURCE AND NOT A WYSIWYG EDITOR
// A rich-text library (Quill and its kind) is a contenteditable surface that
// stores HTML or its own JSON document. That would have cost this project three
// things it has decided not to spend, and all three are architectural rather
// than cosmetic:
//
//   1. The bundle. A WYSIWYG editor is 30-80 KB before compression, on an app
//      whose entire client is one 240 KB file served network-first to a phone
//      that may be offline for a week. This file plus the editor and the
//      renderer is a fraction of that.
//   2. What travels. Every free-text field in the app stores a plain string
//      (`content.text`, `description`, a later note). Switching to HTML blobs
//      makes every sync payload and every backup file several times larger, for
//      markup the client has to re-read and re-interpret on the other device.
//      Storing the SOURCE keeps the data model, the validators, the quotas, the
//      backup format and the sync protocol exactly as they were — a text edit is
//      still a string LWW can resolve.
//   3. The one thing the app cannot afford: an HTML sink. There is no
//      innerHTML anywhere in this codebase, and `h()` can only ever build text
//      nodes, so user text has never once been a markup injection. A WYSIWYG
//      editor's output would have to be parsed and sanitized somewhere, which
//      means the first one in the project. Here the tokens are turned into
//      elements by the same factory as everything else, so there is still no
//      place for a script to land.
//
// The subset is deliberately small, and every exclusion is a decision rather
// than a gap:
//
//   - NO HEADINGS (`#`). The app already has one idea of a heading — a page
//     line of the `heading` kind — and a second one hiding inside a paragraph
//     would be two ways to do the same thing with different results.
//   - NO RAW HTML. `<b>` is the five characters `<b>`. A user who pastes HTML
//     wants to see it, and the one case that matters (text that came from a
//     share or a paste) reads better as literal characters than as silent
//     markup.
//   - NO NESTING. Bold inside a link is not supported, because supporting it
//     turns a single left-to-right scan into a parser with a stack and a set of
//     failure modes. An unmatched marker is literal text, always.
//   - NO IMAGES. They are bytes, and this feature's whole promise is that a
//     page stores pointers and words, not copies.

/** The block shapes the parser can produce, in the order they are documented. */
export const RICH_BLOCK_KINDS = Object.freeze(["p", "ul", "ol", "quote"]);

/** The inline shapes. Flat: none of them contains another. */
export const RICH_INLINE_KINDS = Object.freeze(["text", "strong", "em", "strike", "code", "link"]);

// --------------------------------------------------------------- link policy

// The only rule in this file that decides where the app will navigate, so it is
// written once and used by both the written form and the bare-URL form.
//
// A scheme is required: `[x](example.com)` is text, not a link to a search
// engine, because silently prefixing a scheme is how a link ends up pointing
// somewhere the user did not type. `mailto` is here because it is the one
// non-navigational scheme a note legitimately carries.
const LINK_SCHEMES = /^(?:https?|mailto):/i;

// A control character in an href — a newline above all — is how a URL smuggles
// a second attribute past a naive sink. There is no such sink here (the href
// goes on a real element), but the rule costs one regex and states the intent.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * The href a link token may carry, or null when the text must stay literal.
 *
 * Null is a real answer, not an error: the caller emits the original characters
 * as text, so a note that quotes `[x](javascript:…)` shows what the user wrote.
 */
export function safeHref(raw) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (s === "" || !LINK_SCHEMES.test(s) || CONTROL_CHARS.test(s)) return null;
    return s;
}

// ------------------------------------------------------------------- blocks

const BULLET = /^[-*][ \t]+(.*)$/;
const ORDERED = /^\d{1,9}[.)][ \t]+(.*)$/;
const QUOTE = /^>[ \t]?(.*)$/;

/**
 * The source text as blocks, or [] for anything blank.
 *
 * Line structure is the user's, and it is kept: consecutive plain lines stay
 * one paragraph with their line breaks, a blank line closes a block, and a list
 * item is `-`/`*` or `1.`/`1)`. That is the whole block grammar — enough to make
 * a note read like a note, small enough to hold in one's head.
 */
export function parseRichText(src) {
    const text = typeof src === "string" ? src : "";
    if (text.trim() === "") return [];

    const blocks = [];
    let para = null;   // { kind: "p",     lines: [] }
    let quote = null;  // { kind: "quote", lines: [] }
    let list = null;   // { kind: "ul"|"ol", items: [] }

    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
        if (raw.trim() === "") {
            // A blank line ends every open block, so a list split in two by an
            // empty line is two lists — the same as every markdown renderer.
            para = null;
            quote = null;
            list = null;
            continue;
        }

        const bullet = BULLET.exec(raw);
        const ordered = ORDERED.exec(raw);
        const quoteLine = QUOTE.exec(raw);

        if (bullet || ordered) {
            const kind = bullet ? "ul" : "ol";
            if (!list || list.kind !== kind) {
                list = { kind, items: [] };
                blocks.push(list);
            }
            para = null;
            quote = null;
            list.items.push(inlineRun((bullet || ordered)[1]));
            continue;
        }

        if (quoteLine) {
            if (!quote) {
                quote = { kind: "quote", lines: [] };
                blocks.push(quote);
            }
            para = null;
            list = null;
            quote.lines.push(inlineRun(quoteLine[1]));
            continue;
        }

        list = null;
        quote = null;
        if (!para) {
            para = { kind: "p", lines: [] };
            blocks.push(para);
        }
        para.lines.push(inlineRun(raw));
    }

    return blocks;
}

/**
 * The source as plain lines: every marker removed, the line structure kept.
 *
 * This is the form a caller that needs to treat "the first line" specially wants.
 * A Later row is labelled by a note's first line and shows what FOLLOWS it, which
 * is only possible if the lines survive — so this exists rather than the preview
 * doing the work with a flag, because a flag on a function that joins its lines
 * together is a flag that cannot be honoured.
 *
 * Block markers are removed too, so a list item is its words and not "- words".
 * The line count changes: `- a\n- b` is two lines, and a paragraph's three
 * source lines are three entries, because that is what the user wrote.
 */
export function richTextLines(src) {
    const lines = [];
    for (const block of parseRichText(src)) {
        for (const run of (block.items || block.lines)) lines.push(run.map(plainOf).join(""));
    }
    return lines;
}

/** Every word of a source on one line, with the markers removed — a row subtitle. */
export function richTextPreview(src, max = 140) {
    const flat = richTextLines(src).join(" ").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const plainOf = token => (typeof token?.text === "string" ? token.text : "");

// ------------------------------------------------------------------ inlines

// One left-to-right scan, alternatives in priority order. `**` is tried before
// `*` so a bold pair is never read as two italic markers, and the code span is
// first so a marker inside one is literal.
//
// Every marker's content must BEGIN and END with something that is not the
// marker and not a space. That single restriction is what stops the degenerate
// readings: without it `***` is emphasis around a literal `*`, and `**` and `*`
// are attempts to mark nothing. With it, a run of identical markers is simply
// text, which is what a person who typed it meant.
const INLINE = new RegExp([
    "`(?<code>[^`\\n]+)`",                                          // `code`
    "\\*\\*(?<b1>[^*\\s](?:[^*\\n]*[^*\\s])?)\\*\\*",               // **bold**
    "__(?<b2>[^_\\s](?:[^_\\n]*[^_\\s])?)__",                       // __bold__
    "~~(?<s1>[^~\\s](?:[^~\\n]*[^~\\s])?)~~",                       // ~~strike~~
    "\\*(?<e1>[^*\\s](?:[^*\\n]*[^*\\s])?)\\*",                     // *italic*
    "_(?<e2>[^_\\s](?:[^_\\n]*[^_\\s])?)_",                         // _italic_
    "\\[(?<lt>[^\\]\\n]*)\\]\\((?<lh>[^)\\s]*)\\)",                   // [text](href)
    "(?<auto>https?:\\/\\/[^\\s<>\\[\\]()]*)"                        // a bare http(s) url
].join("|"), "g");

// A word character, for the `_italic_` boundary test. Unicode-aware so an
// Arabic or accented word is not split by an underscore either side of it.
const WORD = /[\p{L}\p{N}_]/u;

// Sentence punctuation belongs to the sentence, not to the link: the URL stops
// before it and the characters stay as text.
const TRAILING_PUNCT = /[.,;:!?]+$/;

/**
 * One line as a flat list of inline tokens. Unmatched and rejected markers stay
 * as literal text, always — a parser that drops what it does not understand
 * loses the user's words.
 */
function inlineRun(src) {
    const text = typeof src === "string" ? src : "";
    const out = [];
    let at = 0;
    INLINE.lastIndex = 0;

    for (let m = INLINE.exec(text); m !== null; m = INLINE.exec(text)) {
        const hit = tokenFor(m, text);
        // Everything before the match is text in both cases. On a rejected match
        // the match itself is text too, so the whole slice is emitted in order —
        // which is what keeps a rejected link from eating the words in front of
        // it (`some_var_name` must not become `_var_name`).
        pushText(out, text.slice(at, m.index));
        if (hit) {
            out.push(hit.token);
            // A bare url may have swallowed a full stop that belongs to the
            // sentence; the characters the token did not use stay as text.
            pushText(out, m[0].slice(hit.used));
        } else {
            pushText(out, m[0]);
        }
        at = m.index + m[0].length;
    }

    pushText(out, text.slice(at));
    return out;
}

// Adjacent literals merge, so a line of plain text is one token rather than one
// per marker the parser walked past.
function pushText(out, raw) {
    if (raw === "") return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += raw;
    else out.push({ kind: "text", text: raw });
}

// The token a match stands for, plus how many of its characters the token used
// (always all of them, except a bare url that gave a full stop back).
// null means "not a token after all" and the caller keeps the text.
function tokenFor(m, text) {
    const g = m.groups;

    if (g.code !== undefined) return { token: { kind: "code", text: g.code }, used: m[0].length };
    if (g.b1 !== undefined) return { token: { kind: "strong", text: g.b1 }, used: m[0].length };
    if (g.b2 !== undefined) return { token: { kind: "strong", text: g.b2 }, used: m[0].length };
    if (g.s1 !== undefined) return { token: { kind: "strike", text: g.s1 }, used: m[0].length };
    if (g.e1 !== undefined) return { token: { kind: "em", text: g.e1 }, used: m[0].length };

    if (g.e2 !== undefined) {
        // `_` is the one marker that appears inside ordinary words
        // (`some_var_name`), so both edges are checked instead of trusting the
        // match: a letter or digit either side means this is not emphasis.
        const before = m.index > 0 ? text[m.index - 1] : "";
        const end = m.index + m[0].length;
        const after = end < text.length ? text[end] : "";
        if (WORD.test(before) || WORD.test(after)) return null;
        return { token: { kind: "em", text: g.e2 }, used: m[0].length };
    }

    if (g.lt !== undefined) {
        const href = safeHref(g.lh);
        const label = g.lt.trim();
        if (!href || label === "") return null;
        return { token: { kind: "link", text: label, href }, used: m[0].length };
    }

    // The href is the trimmed url, NOT the raw match: a sentence's full stop is
    // not part of the address, and a link to `https://a.dev/x.` is a 404 that
    // looks exactly like a working one.
    const href = safeHref(g.auto);
    if (!href) return null;
    const bare = g.auto.replace(TRAILING_PUNCT, "");
    return { token: { kind: "link", text: bare, href: bare }, used: bare.length };
}
