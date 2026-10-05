import { req } from "./db.js";

export const debtsRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    byDirection: direction => req(s.index("direction").getAll(direction)),
    // A rename or a delete has to reach every debt using the category.
    byCategory: category => req(s.index("category").getAll(category))
});
