import { req } from "./db.js";

// The BYTES of a note's attachments, and nothing else.
//
// A separate store from `later` for the same reason `pageItems` is a separate
// store from `pages` (Migration 7): a photo is 400 KB of binary and the note is
// 400 bytes of text, and last-write-wins compares one `updatedAt` per record. A
// blob on the note record would mean every attachment added dragged the whole
// note through the sync envelope, and — far worse — would put megabytes of
// base64 into a 1 MiB push. So the description travels with the note and the
// bytes stay in this store, on this device.
//
// A row is `{ id, noteId, blob }` and nothing else. The description of the
// attachment — its kind, name, size, duration — lives on the note record, which
// is where the other device can see it. `id` is the same uuid the description
// carries, so the two are found by one key and there is no second identifier
// that could disagree with the first.
//
// `noteId` is carried, and indexed, purely so the cascade can run: a note
// deleted on ANOTHER device arrives as a record with no descriptions left on it,
// so the ids of its attachments are gone and only this index can say which bytes
// are now orphaned. The same reason debtPayments carries a `debtId` index.
export const noteMediaRepo = s => ({
    get: id => req(s.get(id)),
    getAll: () => req(s.getAll()),
    put: x => req(s.put(x)),
    delete: id => req(s.delete(id)),
    count: () => req(s.count()),
    clear: () => req(s.clear()),
    byNote: noteId => req(s.index("noteId").getAll(noteId)),
    deleteByNote: noteId => new Promise((res, rej) => {
        const r = s.index("noteId").openCursor(IDBKeyRange.only(noteId));
        r.onsuccess = () => {
            const c = r.result;
            if (!c) return res();
            c.delete();
            c.continue();
        };
        r.onerror = () => rej(r.error);
    })
});
