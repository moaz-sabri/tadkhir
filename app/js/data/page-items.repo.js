import { req } from "./db.js";

// The items inside a page: a heading, a paragraph, a divider, or a pointer at a
// record that already exists somewhere else.
//
// A pointer is a POINTER. Nothing here copies a task, a session, a Later item or
// a money record — the item holds the id, and the page screen reads the original
// through the service that owns it. That is the whole design of the feature, and
// this store is where it has to be kept: a snapshot here would go stale the
// moment the original was edited or deleted, and two devices would show two
// different answers for the same page.
export const pageItemsRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    byPage: pageId => req(s.index("pageId").getAll(pageId)),
    // Used when a page is removed and when a deleted page arrives from sync: the
    // items go with it, never orphaned. The same cascade debtPayments has for a
    // debt, because an item without a page is unreachable by any screen.
    deleteByPage: pageId => new Promise((res, rej) => {
        const r = s.index("pageId").openCursor(IDBKeyRange.only(pageId));
        r.onsuccess = () => {
            const c = r.result;
            if (!c) return res();
            c.delete();
            c.continue();
        };
        r.onerror = () => rej(r.error);
    })
});
