import { withTx } from "../data/db.js";
import { RECORDS, BACKUP_STORES, VOCABULARY_TYPES, recordFor } from "../data/stores.js";
import { metaRepo } from "../data/meta.repo.js";
import { assertImportShape, MAX_IMPORT_BYTES, BUILTIN_FINANCE_CATEGORIES } from "../domain/validation.js";
import { ImportError, ValidationError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";
import * as cryptoService from "./crypto-service.js";
import { authService } from "./auth-service.js";

// The stores a backup and a restore cover, and the field each record occupies in
// the file, both come from data/stores.js. Three lists used to be written out
// here and in sync-service by hand — the store list, the finance group limits
// and the record-to-backup-key mapping — and a record added to the registry
// without being added to all three would have been silently left out of every
// backup.

// Which records need a per-record cap on the way IN. Tasks and sessions have
// their own (they are not "finance" and the message says so); everything the
// registry carries a quota for is checked through the registry itself, so the
// cap, the field the error points at and the message are one decision.
const QUOTAS = RECORDS.filter(r => r.quota);
const OVER_CAP = Object.fromEntries(QUOTAS.map(r => [r.backupKey, r.quota]));

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

// Owner secret code: a fixed number that is set ONCE (first export or import)
// and binds the account to a single owner; afterwards every export/import must
// provide the same number again (see authService.resolveOwner).
const resolveOwner = ownerCode => authService.resolveOwner(ownerCode);

// Every record's rows, under the key it occupies in the backup file. Derived
// from the registry, so a new record is exported by existing here rather than
// needing a tenth line.
async function readAllRecords(r) {
    const out = {};
    for (const record of RECORDS) {
        out[record.backupKey] = await record.repo(r[record.store]).getAll();
    }
    // A running session carries a device-local active slot, which means nothing
    // on another device and must never leave this one.
    out.sessions = out.sessions.map(({ activeSlot, ...s }) => s);
    return out;
}

function normalizeImport(data) {
    const at = Date.parse(data.exportedAt) || Date.now();
    const tasks = data.tasks.map(t => ({ ...t, usageCount: 0, lastUsedAt: null }));
    const byTask = new Map(tasks.map(t => [t.id, t]));
    const newEvents = [];

    const sessions = data.sessions.map(x => {
        const s = {
            ...x,
            segments: x.segments.map(y => ({ ...y })),
            taskItems: Array.isArray(x.taskItems)
                ? x.taskItems.map(y => ({ id: y.id, title: y.title, completed: Boolean(y.completed) }))
                : []
        };
        delete s.activeSlot;

        if (s.status === "running") {
            const last = s.segments.at(-1);
            if (last?.end == null) last.end = at;
            s.status = "paused";
            s.endedAt = null;
            s.actualMs = null;
            newEvents.push({ id: crypto.randomUUID(), sessionId: s.id, type: "session.paused", at, data: { reason: "import" } });
        }

        if (s.status === "completed" && s.taskId && byTask.has(s.taskId)) {
            const t = byTask.get(s.taskId);
            t.usageCount += 1;
            t.lastUsedAt = Math.max(t.lastUsedAt ?? 0, s.endedAt ?? s.startedAt);
        }
        return s;
    });

    return { ...data, tasks, sessions, events: [...data.events, ...newEvents] };
}

// Finance is stored as-is: no derived field is persisted, so there is nothing
// to recompute on the way in or out. Categories and people default to the
// built-in set and an empty list: a backup written before they existed must
// still import, and it needs the categories its own records already name.
//
// The built-in default is the same `{ id }` shape assertImportShape defaults
// to, and it has to be: importAll writes each entry straight into a store
// keyed on `id`, so a bare string here threw a DataError and took the whole
// restore down with it. Every backup without a `financeCategories` key — which
// is every backup written before categories existed — failed at exactly this
// line.
function normalizeFinance(data) {
    return {
        financeTransactions: data.financeTransactions ?? [],
        financeRecurring: data.financeRecurring ?? [],
        financeDebts: data.financeDebts ?? [],
        financeDebtPayments: data.financeDebtPayments ?? [],
        financeCategories: data.financeCategories ?? BUILTIN_FINANCE_CATEGORIES.map(id => ({ id })),
        financePeople: data.financePeople ?? []
    };
}

// Later is stored as-is too, and defaults to an empty list for the same
// reason: a backup written before the feature existed must still import.
//
// The attachment DESCRIPTIONS are kept and the BYTES are not, because a JSON
// backup cannot carry bytes — see domain/attachments.js for why they do not sync
// either. What a restore has to decide is what to do with a description whose
// file is not coming, and the answer is: drop it. A restored note that says "3
// photos" and can open none of them is a claim the app cannot keep, and it is
// worse than a note with no text at all, because the user has no way to clear
// the count. The notes themselves, and their words, come back untouched.
function normalizeLater(data) {
    return {
        later: (data.later ?? []).map(item => (
            Array.isArray(item?.attachments) && item.attachments.length
                ? { ...item, attachments: [] }
                : item
        ))
    };
}

// Pages, and their items, on the same terms. Both keys are defaulted together:
// a backup that carries a page and no items is a page the user never wrote on,
// and one that carries items and no pages is a state no screen can render.
function normalizePages(data) {
    return { pages: data.pages ?? [], pageItems: data.pageItems ?? [] };
}

// The board, on the same terms as everything else added after v1: a backup
// written before it existed carries no cards and restores as an empty board.
//
// This function exists because the code above is DERIVED from the record
// registry, not written out per feature: `OVER_CAP` is built from every record
// that declares a quota, and the import path counts `data[key].length` for each
// of them. Registering a quota-bearing record therefore makes every restore
// require a normalizer for it, and the failure is a TypeError about `.length` of
// undefined in the middle of a restore — which reads as a corrupt backup and
// tells the user nothing about the board at all.
function normalizeKanban(data) {
    // Only the fields a card is made of, and only ones that are present: a card
    // written by a future version may carry a column this build has never heard
    // of, and dropping the whole card for that would be losing the user's board
    // over a field the older build simply does not understand.
    const cards = Array.isArray(data.kanbanItems) ? data.kanbanItems : [];
    return {
        kanbanItems: cards.filter(card => card && typeof card === "object" && typeof card.id === "string")
    };
}

// The routines and the days a counter recorded, on the same terms as everything
// else added after v1: a backup written before they existed carries neither and
// restores as an empty routine list.
//
// This function exists for the same reason normalizeKanban's does: the import path
// is DERIVED from the record registry, and every record that declares a quota has
// to be counted on the way in. Registering a quota-bearing record without a
// normalizer makes a restore of an older backup fail with a TypeError about
// `.length` of undefined in the middle of the restore — which reads as a corrupt
// file and says nothing at all about routines.
//
// Both keys are defaulted together. A day row without its rule, or a rule without
// any of its days, is a half a set nothing can draw: the first is a number with
// nothing to place it, the second is simply a rule with no history yet, which is
// what a rule created this morning looks like.
function normalizeRoutines(data) {
    return {
        routines: Array.isArray(data.routines) ? data.routines : [],
        routineLogs: Array.isArray(data.routineLogs) ? data.routineLogs : []
    };
}

export const backupService = {
    /**
     * Export all data encrypted with the master key.
     *
     * Password is mandatory — no exceptions:
     *  - First use (no encrypted key yet): the password CREATES the encrypted
     *    key that protects this device (the user sets it here).
     *  - Existing key: the password is VERIFIED before anything is exported.
     *  - Wrong/missing password fails safely: no data leaves the device and
     *    nothing is partially exported.
     *
     * The owner secret code is mandatory too: it is set once on the first export
     * and verified on every later export (the account is bound to it and the
     * number never changes).
     *
     * The backup embeds the encrypted master key (ek) + owner verifier, so it
     * can be restored on a brand-new device with only the password + owner code.
     */
    async exportAll({ password = null, ownerCode = null } = {}) {
        if (!password) return { ok: false, code: "password_required" };

        let mk = authService.getMasterKey();
        const hasEncryptedKey = !!(await cryptoService.getEncryptedKey())?.d;
        let encryptedKey = null;

        if (!hasEncryptedKey) {
            const created = await authService.createSpace({ code: null, password });
            if (!created.ok) return created;
            mk = authService.getMasterKey();
            encryptedKey = created.encryptedKey;
        } else {
            // Verify ownership: decrypting the stored encrypted key with the
            // provided password. On failure we return before touching data.
            mk = await authService.recoverWithPassword(password);
            if (!mk) return { ok: false, code: "invalid_credentials" };
            encryptedKey = await cryptoService.getEncryptedKey();
        }

        const owner = await resolveOwner(ownerCode);
        if (!owner.ok) return owner;

        const rawData = await withTx([...BACKUP_STORES, "meta"], "readonly", async r => ({
            app: "task-timer",
            version: 1,
            exportedAt: new Date().toISOString(),
            // One line instead of ten, and the events no longer need a
            // hand-rolled cursor walk: getAll() is the same read.
            ...(await readAllRecords(r)),
            settings: (await metaRepo(r.meta).get("settings"))?.value || {}
        }));

        const encrypted = await cryptoService.encryptData(mk, rawData);
        const payload = {
            app: "task-timer",
            v: 1,
            d: encrypted,
            ek: encryptedKey && encryptedKey.d ? { v: encryptedKey.v ?? 1, d: encryptedKey.d } : null,
            owner: owner.verifier || null
        };
        const blob = new Blob([JSON.stringify(payload)], { type: "application/octet-stream" });
        await withTx(["meta"], "readwrite", r => metaRepo(r.meta).set("lastBackup", Date.now()));
        return { ok: true, blob, filename: `task-timer-${new Date().toISOString().slice(0, 10)}.enc` };
    },

    /**
     * Parse + decrypt a backup file.
     *
     * Password is mandatory — no exceptions. The password must decrypt a master
     * key: the device's own encrypted key, or (on a brand-new device) the key
     * embedded in the backup itself. A wrong/missing password fails safely with
     * a clear error and no data is loaded.
     *
     * opts.getOwnerCode() is called when the backup (or this device) carries an
     * owner secret-code verifier; the provided number is checked against it and
     * the import is refused when it does not match (files belong to one owner
     * and cannot be shared with different people).
     */
    async parse(text, password, opts = {}) {
        if (!password) throw new ImportError("password_required");
        if (new Blob([text]).size > MAX_IMPORT_BYTES) throw new ImportError("too_large");
        let obj;
        try { obj = JSON.parse(text); } catch { throw new ImportError("not_json"); }
        if (!obj || typeof obj !== "object" || obj.app !== "task-timer" || !obj.d) {
            throw new ImportError("invalid_format");
        }

        const localEnc = await cryptoService.getEncryptedKey();
        let mk = null;
        let usedFileKey = false;
        if (localEnc && localEnc.d) {
            try { mk = await cryptoService.decryptMasterKey(localEnc, password); } catch { mk = null; }
        }
        if (!mk && obj.ek && obj.ek.d) {
            try { mk = await cryptoService.decryptMasterKey(obj.ek, password); usedFileKey = true; } catch { mk = null; }
        }
        if (!mk) throw new ImportError(localEnc && localEnc.d ? "invalid_credentials" : "no_encrypted_key");

        // Owner secret code check (fixed per account; set once on first use).
        // Verified here, persisted at the very end: everything between can still
        // fail, and a device that had already bound itself to a file it could
        // not read had no way back — every later export verified against a key
        // the user had never chosen.
        const fileOwner = obj.owner && typeof obj.owner === "object" ? obj.owner : null;
        const ownerVerifier = fileOwner || (await authService.getOwnerVerifier()) || null;
        let pendingOwnerVerifier = null;
        if (ownerVerifier) {
            let ownerCode = opts.ownerCode;
            if (ownerCode == null && typeof opts.getOwnerCode === "function") {
                ownerCode = await opts.getOwnerCode();
                if (!ownerCode) throw new ImportError("cancelled");
            }
            if (!ownerCode) throw new ImportError("owner_code_required");
            const ok = await authService.verifyOwnerCode(ownerCode, ownerVerifier);
            if (!ok) throw new ImportError("owner_mismatch");
            if (!(await authService.getOwnerVerifier())) pendingOwnerVerifier = ownerVerifier;
        } else if (typeof opts.getOwnerCode === "function") {
            // Legacy file without owner info: the first import sets it once.
            // The owner secret number is required here too — cancel = abort.
            const ownerCode = await opts.getOwnerCode();
            if (!ownerCode) throw new ImportError("cancelled");
            pendingOwnerVerifier = await cryptoService.createOwnerVerifier(ownerCode);
        }

        const rawData = await cryptoService.decryptData(mk, obj.d);
        if (!rawData) throw new ImportError("decryption_failed");
        assertImportShape(rawData);

        // The payload is real and well-formed, so the file is genuinely the one
        // this password opens. Now — and only now — does this device take it on.
        if (usedFileKey && !(localEnc && localEnc.d)) {
            await authService.openSpace({ code: null, password, getEncryptedKey: () => obj.ek });
        }
        if (pendingOwnerVerifier) await authService.storeOwnerVerifier(pendingOwnerVerifier);

        const data = {
            ...normalizeImport(rawData),
            ...normalizeFinance(rawData),
            ...normalizeLater(rawData),
            ...normalizePages(rawData),
            ...normalizeKanban(rawData),
            ...normalizeRoutines(rawData)
        };
        const preview = { tasks: data.tasks.length, sessions: data.sessions.length, events: data.events.length };
        for (const key of Object.keys(OVER_CAP)) preview[key] = data[key].length;
        preview.later = data.later.length;
        preview.pages = data.pages.length;
        preview.pageItems = data.pageItems.length;
        preview.routines = data.routines.length;
        preview.routineLogs = data.routineLogs.length;
        return { data, preview };
    },

    async importAll(data) {
        const clean = {
            ...normalizeImport(data),
            ...normalizeFinance(data),
            ...normalizeLater(data),
            ...normalizePages(data),
            ...normalizeKanban(data),
            ...normalizeRoutines(data)
        };
        // Account quotas also apply to restored backups: too many records and
        // the sync server would reject the space. Ask the user to trim or create
        // a new account instead of silently overfilling. Every cap, and the
        // field and message each one reports, comes from the registry.
        for (const record of QUOTAS) {
            const { max, field, code } = record.quota;
            if (clean[record.backupKey].length > max) {
                throw new ValidationError(field, code);
            }
        }
        await withTx([...BACKUP_STORES, "meta"], "readwrite", async r => {
            for (const record of RECORDS) await record.repo(r[record.store]).clear();
            // The vocabularies first, then everything written in them. The
            // comment above this used to promise this order while the
            // statements did the opposite; VOCABULARY_TYPES is what keeps the
            // promise and the code agreeing.
            const ordered = [
                ...RECORDS.filter(x => VOCABULARY_TYPES.includes(x.type)),
                ...RECORDS.filter(x => !VOCABULARY_TYPES.includes(x.type))
            ];
            for (const record of ordered) {
                const repo = record.repo(r[record.store]);
                for (const x of clean[record.backupKey]) await repo.put({ ...x });
            }
            await metaRepo(r.meta).set("settings", clean.settings || {});
        });
        // Rebuild the sync queue from the imported data: pending ops for
        // records that no longer exist are dropped, and every imported record
        // is queued so it reaches the server without any local loss (works
        // fully offline; the queue flushes when the connection returns).
        //
        // One enqueueMany for the lot. Looping enqueue() per record opened one
        // IndexedDB transaction per row, so restoring a full account cost
        // thousands of them and the restore crawled.
        //
        // The queue is emptied first, so pending ops for records this restore
        // does not bring back are dropped rather than pushed afterwards.
        await syncService.clearOutbox();
        // One batch for the lot, and the record-to-type mapping comes from the
        // registry: a new record is queued for sync by existing here, instead of
        // needing a line of its own in a list that had ten.
        const queue = [];
        for (const record of RECORDS) {
            for (const x of clean[record.backupKey]) {
                // An event is dated by the moment it happened; everything else
                // by when the record last changed.
                const at = record.type === "event"
                    ? (x.at ?? x.updatedAt ?? Date.now())
                    : (x.updatedAt ?? x.startedAt ?? Date.now());
                queue.push({ type: record.type, id: x.id, op: "upsert", data: x, at });
            }
        }
        await syncService.enqueueMany(queue);
        notify();
    },

    async clearAll() {
        await withTx([...BACKUP_STORES, "meta"], "readwrite", async r => {
            for (const record of RECORDS) await record.repo(r[record.store]).clear();
            // Categories are the one store that is NOT left empty: the default
            // category is what every finance form falls back to, and the app
            // guarantees it exists (it cannot be deleted). Wiping it would leave
            // the finance forms with nothing to file a new record under, so the
            // built-in set is restored right here — the same state Migration 5
            // leaves a brand-new device in. Like the rest of clearAll, nothing is
            // pushed: a wiped device re-syncs from the server or is set up again.
            const categories = recordFor("category").repo(r.categories);
            for (const id of BUILTIN_FINANCE_CATEGORIES) {
                await categories.put({ id, createdAt: Date.now(), updatedAt: Date.now() });
            }
            const settings = (await metaRepo(r.meta).get("settings"))?.value || {};
            await metaRepo(r.meta).set("settings", { ...settings, language: settings.language });
        });
        await syncService.clearOutbox();
        notify();
    }
};
