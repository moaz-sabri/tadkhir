import { req } from "./db.js";

// People are looked up by id from a debt's personId, or scanned (a short list)
// to find an existing person with the same name. No index is needed for either.
export const peopleRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear())
});
