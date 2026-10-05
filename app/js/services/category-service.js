import { withTx } from "../data/db.js";
import { reader, guardQuota, recordFor } from "../data/stores.js";
import { validateCategoryInput, DEFAULT_FINANCE_CATEGORY } from "../domain/validation.js";
import { createCategory } from "../domain/finance.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const categories = reader("category");

// Categories ride the same generic record protocol as the rest of Finance: one
// sync type, one outbox entry, LWW like every other document. There is no
// category endpoint and no category-specific transport.
const T_CATEGORY = "category";

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

// Every record that can carry a category. Only the TYPES are named here — the
// store and the repo for each come from data/stores.js, so this list can no
// longer name a store the record does not live in, or read one through a repo
// belonging to a different record. Renaming a category therefore has to touch
// all three, and there is one place that knows which they are.
const CATEGORY_BEARERS = ["transaction", "recurring", "debt"];

// Reads every record that names `id`, paired with the repo that reads it.
// Shared by the rename (rewrite to the new name) and the delete (move to the
// default, or drop the record) so both see exactly the same set.
async function linkedWrites(r, id) {
    const out = [];
    for (const type of CATEGORY_BEARERS) {
        const record = recordFor(type);
        const repo = record.repo(r[record.store]);
        for (const row of await repo.byCategory(id)) {
            out.push({ row, repo, type });
        }
    }
    return out;
}

export const categoryService = {
    // ------------------------------------------------------------- read side

    async list() {
        const rows = await withTx(["categories"], "readonly", r => categories(r).getAll());
        // Local order is not trusted across devices, so the display order is
        // re-derived from the ids themselves.
        return rows.sort((a, b) => a.id.localeCompare(b.id));
    },

    // The management screen needs each category together with how many records
    // point at it, so it can say what deleting one would actually affect. One
    // read pass over all three stores, not one query per category: a list of
    // sixty categories would otherwise be sixty separate transactions.
    async listWithUsage() {
        return withTx(["categories", "transactions", "recurring", "debts"], "readonly", async r => {
            const rows = await categories(r).getAll();
            const counts = new Map(rows.map(c => [c.id, { total: 0, transactions: 0, recurring: 0, debts: 0 }]));
            for (const type of CATEGORY_BEARERS) {
                const record = recordFor(type);
                const all = await record.repo(r[record.store]).getAll();
                for (const row of all) {
                    const usage = counts.get(row.category);
                    if (!usage) continue;
                    usage.total += 1;
                    usage[type === "transaction" ? "transactions" : type] += 1;
                }
            }
            return rows
                .map(c => ({ ...c, usage: counts.get(c.id) }))
                .sort((a, b) => a.id.localeCompare(b.id));
        });
    },

    async get(id) {
        return withTx(["categories"], "readonly", r => categories(r).get(id));
    },

    // ------------------------------------------------------------- write side

    async create(input) {
        const at = Date.now();
        // validateCategoryInput returns the trimmed NAME, not an object, so it
        // must not be destructured. Destructuring it yielded id === undefined,
        // and get(undefined) on a keyPath store throws a DataError that carries
        // no error code — so adding a category failed without a usable message.
        const id = validateCategoryInput(input?.id);
        const record = createCategory({ id }, { now: at });
        await withTx(["categories"], "readwrite", async r => {
            if (await categories(r).get(id)) {
                throw new ValidationError("id", "category_exists");
            }
            await guardQuota(r, T_CATEGORY);
            await categories(r).put(record);
        });
        await syncService.enqueue(T_CATEGORY, id, "upsert", record, at);
        notify();
        return record;
    },

    // A rename is a new id plus every record that used the old one. They are
    // all rewritten in one IndexedDB transaction, so a device can never observe
    // a record pointing at a category that does not exist — which is the one
    // state the write-side guard (assertCategoryExists) refuses to accept.
    async rename(id, nextId) {
        const at = Date.now();
        const name = validateCategoryInput(nextId);
        const record = createCategory({ id: name }, { now: at });
        if (name === id) return record;

        const queued = [];
        await withTx(
            ["categories", "transactions", "recurring", "debts"],
            "readwrite",
            async r => {
                const current = await categories(r).get(id);
                if (!current) throw new NotFoundError("category", id);
                if (await categories(r).get(name)) {
                    throw new ValidationError("id", "category_exists");
                }
                for (const link of await linkedWrites(r, id)) {
                    const moved = { ...link.row, category: name, updatedAt: at };
                    await link.repo.put(moved);
                    queued.push({ type: link.type, id: moved.id, op: "upsert", data: moved });
                }
                await categories(r).delete(id);
                await categories(r).put(record);
            }
        );

        // One outbox transaction for the whole rename, not one per record.
        await syncService.enqueueMany([
            ...queued,
            { type: T_CATEGORY, id, op: "delete", data: null, at },
            { type: T_CATEGORY, id: name, op: "upsert", data: record, at }
        ]);
        notify();
        return record;
    },

    // Delete a category that still has records attached. The caller has to say
    // what happens to them: `move` puts them in the default category, `delete`
    // removes them. Refusing to guess is the point — silently filing someone's
    // records under "Other" (or dropping them) is not a decision this makes.
    async remove(id, strategy) {
        const at = Date.now();
        if (id === DEFAULT_FINANCE_CATEGORY) {
            throw new ValidationError("id", "category_default");
        }

        const queued = [];
        await withTx(
            ["categories", "transactions", "recurring", "debts"],
            "readwrite",
            async r => {
                const current = await categories(r).get(id);
                if (!current) throw new NotFoundError("category", id);

                for (const link of await linkedWrites(r, id)) {
                    if (strategy === "delete") {
                        await link.repo.delete(link.row.id);
                        queued.push({ type: link.type, id: link.row.id, op: "delete", data: null });
                    } else {
                        const moved = { ...link.row, category: DEFAULT_FINANCE_CATEGORY, updatedAt: at };
                        await link.repo.put(moved);
                        queued.push({ type: link.type, id: moved.id, op: "upsert", data: moved });
                    }
                }
                await categories(r).delete(id);
            }
        );

        await syncService.enqueueMany([
            ...queued,
            { type: T_CATEGORY, id, op: "delete", data: null, at }
        ]);
        notify();
    }
};
