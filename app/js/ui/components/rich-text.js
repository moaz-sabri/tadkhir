import { h } from "../dom.js";
import { parseRichText } from "../../domain/rich-text.js";

// A block of formatted text, built with the same factory as the rest of the app.
//
// This is the only place in the codebase that turns user text into elements, and
// the reason it can be that simple is upstream: `parseRichText` returns tokens,
// not an HTML string, and `h()` turns a string child into a text node. There is
// no markup to sanitize because there is never any markup, and an angle bracket
// in a note is the five characters the user typed.
//
// The consequence worth stating: the tag choice below is a CLOSED list, and a
// token kind that is not in it is text. So a new inline kind added to
// domain/rich-text.js renders as its literal characters until this file is told
// what it is — it can never become an unexpected element by accident.

/** Render into a fresh element — for a standalone read of some text. */
export function richText(src, { className = "" } = {}) {
    return richTextInto(h("div", { class: `prose ${className}`.trim() }), src);
}

/**
 * Render into an element that already exists, replacing what was in it.
 *
 * The live preview needs this: a re-render that threw the element away and made
 * a new one would drop the scroll position of a long note on every keystroke.
 */
export function richTextInto(host, src) {
    host.replaceChildren(...parseRichText(src).map(blockNode));
    return host;
}

function blockNode(block) {
    // A paragraph and a quote hold LINES, because a blank line between two plain
    // lines is a paragraph break while a hard return inside one is the user's own
    // line break. Both are the same shape: runs of inline tokens, joined by <br>.
    if (block.kind === "ul" || block.kind === "ol") {
        return h(block.kind, { class: "prose-list" },
            ...block.items.map(item => h("li", { class: "prose-item" }, ...runNodes(item)))
        );
    }
    if (block.kind === "quote") {
        return h("blockquote", { class: "prose-quote" }, ...linesNodes(block.lines));
    }
    return h("p", { class: "prose-p" }, ...linesNodes(block.lines));
}

// The lines of a paragraph, with a break between them and never a trailing one
// (a trailing <br> makes the block one line taller than its words).
function linesNodes(lines) {
    return lines.flatMap((line, at) => (at === 0 ? [] : [h("br")]).concat(runNodes(line)));
}

function runNodes(run) {
    return run.map(inlineNode);
}

function inlineNode(token) {
    switch (token.kind) {
        case "strong":
            return h("strong", {}, token.text);
        case "em":
            return h("em", {}, token.text);
        case "strike":
            // <s>, not <del>: the note is not a document revision, and `del` tells
            // assistive technology the text was edited out of a file.
            return h("s", {}, token.text);
        case "code":
            return h("code", { class: "prose-code" }, token.text);
        case "link":
            return h("a", {
                class: "prose-link",
                href: token.href,
                // The href came out of domain/rich-text.js's policy, which allows
                // only http, https and mailto — so this leaves the app by
                // definition and gets the same treatment any external link in the
                // kit does. `noopener` because a target of _blank hands the new
                // document a reference to this one.
                target: "_blank",
                rel: "noopener noreferrer"
            }, token.text);
        default:
            // A plain string, which h() makes a text node. The `text` kind and
            // any kind this file has not been taught both land here.
            return token.text ?? "";
    }
}
