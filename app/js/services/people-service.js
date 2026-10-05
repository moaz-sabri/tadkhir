import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import { validatePersonInput } from "../domain/validation.js";
import { createPerson } from "../domain/finance.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const people = reader("person");

// People ride the same generic record protocol as the rest of Finance: one sync
// type, one outbox entry, LWW. A person has no type of its own — debtor or
// creditor is decided by each debt that points at them.
const T_PERSON = "person";

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

// The debt form can type a new name inline, so the same person must not end up
// stored twice under two ids. Comparison is case-insensitive and trimmed, which
// is how the picker itself orders and matches names.
export function sameName(a, b) {
    return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

export const peopleService = {
    async list() {
        const rows = await withTx(["people"], "readonly", r => people(r).getAll());
        return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    async get(id) {
        if (!id) return null;
        return withTx(["people"], "readonly", r => people(r).get(id));
    },

    // Resolve a name to an existing person, if there is one.
    //
    // Straight off the store, not off list(): list() sorts every name before
    // this scans them for a match, and the order is thrown away by find().
    async findByName(name) {
        const rows = await withTx(["people"], "readonly", r => people(r).getAll());
        return rows.find(p => sameName(p.name, name)) ?? null;
    },

    // Create a person, or return the existing one with that name. Callers use
    // this for the "pick someone or type a new name" flow, where a repeat of a
    // name already on file is the same person, not a new one.
    async create(input) {
        const existing = await this.findByName(input?.name);
        if (existing) return existing;

        const at = Date.now();
        const x = validatePersonInput(input);
        const record = createPerson(x, { now: at, id: crypto.randomUUID() });
        await withTx(["people"], "readwrite", async r => {
            await guardQuota(r, T_PERSON);
            await people(r).put(record);
        });
        await syncService.enqueue(T_PERSON, record.id, "upsert", record, at);
        notify();
        return record;
    }
};
