import { req } from "./db.js";

export const debtPaymentsRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    add: x => req(s.add(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    byDebt: debtId => req(s.index("debtId").getAll(debtId)),
    // Used when a debt is removed and when a deleted debt arrives from sync:
    // the payments go with it, never orphaned.
    deleteByDebt: debtId => new Promise((res, rej) => {
        const r = s.index("debtId").openCursor(IDBKeyRange.only(debtId));
        r.onsuccess = () => {
            const c = r.result;
            if (!c) return res();
            c.delete();
            c.continue();
        };
        r.onerror = () => rej(r.error);
    })
});
