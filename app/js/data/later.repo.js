import { req } from "./db.js";

// Later items. No index on purpose: the store is capped at MAX_LATER_ITEMS and
// every screen reads the whole list anyway (it has to split open from done),
// so a getAll plus a sort in JS is the entire query. An index here would be a
// promise made by the migration that no read path uses.
export const laterRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear())
});
