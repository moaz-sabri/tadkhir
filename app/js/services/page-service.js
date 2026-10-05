import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import {
    validatePageInput,
    validatePageItemInput
} from "../domain/validation.js";
import {
    createPage,
    createPageItem,
    sortPages,
    sortItems,
    nextPosition,
    moveItem
} from "../domain/pages.js";
import { NotFoundError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const pages = reader("page");
const pageItems = reader("pageItem");

// Pages are the same generic record protocol as tasks, sessions, Later and
// finance: { type, id, op, data, updatedAt } against the existing outbox, push,
// pull, encryption, LWW and tombstones. Two types, because a page and the items
// inside it are two records (Migration 7) — and no transport, endpoint or
// server-side logic of their own.
const T_PAGE = "page";
const T_PAGE_ITEM = "pageItem";

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

export const pageService = {
    // ------------------------------------------------------------ read side

    // Newest first, derived on every read rather than stored, the same rule
    // Later follows: a local order is never trusted across devices.
    async list() {
        const all = await withTx(["pages"], "readonly", r => pages(r).getAll());
        return sortPages(all);
    },

    async get(id) {
        const page = await withTx(["pages"], "readonly", r => pages(r).get(id));
        if (!page) throw new NotFoundError("page", id);
        return page;
    },

    async count() {
        return withTx(["pages"], "readonly", r => pages(r).count());
    },

    // One page's items in the page's own order. The `pageId` index answers this
    // without reading the pages any other page owns.
    async items(pageId) {
        const rows = await withTx(["pageItems"], "readonly", r => pageItems(r).byPage(pageId));
        return sortItems(rows);
    },

    // The page and its items together, which is the only thing the editor screen
    // ever needs and the only way to guarantee the two were read as one state.
    async load(id) {
        const page = await this.get(id);
        return { page, items: await this.items(id) };
    },

    // ----------------------------------------------------------- write side

    async create(input = {}) {
        const at = now();
        const x = validatePageInput(input);
        const page = createPage(x, { now: at, id: crypto.randomUUID() });
        await withTx(["pages"], "readwrite", async r => {
            await guardQuota(r, T_PAGE);
            await pages(r).put(page);
        });
        await syncService.enqueue(T_PAGE, page.id, "upsert", page);
        notify();
        return page;
    },

    async update(id, patch) {
        const at = now();
        const current = await this.get(id);
        const x = validatePageInput({ ...current, ...patch });
        const page = { ...current, ...x, updatedAt: at };
        await withTx(["pages"], "readwrite", r => pages(r).put(page));
        await syncService.enqueue(T_PAGE, id, "upsert", page);
        notify();
        return page;
    },

    // Deleting a page takes its items with it, in the same transaction and the
    // same outbox batch. An item whose page is gone cannot be reached by any
    // screen, so leaving them behind would be invisible data that still syncs —
    // and a reordering device would resurrect them. This is the debt/payments
    // cascade, and it has to exist on the receiving side too (sync-service's
    // applyChanges), or the same delete from another device would leave them.
    async remove(id) {
        const at = now();
        const doomed = await withTx(["pages", "pageItems"], "readwrite", async r => {
            const list = await pageItems(r).byPage(id);
            await pageItems(r).deleteByPage(id);
            await pages(r).delete(id);
            return list;
        });
        // One outbox transaction for the lot: a long page deletes a lot of rows,
        // and each one used to cost a transaction of its own.
        await syncService.enqueueMany([
            { type: T_PAGE, id, op: "delete", data: null, at },
            ...doomed.map(x => ({ type: T_PAGE_ITEM, id: x.id, op: "delete", data: null, at }))
        ]);
        notify();
        // Announced so the board can drop the card that pointed here, for the same
        // reason every service says it: a card whose page is gone is a card nobody
        // can open.
        bus.emit("record-deleted", { service: "pages", id });
    },

    // ------------------------------------------------------------ page items

    // Appended to the end, never inserted: adding an item must not renumber the
    // ones already on the page, or adding one line would rewrite the whole page
    // on every device that has it.
    async addItem(pageId, input) {
        const at = now();
        // Throws NotFoundError for a page that is not there, so an item can never
        // be added to a page that will not be there to show it.
        await this.get(pageId);
        const current = await this.items(pageId);
        const x = validatePageItemInput({ ...input, pageId });
        const item = createPageItem(x, {
            now: at,
            id: crypto.randomUUID(),
            position: nextPosition(current)
        });
        await withTx(["pageItems"], "readwrite", async r => {
            await guardQuota(r, T_PAGE_ITEM);
            await pageItems(r).put(item);
        });
        await syncService.enqueue(T_PAGE_ITEM, item.id, "upsert", item);
        notify();
        return item;
    },

    async updateItem(pageId, itemId, patch) {
        const at = now();
        const current = await this._item(pageId, itemId);
        // The kind and the position are not editable: a type is what the body is,
        // and the position belongs to a reorder. Both are set by their own
        // operations, and an edit that could change them would let a text save
        // silently reorder the page.
        const x = validatePageItemInput({
            ...current,
            ...patch,
            pageId: current.pageId,
            type: current.type,
            position: current.position
        });
        const item = { ...current, content: x.content, updatedAt: at };
        await withTx(["pageItems"], "readwrite", r => pageItems(r).put(item));
        await syncService.enqueue(T_PAGE_ITEM, itemId, "upsert", item);
        notify();
        return item;
    },

    async removeItem(pageId, itemId) {
        const at = now();
        await this._item(pageId, itemId);
        await withTx(["pageItems"], "readwrite", r => pageItems(r).delete(itemId));
        // A tombstone, like every other delete: without it the other devices
        // never learn the line is gone and would push it straight back.
        await syncService.enqueue(T_PAGE_ITEM, itemId, "delete", null, at);
        notify();
    },

    // Move one item and renumber. The new order is computed by a pure function
    // (domain/pages.js: moveItem) and only the rows whose position actually
    // changed are written — which for the up and down buttons is two rows
    // whatever the length of the page, instead of a rewrite of all of it on
    // every device that has it.
    //
    // Closing the gap matters more than it looks: a position list with a hole in
    // it has no defined "last" position, and the next appended item would land
    // inside the gap and appear in the wrong place.
    async move(pageId, itemId, toIndex) {
        const at = now();
        const current = await this.items(pageId);
        const ordered = moveItem(current, itemId, toIndex);
        const before = new Map(current.map(x => [x.id, x.position]));
        const changed = ordered.filter(x => before.get(x.id) !== x.position)
            .map(x => ({ ...x, updatedAt: at }));

        // Nothing moved: no write, and no fresh updatedAt either. Stamping a
        // record that did not change is a last-write-wins the other device has to
        // be told about for nothing.
        if (changed.length === 0) return current;
        await withTx(["pageItems"], "readwrite", async r => {
            for (const item of changed) await pageItems(r).put(item);
        });
        await syncService.enqueueMany(changed.map(item => ({
            type: T_PAGE_ITEM, id: item.id, op: "upsert", data: item, at
        })));
        notify();
        return ordered.map(x => (before.get(x.id) === x.position ? x : { ...x, updatedAt: at }));
    },

    // An item addressed the way a screen can address it: by the page it belongs
    // to AND its own id. The page check is not ceremony — it is what stops a row
    // action built from a stale render from moving or deleting an item on a
    // different page.
    async _item(pageId, itemId) {
        const row = await withTx(["pageItems"], "readonly", r => pageItems(r).get(itemId));
        if (!row || row.pageId !== pageId) throw new NotFoundError("pageItem", itemId);
        return row;
    }
};
