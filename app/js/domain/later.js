import { validateLaterInput } from "./validation.js";

// Pure Later logic. Imports nothing from data/, services/ or ui/ — every
// function here is a pure function over plain records, so the rules can be
// tested directly (same style as session-engine.js and finance.js).
//
// Later is the smallest feature in the app and stays that way on purpose: one
// link or one note to come back to, a single `completedAt` stamp for "followed
// up", and nothing that ties it to a task or a session.
//
// Two choices are worth stating:
//
//  1. "Followed up" is a stamp, never a boolean beside a date. An item is open
//     until completedAt says otherwise, so the two can never disagree.
//  2. Typed text and an OS share go through the SAME parser (fromSharePayload).
//     Sharing a page from the phone and typing "https://x.dev" into the quick
//     field are the same act, so they are the same code.

// ---------------------------------------------------------------------- Read

// The host to show for a link, without the noise around it. Empty when the url
// cannot be parsed at all — the row then falls back to its title or its text.
export function hostOf(url) {
    try {
        const host = new URL(url).hostname;
        return host.replace(/^www\./i, "");
    } catch {
        return "";
    }
}

// The line a list row is labelled with: the title when there is one, otherwise
// the host of the link, otherwise the first line of the text. null when the
// item really has nothing to show — a note that is nothing but photographs, for
// instance — and the caller decides what to print.
//
// `describe` is the caller's formatter for that last case. It is passed in
// rather than imported because a domain module has no business producing words:
// the fallback has to be translatable, and the only place in this app that
// holds words for two languages is the i18n table.
export function laterLabel(item, describe = null) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    if (title) return title;
    if (item?.type === "link") {
        const host = hostOf(item.url);
        if (host) return host;
    }
    const first = String(item?.content ?? "").split("\n").find(line => line.trim());
    if (first) return first.trim();
    const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
    if (attachments.length && describe) return describe(attachments);
    return null;
}

// Followed up or not, answered by the stamp alone.
export function isDone(item) {
    return Number.isInteger(item?.completedAt) && item.completedAt > 0;
}

// Newest first inside each group. The id is the tie-breaker because local order
// is never trusted across devices: two devices that saved two items in the same
// millisecond must still agree on the order they are shown in.
const newestFirst = get => (a, b) => (get(b) - get(a)) || a.id.localeCompare(b.id);

// The screen the feature is built around: what still needs attention, and what
// has already been dealt with. Sorting happens here, on every read, rather than
// being stored.
export function splitLater(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    return {
        open: list.filter(x => !isDone(x)).sort(newestFirst(x => x.createdAt ?? 0)),
        done: list.filter(x => isDone(x)).sort(newestFirst(x => x.completedAt ?? 0))
    };
}

// ------------------------------------------------------------------- Write

export function createLaterItem(input, { now, id }) {
    return {
        id,
        type: input.type,
        title: input.title ?? null,
        content: input.content ?? null,
        url: input.url ?? null,
        // What the note CARRIES, never what it holds: the descriptions travel,
        // the bytes stay on the device that captured them. See
        // domain/attachments.js for why the split is here rather than in a
        // second record.
        attachments: input.attachments ?? [],
        // Open until something stamps it. Never a stored boolean.
        completedAt: null,
        createdAt: now,
        updatedAt: now
    };
}

// ------------------------------------------------------------------- Share

// A link inside shared text. Only a real scheme or an explicit "www." counts:
// "v1.0" or "read 3.5 later" must not turn a thought into a link.
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"']+/i;

// Punctuation that ends the sentence the link was dropped into, not the link.
const SENTENCE_END = /[.,;:!?)\]}'"]+$/;

function firstUrl(text) {
    return URL_IN_TEXT.exec(text)?.[0] ?? "";
}

// What is left of the text once the link is taken out of it: usually the reason
// it was saved, and often the only text there is. `match` is the link exactly as
// it sits in the text, sentence punctuation and all, so nothing is left
// dangling — and the gap it leaves behind collapses to one space, because the
// link was almost always surrounded by them.
function stripLink(text, match) {
    const at = text.indexOf(match);
    if (at < 0) return text;
    return `${text.slice(0, at)} ${text.slice(at + match.length)}`.replace(/\s+/g, " ").trim();
}

// The OS share sheet, as a Later input.
//
// The sheet can hand over the link in `url`, in `text`, or in both, and the
// title is sometimes the page title and sometimes the link repeated. All of
// those collapse into the same two shapes the form produces: a link (with
// whatever text came along as its note) or a plain note.
//
// Throws ValidationError when there is nothing to save — an empty share is not
// an item.
export function fromSharePayload({ url = null, text = null, title = null } = {}) {
    const asText = v => (typeof v === "string" ? v.trim() : "");
    const body = asText(text);
    const shared = asText(url);
    // A link in the url field wins; otherwise the one inside the text is it, and
    // the punctuation around it belongs to the sentence, not to the link.
    const inText = shared ? "" : firstUrl(body);
    const link = (shared || inText.replace(SENTENCE_END, "")) || null;
    const rawTitle = asText(title);

    return validateLaterInput({
        type: link ? "link" : "note",
        // A "title" that is just the link again says nothing, so it is dropped
        // rather than shown twice.
        title: !rawTitle || rawTitle === link ? null : rawTitle,
        content: inText ? stripLink(body, inText) : body,
        url: link
    });
}
