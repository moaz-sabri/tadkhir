import { validateKanbanItemInput, KANBAN_STATUSES, KANBAN_SERVICES } from "./validation.js";

// The board. Four columns and no fifth, because the fifth is always the one
// somebody wants and never the one anybody needs: a column per service, a column
// for "blocked", a column for "waiting on someone else". Four is what a person
// can hold in their head, and it is enough to answer the only two questions a
// board is opened for: what have I not started, and what did I finish.
export const KANBAN_COLUMNS = [
    { key: "have", label: "kanban.have", icon: "inbox" },
    { key: "working", label: "kanban.working", icon: "play" },
    { key: "done", label: "kanban.done", icon: "check" },
    { key: "deferred", label: "kanban.deferred", icon: "clock" }
];

// The two statuses that answer "is this still on today's board?", because they
// are the two whose answer does not depend on the date.
const PERSISTENT_SERVICES = new Set(["later", "pages"]);

export function getKanbanColumn(key) {
    return KANBAN_COLUMNS.find(c => c.key === key) || null;
}

/**
 * The day an item belongs to, as `YYYY-MM-DD` in the device's own timezone.
 *
 * `toDateString()` would answer the same question, but it is locale-dependent
 * ("Fri Oct 02 2026" in English, something else in Arabic), and this value is
 * written to the database, indexed, and compared on another device in another
 * locale. A key that changes shape with the reader's language is a key that
 * silently stops matching. These ten characters do not.
 */
export function generateTodayKey(at = Date.now()) {
    const d = new Date(at);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

/** The day a timestamp falls on, in the same key shape. */
export function dayKeyOf(at) {
    return generateTodayKey(at);
}

/**
 * Whether a card belongs on today's board.
 *
 * The rule is one sentence: a card is shown when the thing it points at is
 * something a person would still want to see today. That resolves per status:
 *
 *   deferred  A card put aside stays put until it is due again. If it carries a
 *             due date that is today or already past, it is not "put aside"
 *             any more — it is late, and late is exactly when it needs to be
 *             visible. So a deferred card shows when `dueAt` has arrived, and
 *             is hidden while `dueAt` is still in the future. A deferred card
 *             with no date at all is the one honest exception: with nothing to
 *             bring it back, hiding it would lose it, so it stays.
 *   done      Finished today is finished today. Yesterday's finished work is
 *             history, and the board is a board for today, not an archive.
 *   have,     The original's own rule. A task planned for a given day is on
 *   working   that day's board and on no other, which is the whole point of
 *             `todayKey` and the reason a board does not need per-service
 *             columns.
 *
 * Later items and pages are the deliberate exception: a note or a link is not
 * scheduled work, it is a thing you wrote down to come back to, and it stays on
 * the board every day until it is dealt with. Filtering those by date would hide
 * a note on the morning after writing it, which is precisely when it is wanted.
 */
export function shouldShowForToday(item, todayKey) {
    if (!item) return false;
    if (item.status === "done") return item.todayKey === todayKey;
    if (item.status === "deferred") {
        if (!item.dueAt) return true;
        return item.dueAt <= endOfDay(todayKey);
    }
    if (PERSISTENT_SERVICES.has(item.service)) return true;
    return !item.todayKey || item.todayKey === todayKey;
}

/**
 * The last millisecond of the given day, so "due today" includes an item due at
 * 09:00 when the board is opened at 23:00. Comparing against the START of today
 * instead would hide a card for the whole day it is due, which is the day it
 * matters most.
 */
function endOfDay(todayKey) {
    if (!todayKey) return Date.now();
    const [y, m, d] = todayKey.split("-").map(Number);
    if (!y || !m || !d) return Date.now();
    return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

export function createKanbanItem(input, { now: at = Date.now(), id } = {}) {
    const validated = validateKanbanItemInput(input || {});
    return {
        id,
        originalId: validated.originalId,
        originalKey: validated.originalKey,
        service: validated.service,
        status: validated.status || "have",
        order: validated.order ?? 0,
        dueAt: validated.dueAt ?? null,
        movedAt: at,
        createdAt: at,
        updatedAt: at,
        todayKey: validated.todayKey ?? generateTodayKey(at),
        // A snapshot of the original's label, so a card can be drawn without
        // loading every service it points at. It is a CACHE, never the truth:
        // nothing writes back to the original from here, and refreshOriginal()
        // replaces it wholesale from the service that owns the record.
        originalData: validated.originalData || null,
        meta: validated.meta || null
    };
}

/**
 * A card moved to another column.
 *
 * Moving stamps `todayKey` again. Without that, a card filed under "working" on
 * Tuesday would be invisible on Wednesday: the board filters by the day the card
 * was last touched, so a card you deliberately moved yesterday and deliberately
 * kept would vanish from a board that is supposed to show what you are working on.
 * The date is re-stamped on a real move and left alone on a no-op, so dragging a
 * card and dropping it back where it started does not make it today's card.
 *
 * `order` is a position WITHIN the column, not a timestamp. A caller that does
 * not care passes nothing and the card goes to the end, which is what dropping it
 * on empty space means.
 */
export function moveKanbanItem(item, status, order = null, { now: at = Date.now() } = {}) {
    const to = KANBAN_STATUSES.includes(status) ? status : item.status;
    if (to === item.status && order === null) return { ...item };
    return {
        ...item,
        status: to,
        order: order === null ? item.order : order,
        movedAt: at,
        updatedAt: at,
        todayKey: to === item.status ? item.todayKey : generateTodayKey(at)
    };
}

export function updateKanbanItem(item, patch, { now: at = Date.now() } = {}) {
    const validated = validateKanbanItemInput({ ...item, ...patch });
    return {
        ...item,
        originalData: "originalData" in patch ? validated.originalData : item.originalData,
        meta: "meta" in patch ? validated.meta : item.meta,
        dueAt: "dueAt" in patch ? validated.dueAt : item.dueAt,
        status: validated.status || item.status,
        order: "order" in patch ? validated.order : item.order,
        updatedAt: at,
        movedAt: validated.status !== item.status ? at : item.movedAt
    };
}

/** The next free position in a column, so a new card lands at the bottom. */
export function nextOrder(items) {
    return items.reduce((max, i) => Math.max(max, (i.order ?? 0) + 1), 0);
}

/** Renumbers a column to 0..n-1. Used after a delete so no gap accumulates. */
export function renumber(items) {
    return items
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)))
        .map((item, i) => (item.order === i ? null : { ...item, order: i }))
        .filter(Boolean);
}

/** The route that opens a card's original, or null when it cannot be opened. */
export function hrefFor(item) {
    if (!item?.originalId) return null;
    switch (item.service) {
        case "tasks": return `/tasks/${item.originalId}`;
        case "later": return `/later/${item.originalId}`;
        case "pages": return `/pages/${item.originalId}`;
        default: return null;
    }
}

/** The services a card may point at, for the picker that adds one. */
export const KANBAN_ORIGIN_SERVICES = KANBAN_SERVICES.filter(s => hrefFor({ service: s, originalId: "x" }));
