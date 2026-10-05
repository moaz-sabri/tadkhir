import { withTx } from "../data/db.js";
import { reader, localReader } from "../data/stores.js";
import { validateAttachments } from "../domain/validation.js";
import { attachmentList } from "../domain/attachments.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { laterService } from "./later-service.js";

const later = reader("later");
const media = localReader("noteMedia");

// Attachments are a note's photos, recordings and documents, and they live in
// two places on purpose:
//
//   the DESCRIPTION  — an `attachments` array on the Later record: kind, name,
//                      size, duration, dimensions. A few hundred bytes of
//                      ordinary JSON, so it syncs, so a backup carries it, and so
//                      another device can say what the note holds even though
//                      it cannot open what it holds;
//   the BYTES        — the `noteMedia` store, on this device only.
//
// Nothing here enqueues anything. The outbox is a record queue, a blob is not a
// record, and a push of 400 KB of base64 would be refused by the server's own
// 1 MiB ceiling long before it reached a database. So an attachment is added by
// writing the blob in one transaction and then rewriting the note record with
// the new description in another — the note write is what syncs, and it carries
// no bytes.
//
// The consequence, stated once so it is not rediscovered as a bug: an
// attachment is visible on the device that captured it, and described — but not
// openable — on every other device. `blobOf` is what a viewer calls, and its
// null is the honest answer, not a failed load.

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
}

/**
 * The Blob for one attachment, or null when it is not on this device.
 *
 * The one function a viewer, a player or a download needs, and the reason it
 * exists rather than letting callers touch the store: "described here, bytes
 * elsewhere" is a real state, and it has exactly one answer.
 */
export async function blobOf(noteId, attachmentId) {
    const row = await withTx(["noteMedia"], "readonly", r => media(r).get(attachmentId));
    // The noteId is checked as well as the id. An id is a uuid, so a wrong one is
    // a bug rather than an attack, but a media row belonging to a DIFFERENT note
    // is a row a caller must not be handed by asking for the wrong note.
    if (!row || row.noteId !== noteId) return null;
    return row.blob ?? null;
}

export const attachmentService = {
    /**
     * The Blob for one attachment, or null when it is not on this device.
     *
     * On the service as well as as a bare function, because "described here,
     * bytes elsewhere" is a real state and every caller that opens an attachment
     * has to ask the same question of it. The answer is null, not a failed load,
     * and `blobOf` is the only place that decides.
     */
    blobOf,

    // ------------------------------------------------------------ read side

    async list(noteId) {
        const item = await laterService.get(noteId);
        return attachmentList(item);
    },

    /** Every attachment on the device, for the storage screen. */
    async byteUsage() {
        return withTx(["noteMedia"], "readonly", async r => {
            const rows = await media(r).getAll();
            return rows.reduce((sum, row) => sum + (row.blob?.size ?? 0), 0);
        });
    },

    // ----------------------------------------------------------- write side

    /**
     * Add one attachment: the bytes into the local store, then the description
     * onto the note.
     *
     * Two transactions, in this order, and the order is the whole design. The
     * bytes go first so a failure can only ever leave a blob that no record
     * mentions — invisible, and swept by the next `commit` — rather than a
     * description pointing at bytes that were never written, which is what the
     * user would see as a broken attachment they cannot remove.
     *
     * `input` is `{ kind, name, type, durationMs, width, height, blob }`. The
     * size is taken from the Blob rather than believed: a declared size that
     * disagrees with the bytes is how a per-file ceiling gets bypassed.
     */
    async add(noteId, input) {
        const blob = input?.blob;
        if (!(blob instanceof Blob) || !blob.size) {
            throw new ValidationError("attachments", "attachment_empty");
        }
        const at = now();
        const id = crypto.randomUUID();
        // The size comes from the blob, not from the caller: a declared size that
        // disagrees with the bytes is how a per-file ceiling gets bypassed, and
        // the share flow is a caller that has no reason to compute it correctly.
        const entry = { ...input, blob, size: blob.size, id, createdAt: at };
        return (await this.commit(noteId, [
            ...attachmentList(await laterService.get(noteId)),
            entry
        ])).find(x => x.id === id) ?? entry;
    },

    /**
     * Apply a whole staged list to a note: the note form's submit handler.
     *
     * `staged` is the form's list — every entry a description, and a Blob on the
     * entries whose bytes are on this device. An entry MUST carry the `id` it
     * was staged under: that id is the key the record describes the attachment
     * by, the key the bytes are stored under, and the key a thumbnail is
     * rendered and removed by, so a list that invented one here would be a list
     * the UI could not remove from. It is generated where the entry is created
     * (ui/components/attachments.js), and a caller that has not got one is a
     * caller with a bug, so it is refused rather than quietly fixed.
     *
     * Three things happen, in this order and for these reasons:
     *
     *  1. The DESCRIPTORS are validated first, before a single byte is written.
     *     A pick that breaks a ceiling is refused while the form is still open
     *     with the message next to the field, rather than after half the
     *     photographs are already on disk.
     *  2. The blobs are written, before the record that describes them. The
     *     invariant is that a description never points at bytes that are not
     *     there, because the other way round is an attachment the user can see
     *     and cannot open.
     *  3. Any row for an id the note no longer describes is deleted. That is the
     *     removal path, and it also collects the debris of a write that failed
     *     between steps 2 and 3 — including a blob belonging to an attachment
     *     that arrived from another device and is being re-saved here.
     *
     * AND WHAT IT MUST NOT DO, which is step 3 taken too far: delete bytes for an
     * attachment the RECORD still lists. That is not a cleanup, it is the
     * photograph being destroyed while the note goes on saying it is there — the
     * state the user sees as "the file stayed on the device it was added from",
     * which is a sentence with no way to undo it from the screen it appears on.
     * The form cannot cause it any more (it submits the section's own list, which
     * starts from the record), and this is the assertion that it never will.
     */
    async commit(noteId, staged) {
        const list = Array.isArray(staged) ? staged : [];
        // The size is MEASURED here, from the Blob, rather than taken from what
        // the caller said — and this is the one place that does it, for every
        // caller: the form's staging list, the share flow, and `add`. A declared
        // size that disagrees with the bytes is how a per-file ceiling gets
        // bypassed, and a rule that is re-implemented per caller is a rule one of
        // them will forget.
        const sized = list.map(x => (x.blob instanceof Blob && x.blob.size
            ? { ...x, size: x.blob.size }
            : x));
        // The staged entries carry a Blob, which is not a field a description
        // has; everything the record stores is checked here, once, by the same
        // validator that checks a record arriving from sync — and it runs BEFORE
        // any byte is written, so a pick that breaks a ceiling is refused with
        // the form still open.
        const descriptors = validateAttachments(sized);
        const blobs = new Map(
            sized.filter(x => x.blob instanceof Blob && x.blob.size > 0)
                .map(x => [x.id, x.blob])
        );

        // The note has to exist. A commit for a note that was deleted on another
        // device while this form was open is a write into the void, and saying
        // so is better than storing bytes nothing will ever point at.
        await laterService.get(noteId);

        await withTx(["noteMedia"], "readwrite", async r => {
            for (const [id, blob] of blobs) await media(r).put({ id, noteId, blob });
            const keep = new Set(descriptors.map(x => x.id));
            for (const row of await media(r).byNote(noteId)) {
                if (!keep.has(row.id)) await media(r).delete(row.id);
            }
        });

        const updated = await laterService.update(noteId, { attachments: descriptors });
        notify();
        return attachmentList(updated);
    },

    /**
     * What the note claims, against what the device actually holds.
     *
     * Used by the sweep and by anything that needs to say whether a set of
     * attachments can be opened. A note whose bytes are missing is a real and
     * permanent state — the bytes were never synced — but it must never be
     * produced by a write, and this is how a caller checks that rather than
     * discovering it from a thumbnail that will not load.
     */
    async missingBytes(noteId) {
        const item = await laterService.get(noteId);
        const described = attachmentList(item);
        if (!described.length) return [];
        const rows = await withTx(["noteMedia"], "readonly", r => media(r).getAll());
        const held = new Set(rows.filter(x => x.noteId === noteId).map(x => x.id));
        return described.filter(x => !held.has(x.id)).map(x => x.id);
    },

    /**
     * Remove one attachment.
     *
     * A convenience over `commit` for the callers that are not a form — the
     * share flow, and anything that answers a single "remove this" row. The
     * bytes go in the same transaction as the record, because a delete that
     * needed two transactions would have the same window a create did.
     */
    async remove(noteId, attachmentId) {
        const item = await laterService.get(noteId);
        const current = attachmentList(item);
        if (!current.some(x => x.id === attachmentId)) {
            throw new NotFoundError("attachment", attachmentId);
        }
        await laterService.update(noteId, {
            attachments: current.filter(x => x.id !== attachmentId)
        });
        await withTx(["noteMedia"], "readwrite", r => media(r).delete(attachmentId));
        notify();
        return current.filter(x => x.id !== attachmentId);
    },

    /**
     * Delete every blob the records do not describe.
     *
     * A row is stale in exactly two ways, and both happen without anybody
     * calling a delete: a note deleted on ANOTHER device arrives as a record
     * whose attachments are already gone from it, so the ids that pointed at
     * those bytes are gone too; and a `commit` interrupted between writing the
     * bytes and writing the record leaves bytes no record mentions. Neither is
     * visible in the app — the UI reads descriptions from the record — so the
     * only symptom is storage that never comes back.
     *
     * So it is swept, on startup and after every applied pull, and it decides
     * staleness by asking the RECORDS rather than by tracking anything: a row is
     * kept only when the note it names still exists and still lists its id.
     * There is no tally to fall out of step with the records.
     */
    async sweep() {
        const stale = await withTx(["later", "noteMedia"], "readonly", async r => {
            const described = new Map(
                (await later(r).getAll()).map(item => [
                    item.id,
                    new Set(attachmentList(item).map(x => x.id))
                ])
            );
            const rows = await media(r).getAll();
            return rows.filter(row => !described.get(row.noteId)?.has(row.id));
        });
        if (!stale.length) return 0;
        await withTx(["noteMedia"], "readwrite", async r => {
            for (const row of stale) await media(r).delete(row.id);
        });
        return stale.length;
    },

    /** Delete every blob on the device. The answer to "free up space" in settings. */
    async clearAll() {
        const bytes = await this.byteUsage();
        await withTx(["noteMedia"], "readwrite", r => media(r).clear());
        notify();
        return bytes;
    }
};
