import { req } from "./db.js";

// The routine RULES. No index on purpose, the same reasoning as `later`: the
// store is capped at MAX_ROUTINES, and every screen reads the whole list anyway
// — the home screen filters it to today and the reports read all of it. There is
// nothing for an index to serve.
export const routinesRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear())
});
