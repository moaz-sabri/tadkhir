// What can be attached to a note, and how much of it.
//
// Pure module: no I/O, no browser API, no throws. It answers four questions and
// nothing else — what a file IS, how big it is allowed to be, how long a
// recording is allowed to run, and what the note is left holding. The rules that
// REJECT a file throw a ValidationError and live in domain/validation.js, on the
// same terms as every other rule in the app: this module decides, validation
// refuses.
//
// The split matters because these limits are quoted in three places that must
// agree — the recorder that stops itself, the form that greys out a button, and
// the service that refuses a write — and a limit written down twice is a limit
// that is eventually wrong in one of them.
//
// ---------------------------------------------------------------------------
// The shape of the compromise
// ---------------------------------------------------------------------------
//
// The BYTES of an attachment live on the device that captured them and nowhere
// else. They are not synced, not backed up, and not uploaded, and that is a
// decision rather than a gap:
//
//   * The sync API is a JSON API with a 1 MiB request ceiling and an
//     encrypt-then-base64 envelope, which inflates every payload by a third. A
//     five-megabyte video is therefore a ~7 MB push — over the ceiling by seven
//     times — and the honest fix for that is a binary upload endpoint, a second
//     storage table, its own quota, its own garbage collector and a
//     resumable-upload story for a phone on a train. That is a different
//     feature, and building it badly is worse than not building it.
//   * An attachment the user can see but never open is worse than one they
//     cannot see at all, so a record that ARRIVES on another device says what
//     the note carries and nothing more.
//
// What does travel is the DESCRIPTION — kind, name, size, duration, dimensions —
// as an array on the note record itself. It is a few hundred bytes, it is
// ordinary JSON, and it makes the missing bytes legible instead of mysterious:
// the other device shows "3 photos" and a "not on this device" state, rather
// than a note that looks empty.

// The four kinds. A photo is a still image, a video moves, an audio has no
// picture at all, and a document is anything the user means to read rather than
// watch. They are not a taxonomy of file formats — `kindForFile` decides which
// of the four a MIME type belongs to, and a file it cannot place is refused
// rather than filed under the nearest.
export const ATTACHMENT_KINDS = ["photo", "audio", "video", "document"];

// ---- Per-kind ceilings -----------------------------------------------------

// Photos are the only kind with a COUNT limit rather than a size one, and the
// reason is that they are the only kind cheap to add several of: a second photo
// costs one tap, and a note with thirty of them is a gallery, not a note. Five
// is enough to photograph a document, a whiteboard and a receipt.
export const MAX_PHOTOS_PER_NOTE = 5;

// A recording is a sentence, not a meeting. Five seconds is long enough to stop
// a sentence from being cut off at the front, and thirty minutes is long enough
// for anything anyone records with a phone held up like a dictaphone.
export const MIN_AUDIO_MS = 5000;
export const MAX_AUDIO_MS = 30 * 60 * 1000;

// Video is the strictest kind in the app, on both axes at once, and the two
// limits are not independent: 30 seconds at any sane bitrate is 1–3 MB, so the
// byte ceiling is the one that actually stops a recording, and the duration
// ceiling is what stops the recorder from running for thirty minutes producing a
// file the byte ceiling would have rejected at twenty. Both are enforced while
// recording — see app/js/app/capture.js.
export const MAX_VIDEO_MS = 30000;
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;

// A document is a file to read, not a file to keep. 3 MiB is a long PDF and a
// short spreadsheet; it is also small enough that a dozen of them still fit in
// a note a phone will happily hold.
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;

// A photo is downscaled on the way in (see app/js/app/capture.js), so this is
// the ceiling on what ARRIVES rather than on what is kept: 12 MiB is a 48-megapixel
// original and refusing one would be refusing the phone's own camera.
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
// …and this is the ceiling on what is kept, which the downscale is what holds
// under. A 1600px JPEG at q0.82 lands around 200–400 KB.
export const MAX_PHOTO_KEPT_BYTES = 2 * 1024 * 1024;

// Audio is the one kind with no byte ceiling in this module, and that is
// deliberate: the user named a duration and not a size, and at a voice bitrate
// thirty minutes is a few megabytes. `MAX_MEDIA_BYTES` below is the only thing
// bounding it, together with the device's own storage.
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// The downscale target: the long edge, in pixels. 1600 is the largest size that
// is still sharp when a photo is read on a phone and small enough to keep five
// of them in a note. Beyond it the bytes buy nothing anyone can see.
export const PHOTO_LONG_EDGE = 1600;
export const PHOTO_QUALITY = 0.82;

// ---- Whole-note ceilings ---------------------------------------------------

// One store of attachments, and one bound on it: enough for a generous note and
// small enough that a single write cannot be a hundred megabytes of blob.
export const MAX_ATTACHMENTS_PER_NOTE = 20;
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;

// A file name is shown on a row and a viewer, never interpreted. Bounded because
// it is user-controlled text that would otherwise be the one field in a record
// with no limit at all — a 4 KB "name" from a hostile device is 4 KB in every
// list that renders it.
export const MAX_ATTACHMENT_NAME = 120;

// The bitrate a recording is asked for. MediaRecorder treats this as a hint, but
// on the two engines this app actually runs on it is honoured closely enough that
// the video byte ceiling is the thing that ends a recording, which is what makes
// the 30-second promise real on a slow phone.
export const AUDIO_BITRATE = 64000;
export const VIDEO_BITRATE = 1200000;

// The accept strings, per kind, for the file inputs. `capture` is deliberately
// absent from the photo input: adding it would open the camera on Android and
// leave the user with no way to reach the gallery, and a phone's camera roll is
// where a photo they want to attach usually already is.
const DOCUMENTS = Object.freeze([
    ".pdf", ".txt", ".md", ".csv", ".json", ".rtf", ".epub",
    ".doc", ".docx", ".odt",
    ".xls", ".xlsx", ".ods",
    ".ppt", ".pptx", ".odp"
]);

export const ACCEPT = Object.freeze({
    photo: "image/*",
    audio: "audio/*",
    video: "video/*",
    // The document list, as an accept string, for a picker that should offer
    // documents and nothing else.
    document: DOCUMENTS.join(","),
    // Everything a note can hold in one list, for the one "attach a file" button:
    // the documents, plus the three media wildcards so a clip already in the
    // phone's storage is one tap away. What is chosen is classified per file by
    // `kindForFile`, so a wide accept list widens nothing — it only widens what
    // the picker shows. Built from the other three rather than written out again,
    // because a second copy of this list is a second answer to "what can a note
    // hold", and the two would eventually disagree.
    any: Object.freeze(["image/*", "audio/*", "video/*", ...DOCUMENTS].join(","))
});

// Which extensions count as a document. A CLOSED list, and that is the whole
// policy: an attachment a browser could be made to EXECUTE in this origin is a
// stored XSS, and the way to not have one is a list of things that are documents
// rather than a list of things that are not scripts. The server applies the same
// list to a shared file, so the two cannot disagree about what a document is.
export const DOCUMENT_EXTENSIONS = Object.freeze([
    "pdf", "txt", "md", "csv", "json", "rtf", "epub",
    "doc", "docx", "odt",
    "xls", "xlsx", "ods",
    "ppt", "pptx", "odp"
]);

// The MIME types a document may arrive as, for the same reason. Note the absence
// of anything html-ish: `text/html` and `image/svg+xml` are the two types that
// would execute, and an SVG cannot be a document here.
export const DOCUMENT_TYPES = Object.freeze([
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/rtf",
    "application/epub+zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.presentation"
]);

// ---------------------------------------------------------------------------
// Naming and typing
// ---------------------------------------------------------------------------

// The extension, lowercased, without the dot. "" when there is none — a file
// called "LICENSE" or a phone photo called "IMG_20260101" both land here.
export function extensionOf(name) {
    const clean = String(name ?? "").trim();
    const at = clean.lastIndexOf(".");
    if (at < 1 || at === clean.length - 1) return "";
    return clean.slice(at + 1).toLowerCase();
}

// The base name to show. A phone's camera names files "IMG_0001.jpg" and its
// screen recorders name them "Screen Recording 2026-01-01 at 10.15.03.mp4",
// which is 44 characters of state the user did not choose; the extension and
// the counter are all that carry information once the kind is already known.
export function displayName(name, kind) {
    const clean = String(name ?? "").trim();
    if (!clean) return defaultName(kind);
    if (clean.length <= MAX_ATTACHMENT_NAME) return clean;
    // Cut the stem, not the tail: the extension is what tells two same-named
    // files apart at the end of a truncated row.
    const ext = extensionOf(clean);
    const stem = ext ? clean.slice(0, clean.length - ext.length - 1) : clean;
    const room = MAX_ATTACHMENT_NAME - (ext ? ext.length + 1 : 0);
    return `${stem.slice(0, Math.max(1, room))}${ext ? `.${ext}` : ""}`;
}

const DEFAULT_NAMES = Object.freeze({
    photo: "Photo",
    audio: "Recording",
    video: "Video",
    document: "Document"
});

// What a file with no usable name is called in the UI. The caller supplies the
// translated string; this is only the key to look up.
export function defaultName(kind) {
    return DEFAULT_NAMES[kind] ?? "Attachment";
}

// The types that are inside a broad allowlist above and still must never be
// stored. SVG is an image by MIME and a script by everything that matters: it can
// carry <script> and an onload handler, and a browser asked to render one in this
// origin would run it. So `image/svg+xml` is not a photograph here however much
// it looks like one.
//
// The server applies the same list to a shared file (TT_SHARE_REFUSED_TYPES in
// api/share-intake.php), because the alternative is an endpoint that accepts a
// file this one would refuse, and a share that lands in a directory the app then
// rejects on the way in.
export const REFUSED_TYPES = Object.freeze([
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/xml"
]);

// The same list, by extension: a file whose type says image/png and whose name
// ends in .svg is a file the sender chose to be ambiguous, and a closed list has
// no room for that.
export const REFUSED_EXTENSIONS = Object.freeze(["svg", "svgz", "html", "htm", "xhtml", "xml"]);

// Which of the four kinds a file is, or null when it is none of them.
//
// The refusals come FIRST, before the media prefixes, and that ordering is the
// point: a prefix rule that is checked after nothing is a rule an SVG walks
// straight through.
export function kindForFile(file) {
    const type = String(file?.type ?? "").split(";")[0].trim().toLowerCase();
    const ext = extensionOf(file?.name);
    if (REFUSED_TYPES.includes(type) || REFUSED_EXTENSIONS.includes(ext)) return null;
    if (type.startsWith("image/")) return "photo";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (DOCUMENT_TYPES.includes(type) || DOCUMENT_EXTENSIONS.includes(ext)) return "document";
    return null;
}

// ---------------------------------------------------------------------------
// The ceilings, as one lookup
// ---------------------------------------------------------------------------

/**
 * The bytes one kind will accept, or null where a kind has no per-file ceiling.
 *
 * A lookup rather than a table, because only three of the four kinds have a
 * number and the fourth — audio — was given a length rather than a size. Audio's
 * bound is MAX_MEDIA_BYTES for the whole note, and saying `null` here is what
 * stops a caller inventing a number for it.
 */
export function byteCeilingFor(kind) {
    if (kind === "photo") return MAX_PHOTO_BYTES;
    if (kind === "video") return MAX_VIDEO_BYTES;
    if (kind === "document") return MAX_DOCUMENT_BYTES;
    return null;
}

// ---------------------------------------------------------------------------
// What a note is left holding
// ---------------------------------------------------------------------------

// The attachments of one note, in the order they were added, with the blobs
// pulled off.
//
// THE ORDER IS NOT STORED. It is the order of `createdAt` with the id as the
// tie-breaker, exactly like a Later list (see domain/later.js: newestFirst) and
// for the same reason: a local array order is never trusted across devices, and
// two devices that added two photos in the same millisecond must still agree on
// which is first.
const oldestFirst = (a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id);

/**
 * The attachment descriptions of a note, sorted, with `blob` dropped.
 *
 * This is what a Later record carries and what a backup writes: the same
 * function, so there is no second shape to keep in step. A note with no
 * `attachments` field — every record written before this feature existed — reads
 * as an empty list rather than an error, which is the only way an additive
 * field can be additive.
 */
export function attachmentList(item) {
    const list = Array.isArray(item?.attachments) ? item.attachments.filter(isDescriptor) : [];
    return list.slice().sort(oldestFirst).map(({ blob, ...descriptor }) => descriptor);
}

/** True when this value is a usable attachment description. */
export function isDescriptor(x) {
    return !!x
        && typeof x === "object"
        && typeof x.id === "string" && !!x.id
        && ATTACHMENT_KINDS.includes(x.kind)
        && typeof x.name === "string"
        && Number.isInteger(x.size) && x.size >= 0;
}

// How many more of one kind a note can take. Zero is what greys the button out.
export function roomFor(attachments, kind) {
    const list = Array.isArray(attachments) ? attachments : [];
    if (kind === "photo") {
        return Math.max(0, MAX_PHOTOS_PER_NOTE - list.filter(x => x?.kind === "photo").length);
    }
    return Math.max(0, MAX_ATTACHMENTS_PER_NOTE - list.length);
}

// The bytes a note is already carrying, which is what MAX_MEDIA_BYTES bounds.
// The descriptors store their own size, so this never has to read a blob.
export function bytesOf(attachments) {
    return (Array.isArray(attachments) ? attachments : [])
        .reduce((sum, x) => sum + (Number.isInteger(x?.size) ? x.size : 0), 0);
}

/** The count of one kind on a note. */
export function countOf(attachments, kind) {
    const list = Array.isArray(attachments) ? attachments : [];
    return list.filter(x => x?.kind === kind).length;
}

/**
 * What a note carries, as a count per kind that is actually present.
 *
 * Counts and kind NAMES, never a rendered phrase: a module that produced
 * English would have to be duplicated for Arabic, and the app has that
 * duplication nowhere else. The caller turns `[{ kind: "photo", count: 3 }]`
 * into words.
 */
export function summarise(attachments) {
    const list = attachmentList({ attachments });
    return ATTACHMENT_KINDS
        .map(kind => ({ kind, count: list.filter(x => x.kind === kind).length }))
        .filter(x => x.count > 0);
}

// ---------------------------------------------------------------------------
// What a capture produces
// ---------------------------------------------------------------------------

// A fresh description, minus the fields that depend on the recording that has
// not happened yet. `id` is the same uuid the blob is stored under, so the
// description and the bytes are found by one key and there is no second
// identifier that could disagree with the first.
export function newDescriptor(input, { id, now }) {
    return {
        id,
        kind: input.kind,
        name: input.name,
        type: input.type,
        size: input.size,
        // Only audio and video have a duration, and it is a duration the app
        // measured rather than one the file claimed.
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        createdAt: now
    };
}
