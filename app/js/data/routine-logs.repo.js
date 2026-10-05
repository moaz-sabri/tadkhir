import { req } from "./db.js";

// What a counter routine actually did, one row per routine per day.
//
// A log row is a tally and nothing else. It carries no title, no target and no
// schedule: every one of those belongs to the rule it points at, and a copy here
// would be a copy that could disagree with it. Reading "3 / 5" is therefore the
// day's count beside the rule's own target, and the reports aggregate these rows
// against the rules rather than describing anything themselves.
export const routineLogsRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    // One routine's history, which is what the reports read. Bounded by
    // MAX_ROUTINE_LOGS across every routine, and it is an index because this is
    // the one read here that is not "the whole store".
    byRoutine: routineId => req(s.index("routineId").getAll(routineId)),
    // Every routine's row for one day, which is what the home screen asks: today's
    // counts, and nothing else. The whole point of writing a row per day rather
    // than one running total per routine is that this read exists.
    byDay: dayKey => req(s.index("dayKey").getAll(dayKey)),

    // Used when a routine is removed and when a deleted routine arrives from
    // sync: its days go with it, never orphaned. Same cascade debtPayments and
    // pageItems have, because a row whose routine is gone is a number no screen
    // will ever be able to place.
    deleteByRoutine: routineId => new Promise((res, rej) => {
        const r = s.index("routineId").openCursor(IDBKeyRange.only(routineId));
        r.onsuccess = () => {
            const c = r.result;
            if (!c) return res();
            c.delete();
            c.continue();
        };
        r.onerror = () => rej(r.error);
    })
});
