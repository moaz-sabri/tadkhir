import { req } from "./db.js";

export const transactionsRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    // Newest first: walk the occurredAt index backwards.
    recent: limit => new Promise((res, rej) => {
        const r = s.index("occurredAt").openCursor(null, "prev");
        const out = [];
        r.onsuccess = () => {
            const c = r.result;
            if (!c || out.length >= limit) return res(out);
            out.push(c.value);
            c.continue();
        };
        r.onerror = () => rej(r.error);
    }),
    sinceOccurred: ts => req(s.index("occurredAt").getAll(IDBKeyRange.lowerBound(ts))),
    byCategory: category => req(s.index("category").getAll(category)),
    byRecurring: id => req(s.index("recurringId").getAll(id))
});
