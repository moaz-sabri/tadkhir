import { req } from "./db.js";

// Pages. No index on purpose, the same decision as later.repo.js: the store is
// capped at MAX_PAGES and the list screen reads the whole list, so there is
// nothing for an index to serve. The items inside a page are a separate store
// (Migration 7) precisely because they are read per page, not with it.
export const pagesRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear())
});
