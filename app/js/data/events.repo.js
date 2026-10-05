import { req } from "./db.js";

export const eventsRepo = s => ({
    add: x => req(s.add(x)),
    get: id => req(s.get(id)),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    // The rest of the store interface, like every other record repo. Events
    // were the one store a reader had to walk by hand for a whole-store read,
    // which is why a backup used to spell out its own cursor for them.
    getAll: () => req(s.getAll()),
    count: () => req(s.count()),
    bySession: id => req(s.index("sessionId").getAll(id)),
    deleteBySession: id => new Promise((res, rej) => {
        const r = s.index("sessionId").openCursor(IDBKeyRange.only(id));
        r.onsuccess = () => {
            const c = r.result;
            if (!c) return res();
            c.delete();
            c.continue();
        };
        r.onerror = () => rej(r.error);
    }),
    clear: () => req(s.clear())
});