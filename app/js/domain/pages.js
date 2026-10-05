import { PAGE_ITEM_TARGETS } from "./validation.js";

// Pure Pages logic. Imports nothing from data/, services/ or ui/ — every
// function here is a pure function over plain records, so the rules can be
// tested directly (the same style as later.js and session-engine.js).
//
// A page is an organisation layer and nothing else. It has words of its own
// (headings, paragraphs, dividers) and POINTERS at records that live somewhere
// else, and the pointer is the whole design: an item that points at a task holds
// that task's id, and every label, every amount and every "this one is done" the
// page shows is read from the record itself at the moment it is shown. Nothing
// here caches a copy, so a page can never disagree with the task it points at.
//
// Three choices worth stating:
//
//  1. Items are records, not an array on the page (Migration 7). A reorder and a
//     text edit are two different facts about two different records, and
//     last-write-wins resolves them independently.
//  2. The order is stored as a gapless index, and it is renumbered on every
//     reorder. Fractional positions ("insert between 3 and 4") need a periodic
//     compaction, which is a second thing to get wrong and a second sync path.
//  3. A pointer to a record that no longer exists is a valid state, not a
//     corrupt one. The record can be deleted on another device at any moment;
//     the page says so and the user removes the line.

// Where each linked kind's own screen lives, so `linkFor` is the only place that
// turns a pointer into an href. The item types are the ones the app already
// routes to — a page adds no screen of its own to open.
export const PAGE_ITEM_ROUTES = Object.freeze({
    task: "/tasks",
    session: "/sessions",
    reference: "/later",
    expense: "/finance/transactions"
});

// ---------------------------------------------------------------------- Read

// The id an item points at, or null for the three kinds that point at nothing.
// Reads the field the kind is documented to use, from the same table the
// validator enforces — so a row can never claim an id in a field its kind does
// not have.
export function targetIdOf(item) {
    const field = PAGE_ITEM_TARGETS[item?.type];
    if (!field) return null;
    const id = item?.content?.[field];
    return typeof id === "string" && id ? id : null;
}

// The in-app address of the record an item points at, or null. Null covers all
// three cases of "there is nothing to open": the item is not a link, the pointer
// is empty, or the record it named is gone — the caller renders the last one as
// a muted line rather than a dead href.
export function linkFor(item) {
    const base = PAGE_ITEM_ROUTES[item?.type];
    const id = targetIdOf(item);
    return base && id ? `${base}/${id}` : null;
}

// The line a page's row is labelled with: the title when there is one, otherwise
// the first line of the description. null when the page really has nothing to
// show and the caller decides the wording.
export function pageLabel(page) {
    const title = typeof page?.title === "string" ? page.title.trim() : "";
    if (title) return title;
    const first = String(page?.description ?? "").split("\n").find(line => line.trim());
    return first ? first.trim() : null;
}

// Newest first, by when the page was created rather than when it was last
// touched. A list that reorders itself while the title is being typed loses the
// row you are typing into, and "which page did I make most recently" is the
// question the list is actually asked. The id breaks a tie, because local order
// is never trusted across devices: two pages made in the same millisecond must
// still come out in the same order on both.
export function sortPages(pages) {
    return (Array.isArray(pages) ? pages.slice() : [])
        .sort((a, b) => (b.createdAt - a.createdAt) || a.id.localeCompare(b.id));
}

// The page's own order, by position. The id is the same tie-break for the same
// reason: two devices that appended at the same instant must agree.
export function sortItems(items) {
    return (Array.isArray(items) ? items.slice() : [])
        .sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id));
}

// The position a newly added item takes: one past the end, so an add is an append
// and never silently renumbers the items already on the page.
export function nextPosition(items) {
    const list = Array.isArray(items) ? items : [];
    return list.reduce((max, x) => (Number.isInteger(x.position) && x.position > max ? x.position : max), -1) + 1;
}

// ------------------------------------------------------------------- Write

export function createPage(input, { now, id }) {
    return {
        id,
        // A page is created untitled and named afterwards, so an empty title is a
        // real state rather than a rejected input.
        title: input.title ?? null,
        description: input.description ?? null,
        createdAt: now,
        updatedAt: now
    };
}

export function createPageItem(input, { now, id, position }) {
    return {
        id,
        pageId: input.pageId,
        type: input.type,
        position,
        content: input.content,
        createdAt: now,
        updatedAt: now
    };
}

// -------------------------------------------------------------------- Move

// The whole page, reordered, with positions renumbered 0..n-1. Pure: it takes
// the current items and returns new values, and the service writes only the rows
// whose position actually changed.
//
// How many rows that is depends on how far the item moved, and the rule is worth
// knowing: a gapless index means every row between the old place and the new one
// shifts by one, so moving something one place renumbers two rows and moving it
// from the last place to the first renumbers all of them. Rows outside the span
// come back as the SAME objects, not copies with a new date, and that is how the
// service can tell which ones it has to write. The common case — the up and down
// buttons the editor offers — is therefore two writes on a page of any length.
//
// The alternative, fractional positions ("insert between 3 and 4"), needs a
// periodic compaction to stop the gaps collapsing to nothing, which is a second
// thing to get wrong and a second thing to sync.
//
// `toIndex` is clamped rather than refused, so "move up" on the first row and
// "move down" on the last are no-ops that still return a well-formed order
// instead of an error the caller has to handle. A target that is not an integer
// at all means "leave it where it is" — a stale row action must not be able to
// throw at the screen.
export function moveItem(items, itemId, toIndex) {
    const list = sortItems(items);
    const from = list.findIndex(x => x.id === itemId);
    if (from < 0) return list;
    const to = Math.max(0, Math.min(list.length - 1, Number.isInteger(toIndex) ? toIndex : from));
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    return list.map((item, at) => (item.position === at ? item : { ...item, position: at }));
}

// ------------------------------------------------------------------- Items

// The words an item shows as its own, or "" for the three kinds that have none.
// Used for the row's label and for the editor's textarea, so the editor opens on
// exactly the text the row showed.
export function itemText(item) {
    if (item?.type !== "text" && item?.type !== "heading") return "";
    const text = item?.content?.text;
    return typeof text === "string" ? text : "";
}
