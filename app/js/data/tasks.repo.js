import { req } from "./db.js";

export const tasksRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    // The whole store interface, like every other record repo. Tasks were the
    // one store without a count, so the quota check had to read every task to
    // produce a number count() returns — and guardQuota, which is how every
    // other quota is checked, could not be used here at all.
    count: () => req(s.count()),
    clear: () => req(s.clear())
});