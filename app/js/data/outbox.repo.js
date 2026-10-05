import { req } from "./db.js";

export const outboxRepo = s => ({
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: key => req(s.delete(key)),
    clear: () => req(s.clear())
});