import { req } from "./db.js";

// One card. The store is keyed on `id` (the card's own id, a fresh uuid), and
// `originalKey` — "service:id of the record it points at" — is a UNIQUE INDEX, not
// the key. So looking a card up by the record it points at means going through
// that index.
//
// `s.get(originalKey)` would be the primary-key read, and it silently answers
// undefined for every lookup, because no card is ever stored under its originalKey
// as its id. That is the kind of mistake that does not throw: `findByOriginalKey`
// returned null, "is this on the board?" answered no, and a card that was already
// on the board looked like it had never been added — so every row kept offering
// to add it again, and adding it again created nothing.
export const kanbanItemsRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    byStatus: status => req(s.index("status").getAll(status)),
    byTodayKey: todayKey => req(s.index("todayKey").getAll(todayKey)),
    byService: service => req(s.index("service").getAll(service)),
    byOriginalKey: originalKey => req(s.index("originalKey").get(originalKey))
});
