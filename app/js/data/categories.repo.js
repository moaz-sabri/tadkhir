import { req } from "./db.js";

// The store's key IS the category name, so there is nothing to index: the whole
// list is a handful of rows and every read is a getAll.
export const categoriesRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear())
});
