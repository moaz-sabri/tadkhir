import { req } from "./db.js";

export const sessionsRepo = s => ({
    get: id => req(s.get(id)),
    getActive: () => req(s.index("activeSlot").get(1)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    // As on every other record repo: the quota check is a count, and reading
    // the whole store to produce one was the only way before this existed.
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    // Newest sessions first: walk the startedAt index backwards.
    recent: limit => new Promise((res, rej) => {
        const r = s.index("startedAt").openCursor(null, "prev");
        const out = [];
        r.onsuccess = () => {
            const c = r.result;
            if (!c || out.length >= limit) return res(out);
            out.push(c.value);
            c.continue();
        };
        r.onerror = () => rej(r.error);
    }),
    byTask: (taskId, limit) => req(s.index("taskId").getAll(taskId, limit)),
    // Sessions started at or after ts; walk the startedAt index in reverse (newest first).
    sinceStarted: ts => new Promise((res, rej) => {
        const r = s.index("startedAt").openCursor(IDBKeyRange.lowerBound(ts), "prev");
        const out = [];
        r.onsuccess = () => {
            const c = r.result;
            if (!c) return res(out);
            out.push(c.value);
            c.continue();
        };
        r.onerror = () => rej(r.error);
    })
});