import {
    MAX_MEDIA_BYTES,
    PHOTO_LONG_EDGE,
    PHOTO_QUALITY,
    byteCeilingFor,
    kindForFile
} from "../domain/attachments.js";
import { probeMedia, probeImage, shrinkPhoto } from "../app/capture.js";

// The client half of the Web Share Target.
//
// The manifest posts a shared file to /api/share/intake, which parks it for ten
// minutes and answers with a 303 to /share?t=<token>. This module fetches it
// back, so the bytes end up where everything else in the app keeps its bytes —
// IndexedDB, on this device — and the server keeps nothing at all.
//
// The token, not a cookie, is the authorisation, and that is the one thing worth
// understanding about this design: a share can arrive before the app has ever
// been opened on this device, so there is no session to check. The token is 128
// random bits, good for ten minutes, unreadable to anyone who does not have the
// URL, and it is never written into a link the app renders.

const INTAKE = "/api/share/intake";



/** The code to show for whatever the request came back with. */
function codeFor(status) {
    if (status === 404 || status === 410) return "share_intake_expired";
    if (status === 413) return "share_intake_too_large";
    if (status === 415) return "share_intake_unavailable";
    return "network";
}

/**
 * What was shared: the text, and the files as ready-to-store Blobs.
 *
 * Returns null when the token is not there any more — a share that expired while
 * the chooser sat open is not an error, it is a share that is simply gone, and
 * the caller shows the ordinary "nothing shared" screen rather than a failure.
 *
 * A file the app cannot take is DROPPED, with a note of how many were dropped.
 * The alternative — refusing the whole share because one item in it is an
 * executable — loses a photograph the user wanted because an .html was in the
 * same selection, which is the wrong trade in both directions.
 */
export async function readSharedShare(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) return null;

    let meta;
    try {
        const res = await fetch(`${INTAKE}?t=${encodeURIComponent(token)}`, {
            credentials: "omit",
            cache: "no-store"
        });
        if (!res.ok) {
            const error = new Error("intake");
            error.code = codeFor(res.status);
            throw error;
        }
        meta = await res.json();
    } catch (e) {
        // A network failure and an expired token are told apart by the status
        // above; anything reaching here with no code is offline, and offline is
        // not a reason to refuse a share the user just made.
        if (e?.code) throw e;
        const error = new Error("offline");
        error.code = "offline";
        throw error;
    }

    const files = [];
    let dropped = 0;
    for (const file of meta.files ?? []) {
        const kind = kindForFile({ type: file.type, name: file.name }) ?? file.kind;
        if (!kind) {
            dropped++;
            continue;
        }
        // Checked on the size the server reported, before the bytes are fetched:
        // there is no point pulling four megabytes off the wire to discover the
        // app is not going to keep them. `byteCeilingFor` is the same function
        // the attachment picker asks, so a share and a pick cannot disagree about
        // what a note can hold.
        const ceiling = byteCeilingFor(kind);
        if (ceiling && Number(file.size) > ceiling) {
            dropped++;
            continue;
        }
        try {
            const res = await fetch(file.url, { credentials: "omit", cache: "no-store" });
            if (!res.ok) {
                dropped++;
                continue;
            }
            const raw = await res.blob();
            // The endpoint deliberately answers `application/octet-stream`, so
            // the Blob comes back untyped and the kind the app is about to store
            // it as has to be put back on here.
            let blob = file.type ? new Blob([raw], { type: file.type }) : raw;
            let width = null;
            let height = null;
            let durationMs = null;
            if (kind === "photo") {
                // Downscored exactly as a picked photograph is, and measured with
                // the image decoder rather than the video one: a shared photo
                // arrives as `image/*` and probeMedia would answer nulls for it,
                // leaving every shared picture with no dimensions at all.
                blob = await shrinkPhoto(blob, { longEdge: PHOTO_LONG_EDGE, quality: PHOTO_QUALITY });
                const shot = await probeImage(blob);
                width = shot.width;
                height = shot.height;
            } else {
                const probe = await probeMedia(blob);
                durationMs = probe.durationMs;
                width = probe.width;
                height = probe.height;
            }
            files.push({
                kind,
                name: file.name,
                type: file.type || blob.type || null,
                size: blob.size,
                durationMs,
                width,
                height,
                blob
            });
        } catch {
            dropped++;
        }
    }

    // The same ceiling the note form enforces, applied here so a share cannot
    // stage more than one note ever could.
    let kept = files;
    let bytes = kept.reduce((sum, f) => sum + f.size, 0);
    if (bytes > MAX_MEDIA_BYTES) {
        kept = [];
        for (const file of files) {
            if (bytes + file.size > MAX_MEDIA_BYTES) {
                dropped++;
                continue;
            }
            kept.push(file);
            bytes += file.size;
        }
    }

    return {
        title: meta.title ?? "",
        text: meta.text ?? "",
        url: meta.url ?? "",
        files: kept,
        // Everything the endpoint itself refused, plus what this module dropped.
        dropped: dropped + (Number(meta.skipped) || 0)
    };
}

/**
 * Tell the server the share is dealt with.
 *
 * Best-effort and never awaited by the caller: the bytes are already in the
 * note by this point, and a parked share that is never deleted expires on its
 * own in ten minutes. A "release" that fails must not turn a saved note into an
 * error message.
 */
export function releaseSharedShare(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) return;
    try {
        fetch(`${INTAKE}?t=${encodeURIComponent(token)}`, {
            method: "DELETE",
            credentials: "omit",
            cache: "no-store",
            keepalive: true
        }).catch(() => { /* expires on its own */ });
    } catch {
        // A navigator without fetch, or a CSP that will not allow it. Same
        // outcome: the directory is swept.
    }
}
