import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import {
    createKanbanItem,
    moveKanbanItem,
    updateKanbanItem,
    generateTodayKey,
    shouldShowForToday,
    nextOrder
} from "../domain/kanban.js";
import { KANBAN_STATUSES } from "../domain/validation.js";
import { laterLabel } from "../domain/later.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const kanban = reader("kanbanItem");
const T_KANBAN = "kanbanItem";

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

/**
 * The services a card can point at, resolved on first use rather than imported.
 *
 * These are dynamic imports because the dependency runs BOTH ways: this file asks
 * a task service whether a task exists, and the task service has to ask this one
 * to drop the card when the task is deleted. Two static imports between modules
 * that import each other hand one of them a half-built namespace and fail at load
 * with an error that names neither of the things that caused it.
 *
 * Each entry resolves to the SERVICE OBJECT, not to its module — so a caller
 * writes `SERVICES.later.get(id)` and never has to know which of the three it is
 * holding. Webpack folds these back into the single bundle, because this app
 * ships as one file (see webpack.config.js) and the service worker's cache list
 * has exactly one script in it.
 */
const SERVICES = {
    later: () => import("./later-service.js").then(m => m.laterService),
    tasks: () => import("./task-service.js").then(m => m.taskService),
    pages: () => import("./page-service.js").then(m => m.pageService)
};

// What "finished" means for each service.
//
// `complete`/`reopen` are the two writes a board is allowed to cause, and they
// are the ORIGINAL service's own methods, called as they are. The board has no
// idea how to archive a task or follow up a Later item, and inventing its own
// version of those writes would be how a board becomes a second, quieter copy of
// every service in the app.
//
// Whether a card's record still exists is answered by `reach()` below rather than
// by a function here, because the answer needs three states, not a boolean — see
// the note on `reach`.
//
// A service with no `complete` cannot be finished from the board. That is a
// deliberate gap rather than a fallback — a page is a document, not a unit of
// work, so "finished" has no meaning for one and guessing would be worse than
// saying so.
const ORIGINALS = {
    later: {
        // Following an item up is the one action Later already has, and it is
        // reversible, which is what makes it the right answer for a board.
        complete: async id => (await SERVICES.later()).setCompleted(id, true),
        reopen: async id => (await SERVICES.later()).setCompleted(id, false)
    },
    tasks: {
        // Archiving, not deleting: closing a task in this app means archiving it,
        // and the delete question belongs to the task's own screen. A board card
        // that quietly deleted a task would destroy the record it points at.
        complete: async id => (await SERVICES.tasks()).archive(id),
        reopen: async id => (await SERVICES.tasks()).restore(id)
    },
    pages: {
        // Nothing. A page is a document, not a unit of work, so "finished" has no
        // meaning for one and the board says so instead of inventing one.
    }
};

/**
 * Whether an IndexedDB write failed because a UNIQUE index already holds that
 * key.
 *
 * Checked by name rather than by truthiness because a failed transaction here can
 * be a quota, an abort, or a real bug, and each of those must keep propagating: a
 * quota error tells the user their board is full, and swallowing it would report
 * "added" for a card that was not saved. Only this one specific refusal has a
 * sensible recovery.
 */
function isUniqueViolation(error) {
    return error?.name === "ConstraintError"
        || /constraint|unique/i.test(String(error?.message ?? ""));
}

/**
 * Looks a record up, and says WHICH of three things happened.
 *
 * The distinction is the whole point. `dropOrphans` deletes cards, and a card is
 * the user's data: which column it is in, where it sits, when they last touched
 * it. Deleting one because a service was slow, or a chunk failed to load, or the
 * page was mid-restore, loses all of that and gives nothing back. So the three
 * answers are kept apart:
 *
 *   found     the service has the record
 *   gone      the service was asked and said no — a NotFoundError. Only this one
 *             justifies deleting a card.
 *   unknown   the service could not answer. The card is kept, and the board says
 *             nothing about it, because the one thing it must never do is guess.
 *
 * Collapsing "gone" and "unknown" into one `null` is a two-character change and
 * it turns every transient failure into silent data loss.
 */
async function reach(service, id) {
    const load = SERVICES[service];
    if (!load) return { state: "unknown" };
    let svc;
    try {
        svc = await load();
    } catch {
        // The module itself would not load. Nothing is known about the record.
        return { state: "unknown" };
    }
    if (!svc?.get) return { state: "unknown" };
    try {
        return { state: "found", record: await svc.get(id) };
    } catch (e) {
        // Only a NotFoundError is an answer. Anything else — a transaction that
        // aborted, a quota error, a bug — is silence, not a verdict.
        return e?.code === "not_found" || e?.name === "NotFoundError"
            ? { state: "gone" }
            : { state: "unknown", error: e };
    }
}


export const kanbanService = {
    /** The services a card can point at, with the ones that can be finished. */
    ORIGINALS,

    // ------------------------------------------------------------ read side

    /**
     * Today's board, grouped by column, in the order the columns are drawn.
     *
     * The day filter runs here rather than in the page so that every reader of
     * the board — the page, the count on a row, the check for "is this already
     * on the board" — gets the same answer, and none of them can accidentally
     * show yesterday.
     */
    async board(options = {}) {
        const todayKey = options.todayKey || generateTodayKey(now());
        const all = await withTx(["kanbanItems"], "readonly", r => kanban(r).getAll());

        const columns = new Map(KANBAN_STATUSES.map(s => [s, []]));
        for (const item of all) {
            if (!columns.has(item.status)) continue;
            if (!shouldShowForToday(item, todayKey)) continue;
            columns.get(item.status).push(item);
        }

        return KANBAN_STATUSES.map(status => ({
            status,
            items: columns.get(status).sort(
                (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.movedAt ?? 0) - (b.movedAt ?? 0)
            )
        }));
    },

    /** Today's board as one flat list, for callers that only need the cards. */
    async list(options = {}) {
        const todayKey = options.todayKey || generateTodayKey(now());
        const groups = await this.board({ todayKey });
        return groups.flatMap(g => g.items);
    },

    async listByStatus(status, options = {}) {
        if (!KANBAN_STATUSES.includes(status)) {
            throw new ValidationError("status", "invalid_type");
        }
        const groups = await this.board(options);
        return groups.find(g => g.status === status)?.items ?? [];
    },

    async get(id) {
        const item = await withTx(["kanbanItems"], "readonly", r => kanban(r).get(id));
        if (!item) throw new NotFoundError("kanbanItem", id);
        return item;
    },

    async findByOriginalKey(originalKey) {
        try {
            const item = await withTx(["kanbanItems"], "readonly", r => kanban(r).byOriginalKey(originalKey));
            return item ?? null;
        } catch {
            return null;
        }
    },

    /** Whether this record is already on the board, so a row can say so. */
    async has(originalKey) {
        return (await this.findByOriginalKey(originalKey)) !== null;
    },

    /** What a card may be moved to, given what its original service supports. */
    canComplete(item) {
        return Boolean(item && ORIGINALS[item.service]?.complete);
    },

    // ----------------------------------------------------------- write side

    /**
     * Puts a record on the board.
     *
     * Idempotent by `originalKey`, which is the whole reason that key is unique:
     * "add this task to my board" pressed twice, or pressed on two devices that
     * have not synced yet, must not produce two cards for one task. The second
     * call returns the card that is already there.
     */
    async addFromOriginal(original, { service, status = "have", dueAt = null } = {}) {
        const originalId = original?.id;
        if (!originalId) throw new ValidationError("originalId", "required");
        if (!ORIGINALS[service]) throw new ValidationError("service", "invalid_type");

        const originalKey = `${service}:${originalId}`;
        const existing = await this.findByOriginalKey(originalKey);
        if (existing) return existing;

        const at = now();
        const item = createKanbanItem(
            {
                originalId,
                service,
                status,
                dueAt,
                // The label is copied so the board can be drawn without loading
                // every service it points at. It is a cache: refreshLabels()
                // replaces it from the owning service whenever the board is
                // opened, and nothing is ever written back through it.
                originalData: kanbanLabel(service, original),
                todayKey: generateTodayKey(at)
            },
            { now: at, id: crypto.randomUUID() }
        );

        try {
            await withTx(["kanbanItems"], "readwrite", async r => {
                await guardQuota(r, T_KANBAN);
                await kanban(r).put(item);
            });
        } catch (e) {
            // The check above and this write are not one atomic step, so two
            // presses — or the same press on two devices that have not synced —
            // can both pass the check and both try to write. The unique index on
            // `originalKey` refuses the second, and that refusal is the answer to
            // the question, not a failure: the card the caller wanted now exists.
            // Surfacing it as an error would mean "add to board" sometimes reports
            // failure for a card that is sitting right there.
            if (!isUniqueViolation(e)) throw e;
            const winner = await this.findByOriginalKey(originalKey);
            if (winner) return winner;
            throw e;
        }
        await syncService.enqueue(T_KANBAN, item.id, "upsert", item);
        notify();
        return item;
    },

    async create(input) {
        const at = now();
        const item = createKanbanItem(
            { todayKey: generateTodayKey(at), ...input },
            { now: at, id: crypto.randomUUID() }
        );

        const clash = await this.findByOriginalKey(item.originalKey);
        if (clash) {
            // Two cards for one record is prevented by the unique index as well,
            // but an unhandled ConstraintError from inside a transaction is not
            // something a caller can report. Saying so here keeps the two paths
            // from answering differently.
            throw new ValidationError("originalKey", "invalid_type");
        }

        await withTx(["kanbanItems"], "readwrite", async r => {
            await guardQuota(r, T_KANBAN);
            await kanban(r).put(item);
        });
        await syncService.enqueue(T_KANBAN, item.id, "upsert", item);
        notify();
        return item;
    },

    /**
     * Moves a card to another column.
     *
     * `order` is the position within the target column. Omit it and the card goes
     * to the end, which is what dropping it on empty space means; the caller does
     * not have to know how many cards are already there.
     */
    async move(id, status, order = null) {
        if (!KANBAN_STATUSES.includes(status)) {
            throw new ValidationError("status", "invalid_type");
        }
        // The card is re-read inside the write and the new position computed from
        // THAT, for the same reason refreshLabels() patches one field rather than
        // writing a whole record back: between this read and this write another
        // write can land, and a record written from a stale copy silently undoes
        // it. This is not a theoretical hazard here — finishing a card archives the
        // original, which re-renders the board, and both writes are in flight at
        // once by design.
        const at = now();
        const item = await withTx(["kanbanItems"], "readwrite", async r => {
            const live = await kanban(r).get(id);
            if (!live) throw new NotFoundError("kanbanItem", id);

            let position = order;
            if (position === null) {
                // Counted from the LIVE column, inside this transaction, so two
                // cards dropped into the same column at the same moment cannot
                // both be told they are the last one.
                const column = await kanban(r).byStatus(status);
                position = nextOrder(column.filter(i => i.id !== id));
            }

            const moved = moveKanbanItem(live, status, position, { now: at });
            await kanban(r).put(moved);
            return moved;
        });

        await syncService.enqueue(T_KANBAN, id, "upsert", item);
        notify();
        return item;
    },

    /**
     * Finishes a card: asks the original service to do it, and only records the
     * move once that succeeded.
     *
     * The order is the whole point. The card is not moved first and the action
     * attempted second — that leaves a card in "done" pointing at a task that was
     * never closed, which is the one state a board must never be in. If the
     * original service refuses, the card stays where it was and the caller
     * reports the failure.
     *
     * Kanban coordinates, the original executes.
     */
    async complete(id) {
        const item = await this.get(id);
        const original = ORIGINALS[item.service];
        if (!original?.complete) {
            // A card whose original cannot be finished says so rather than
            // pretending. Moving it to "done" would be a lie about the record.
            throw new ValidationError("service", "invalid_type");
        }
        await original.complete(item.originalId);
        return this.move(id, "done", null);
    },

    /** The other direction: opens a finished card back up. */
    async reopen(id) {
        const item = await this.get(id);
        const original = ORIGINALS[item.service];
        if (!original?.reopen) {
            throw new ValidationError("service", "invalid_type");
        }
        await original.reopen(item.originalId);
        return this.move(id, "working", null);
    },

    async update(id, patch) {
        // Read-then-write inside the transaction, for the reason given on move():
        // a record written from a copy taken before someone else's write landed
        // will undo that write, and on this store the someone else is usually a
        // render that was already running.
        const at = now();
        const item = await withTx(["kanbanItems"], "readwrite", async r => {
            const live = await kanban(r).get(id);
            if (!live) throw new NotFoundError("kanbanItem", id);
            const next = updateKanbanItem(live, patch, { now: at });
            await kanban(r).put(next);
            return next;
        });
        await syncService.enqueue(T_KANBAN, id, "upsert", item);
        notify();
        return item;
    },

    /**
     * Takes a card off the board. The original is untouched: this removes the
     * board's pointer, not the thing the pointer was for.
     */
    async remove(id) {
        const at = now();
        await withTx(["kanbanItems"], "readwrite", r => kanban(r).delete(id));
        // A tombstone, exactly like every other delete, so the card leaves the
        // boards of the other devices too instead of coming back on next sync.
        await syncService.enqueue(T_KANBAN, id, "delete", null, at);
        notify();
    },

    /**
     * Removes the card pointing at a record that has just been deleted.
     *
     * Called by the services themselves, from their own delete. It is the reason
     * the board cannot keep a card to something that no longer exists: the delete
     * and the removal are one operation, in that order, from the code that owns
     * the record.
     */
    async removeByOriginalKey(originalKey) {
        const existing = await this.findByOriginalKey(originalKey);
        if (existing) await this.remove(existing.id);
    },

    /**
     * Drops cards whose original is gone.
     *
     * This is the backstop, not the main path: `removeByOriginalKey` is called by
     * the services from their own delete, and that is what normally removes a
     * card. This covers the cases it cannot: a record deleted on another device
     * whose card arrived here first, a restore from a backup taken before the
     * delete, or a service that grew a delete path and did not call it. It runs
     * when the board is opened, so the answer is never more than one screen
     * stale — and a card whose original cannot be found is never shown at all.
     */
    async dropOrphans() {
        const all = await withTx(["kanbanItems"], "readonly", r => kanban(r).getAll());
        const orphans = [];
        let unreadable = 0;
        for (const item of all) {
            // A card pointing at a service this build does not know about is not
            // an orphan to clean: it may be perfectly valid, just newer than this
            // device's code. Leave it for a build that knows the service.
            if (!ORIGINALS[item.service]) continue;
            const { state } = await reach(item.service, item.originalId);
            // Only a service that ANSWERED "no" is a deletion. An unanswered
            // lookup leaves the card alone, so a card survives a service that was
            // briefly unreachable instead of vanishing with it.
            if (state === "gone") orphans.push(item);
            else if (state === "unknown") unreadable += 1;
        }
        for (const item of orphans) {
            await this.remove(item.id);
        }
        return { removed: orphans.length, unreadable };
    },

    /**
     * Re-reads each card's label from the service that owns it.
     *
     * The label on a card is a copy, so it goes stale the moment the task is
     * renamed elsewhere. This puts it back in step without loading every service's
     * records into the page that draws the board. A card whose record could not
     * be read keeps the label it has rather than being blanked.
     */
    async refreshLabels() {
        const all = await withTx(["kanbanItems"], "readonly", r => kanban(r).getAll());
        let changed = 0;
        for (const item of all) {
            const { state, record } = await reach(item.service, item.originalId);
            if (state !== "found") continue;
            const label = kanbanLabel(item.service, record);
            if (JSON.stringify(label) === JSON.stringify(item.originalData)) continue;

            // RE-READ INSIDE THE WRITE, AND PATCH ONLY THE LABEL.
            //
            // Reading the whole card up front and writing the whole card back is
            // how a stale copy undoes a move. The sequence that did it: finishing
            // a card archives the task, that emits `data-changed`, the board
            // re-renders and starts refreshing labels — and the refresh then
            // finished a card while the finish was still running, so its `put`
            // landed last and wrote the OLD status back. The card stayed in "have"
            // with the task already archived, which is the exact state this whole
            // feature exists to prevent, produced by the feature's own cleanup.
            //
            // So the write takes the current card and changes one field on it.
            // Anything that moved while this was running is still there, because
            // it was read after it happened rather than before.
            const at = now();
            const next = await withTx(["kanbanItems"], "readwrite", async r => {
                const live = await kanban(r).get(item.id);
                if (!live) return null;
                if (JSON.stringify(label) === JSON.stringify(live.originalData)) return null;
                const updated = { ...live, originalData: label, updatedAt: at };
                await kanban(r).put(updated);
                return updated;
            });
            if (!next) continue;
            await syncService.enqueue(T_KANBAN, item.id, "upsert", next);
            changed += 1;
        }
        if (changed) notify();
        return changed;
    },

    /**
     * Re-checks the board when the day changes.
     *
     * The board shows TODAY, so a board left open across midnight is showing
     * yesterday. The caller hands in the day it rendered and gets told whether
     * that is still today; it is the page that decides to re-render, because only
     * the page knows what is on screen.
     */
    isStale(renderedTodayKey) {
        return renderedTodayKey !== generateTodayKey(now());
    }
};

/**
 * A record was deleted somewhere in the app: take its card off the board.
 *
 * This is how the board hears about a delete without importing the service that
 * did it, which would be a cycle — the board asks those same services whether a
 * card's original still exists. `record-deleted` is the one-way street between
 * them, and it carries the service and the id, which is exactly the pair a card
 * is keyed by.
 *
 * The board answers by looking rather than by being told, so a card whose record
 * is merely unavailable — a service that failed to load, a device mid-restore —
 * is not thrown away on the strength of one event. Only `dropOrphans`, which
 * asks, ever deletes a card for a record it could not read.
 */
bus.on("record-deleted", ({ service, id } = {}) => {
    if (!service || !id) return;
    kanbanService.removeByOriginalKey(`${service}:${id}`)
        .catch(() => { /* the board re-checks orphans when it is next opened */ });
});

/**
 * The few fields a card needs to be drawn: enough to label it, enough to know
 * when it is due, and nothing else.
 *
 * Deliberately a projection. A task carries subtasks, a usage count and an
 * archive flag; none of that belongs on a board card, and copying it would mean
 * the copy had to be kept in step with all of it. The card keeps a label and a
 * due date, and reads the rest from the service when the card is opened.
 *
 * HOW A RECORD BECOMES A LABEL IS PER SERVICE, because "the words of this thing"
 * is not the same field everywhere. A task has a `title`. A Later item has an
 * optional `title` and otherwise keeps its text in `content` — and a note is
 * almost never given a title, so reading `title` alone labelled every note on the
 * board "Untitled", which is the same answer for every note and therefore tells
 * the reader nothing at all. A page has a title, a description, or neither.
 *
 * Each service's own domain already answers this question for its own list, so
 * each answer is that function rather than a second copy of it. Two rules the
 * board adds on top: the label is clamped, because a card is two lines tall and a
 * pasted paragraph must not make it thirty; and the text is never rendered as
 * anything but text.
 */
function kanbanLabel(service, original) {
    if (!original || typeof original !== "object") return null;
    return {
        title: clamp(labelFor(service, original), 140),
        // Each service spells "when this is due" differently. They are asked in
        // turn rather than merged, so a card shows a date only where the record
        // actually has one.
        dueAt: dueAtFor(service, original),
        type: typeof original.type === "string" ? original.type : null,
        archived: original.archived === true
    };
}

function labelFor(service, record) {
    switch (service) {
        case "later":
            // laterLabel() is the Later list's own answer: the title, else the
            // host for a link, else the first line written. Exactly what the row
            // in that list says, so a card and its row never disagree.
            //
            // Its second argument — how to describe a note that is only
            // photographs — is deliberately NOT passed. That description is
            // words, and words for two languages live in the i18n table, which is
            // a UI-layer thing; a service that imported it would be reaching
            // upwards through the whole app to borrow a translator. A note with no
            // words therefore gets no label from here, and the card draws the
            // translatable "untitled" — which is true of it, and is the same thing
            // every other untitled thing in the app says.
            return laterLabel(record, null);
        case "pages":
            return firstLine(record.title) || firstLine(record.description);
        default:
            return firstLine(record.title);
    }
}

function dueAtFor(service, record) {
    if (service === "later") {
        return Number.isInteger(record.remindAt) ? record.remindAt : null;
    }
    if (service === "pages") return null;
    return Number.isInteger(record.plannedAt) ? record.plannedAt : null;
}

function firstLine(value) {
    if (typeof value !== "string") return null;
    const line = value.split("\n").find(l => l.trim());
    return line ? line.trim() : null;
}

function clamp(text, max) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
