import { withTx } from "../data/db.js";
import { reader, localReader, guardQuota } from "../data/stores.js";
import { validateLaterInput } from "../domain/validation.js";
import { createLaterItem, splitLater, isDone, fromSharePayload } from "../domain/later.js";
import { NotFoundError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const later = reader("later");
const noteMedia = localReader("noteMedia");

// Later is the same generic record protocol as tasks, sessions, events and
// finance: { type, id, op, data, updatedAt } against the existing outbox,
// push, pull, encryption, LWW and tombstones. It has no transport of its own,
// no endpoint, and no server-side logic.
const T_LATER = "later";

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

export const laterService = {
    // ------------------------------------------------------------ read side

    // { open, done } â€” what still needs a decision first, then what has been
    // followed up. The grouping and the order are derived on every read rather
    // than stored, because a local order is never trusted across devices.
    async list() {
        const all = await withTx(["later"], "readonly", r => later(r).getAll());
        return splitLater(all);
    },

    async get(id) {
        const item = await withTx(["later"], "readonly", r => later(r).get(id));
        if (!item) throw new NotFoundError("later", id);
        return item;
    },

    async count() {
        return withTx(["later"], "readonly", r => later(r).count());
    },

    // ----------------------------------------------------------- write side

    // The single write path. A form and an OS share both arrive here as the
    // same input shape, so there is one set of rules to reason about.
    async create(input) {
        const at = now();
        const x = validateLaterInput(input);
        const item = createLaterItem(x, { now: at, id: crypto.randomUUID() });
        await withTx(["later"], "readwrite", async r => {
            // Per-account quota: every stored item counts, done ones included.
            // Only a delete frees a slot.
            await guardQuota(r, T_LATER);
            await later(r).put(item);
        });
        await syncService.enqueue(T_LATER, item.id, "upsert", item);
        notify();
        return item;
    },

    // Web Share Target: the OS hands over a title, some text and a link â€” never
    // a form. The parsing is pure (domain/later.js: fromSharePayload) and it
    // returns exactly what a form would have produced, so this is `create` with
    // one step in front of it. An empty share throws and stores nothing.
    async createFromShare(payload) {
        return this.create(fromSharePayload(payload));
    },

    async update(id, patch) {
        const at = now();
        const current = await this.get(id);
        const x = validateLaterInput({ ...current, ...patch });
        // Following an item up is its own action (setCompleted), so an edit that
        // says nothing about it must neither close nor reopen it.
        const item = { ...current, ...x, completedAt: current.completedAt, updatedAt: at };
        await withTx(["later"], "readwrite", r => later(r).put(item));
        await syncService.enqueue(T_LATER, id, "upsert", item);
        notify();
        return item;
    },

    // "Followed up" is one stamp, not a boolean next to a date that could
    // disagree. Clearing it puts the item back at the top of the open list.
    // Asking for the state it is already in writes nothing: no record churn,
    // no needless sync traffic.
    async setCompleted(id, done) {
        const at = now();
        const current = await this.get(id);
        if (isDone(current) === Boolean(done)) return current;
        const item = { ...current, completedAt: done ? at : null, updatedAt: at };
        await withTx(["later"], "readwrite", r => later(r).put(item));
        await syncService.enqueue(T_LATER, id, "upsert", item);
        notify();
        return item;
    },

    async remove(id) {
        const at = now();
        // The note and its BYTES go in one transaction, on the same terms as a
        // page and its items (see pageService.remove): two writes would leave a
        // window in which the note is gone and a few hundred kilobytes of
        // photograph are still on the device with nothing pointing at them.
        // `noteMedia` is a local store and is never enqueued — the note's
        // tombstone is what the other devices hear about.
        await withTx(["later", "noteMedia"], "readwrite", async r => {
            await later(r).delete(id);
            await noteMedia(r).deleteByNote(id);
        });
        // A tombstone, exactly like every other delete: without it the other
        // devices never learn the id is gone and would push it back.
        await syncService.enqueue(T_LATER, id, "delete", null, at);
        notify();
        // Announced so the board can drop the card that pointed here. A card whose
        // original is gone is a card nobody can open, so the board must not be
        // left holding one. Emitted after the tombstone, so a device that is
        // mid-sync hears about the record going before it hears about the card.
        bus.emit("record-deleted", { service: "later", id });
    }
};
