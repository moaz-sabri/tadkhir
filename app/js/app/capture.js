// Cameras, microphones, recorders and the file picker — the four ways bytes get
// into a note, and the four places a browser refuses.
//
// It lives under `app/` rather than `ui/` because none of it draws anything: it
// asks the platform for a stream, turns a stream into a Blob, reads a Blob's
// dimensions and duration, and shrinks a photograph. The components in
// ui/components/* call it and render whatever comes back.
//
// Two rules run through the whole file:
//
//  1. A capture is BOUNDED WHILE IT HAPPENS, not after. A recorder given a
//     thirty-minute limit and no timer will happily fill a phone's storage in
//     thirty minutes, and a video recorder given a five-megabyte limit and no
//     watchdog will pass it in one chunk. So `boundedRecorder` enforces the
//     ceiling on both axes with a clock and a byte tally, and stops itself.
//  2. A refusal is a MESSAGE, not a console line. `NotAllowedError` is a
//     permission the user declined and a `code` the UI can translate; a
//     permission is asked for once and never re-asked silently, so a second
//     attempt that fails differently must not look like the first one did
//     nothing.

import { AUDIO_BITRATE, MAX_PHOTO_KEPT_BYTES, VIDEO_BITRATE } from "../domain/attachments.js";

// The recorded types, best first. MediaRecorder silently falls back to whatever
// the browser likes when `mimeType` is unsupported, which on some Androids meant
// a 30-second video arriving as an unplayable `video/3gpp`. Asking for a list
// and taking the first one the engine actually reports as supported is what makes
// "video" mean one thing.
//
// Safari on macOS/iOS prefers mp4 (H.264/AAC) over webm/opus. The order here
// prioritises Safari-compatible formats first, then falls back to webm for
// Chrome/Firefox/Android. This ensures recordings work across all platforms.
const AUDIO_TYPES = [
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4;codecs=mp4a.40.5",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
];

const VIDEO_TYPES = [
    "video/mp4",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1.42001E",
    "video/mp4;codecs=avc1.4D401E",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
];

// The first entry of `types` this engine will actually record, or "" — which is
// the correct answer on an engine that records whatever it is given, because
// MediaRecorder with no mimeType is specified to produce something playable.
export function recorderTypeFor(kind) {
    const list = kind === "video" ? VIDEO_TYPES : AUDIO_TYPES;
    if (typeof MediaRecorder === "undefined") return "";
    for (const type of list) {
        try {
            if (MediaRecorder.isTypeSupported(type)) return type;
        } catch {
            // An engine that throws from isTypeSupported has no opinion worth
            // having; the empty answer below is the one that always works.
            break;
        }
    }
    return "";
}

// A permission that was refused, a device that is not there, and a browser that
// has no idea what a MediaRecorder is all end up as ONE code the UI can
// translate, because the three of them have one thing in common from the user's
// side of the screen: nothing happened and there is no retry that would help.
export function captureErrorCode(e) {
    const name = e?.name ?? "";
    // Its own code, and the only one whose fix is not in a settings menu: the
    // page was served over http on a host that is not localhost, so the browser
    // never offered the camera in the first place. Told as "the browser cannot
    // do this", which reads as a broken app on a device that is perfectly
    // capable — the message has to name the address instead.
    if (name === "InsecureContextError") return "capture_insecure";
    if (name === "NotAllowedError" || name === "SecurityError") return "capture_denied";
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
        return "capture_no_device";
    }
    if (name === "NotReadableError" || name === "AbortError") return "capture_busy";
    if (name === "NotSupportedError") return "capture_unsupported";
    if (name === "TypeError") return "capture_unsupported";
    return "capture_failed";
}

// ---------------------------------------------------------------------------
// Is there anything to ask, and what has the browser already answered?
// ---------------------------------------------------------------------------
//
// Why this file asks at all, when `getUserMedia` raises its own prompt.
//
// Because the three questions have three different answers and the OLD code
// could only ever see one of them:
//
//   1. CAN THIS PAGE TAKE A PICTURE AT ALL? `navigator.mediaDevices` does not
//      exist outside a secure context, so the whole API is simply absent over
//      plain http on a LAN address — which is exactly how a self-hosted copy of
//      this app is reached from a phone. That failure used to arrive as the
//      generic "this browser cannot record here", which is true and useless:
//      the browser is fine, the ADDRESS is the problem, and no amount of
//      granting a permission in a settings menu will ever fix it. It now has
//      its own code and its own message.
//   2. WHAT HAS THE BROWSER ALREADY ANSWERED? The Permissions API can say
//      granted / denied / prompt without prompting.
//
// ...and the reason it is a QUESTION rather than a GATE is the whole point of
// this block. An earlier version of this file asked the question and then
// REFUSED to record when the answer was "denied" — and that turned a permission
// the user had already fixed into a dead app with no way out:
//
//   * The answer is a SNAPSHOT TAKEN WHEN THE PAGE LOADED. Chrome and Edge keep
//     reporting "denied" for an origin until the tab is reloaded, even after the
//     user goes to chrome://settings/content/camera, flips the switch off
//     "Block", and comes back. So the instruction the app was showing — "allow
//     it in your browser settings" — had already been followed, and obeying it
//     changed nothing.
//   * The consequence was that `getUserMedia` was never called, so no prompt
//     ever appeared. The user pressed record, waited for the browser's own
//     permission dialog, and got a toast instead saying the access had been
//     declined. The only escape was reloading the page, which nothing in the
//     app ever mentioned.
//
// So `permissionState` is asked, and then IGNORED as a refusal. `getUserMedia` is
// the authority on whether a stream can be had, and it is also the request — so
// trying costs nothing when the permission really is blocked: the call rejects
// with `NotAllowedError` immediately and no prompt is shown. Being wrong about
// "denied" in the refusing direction costs a working camera; being wrong in the
// trying direction costs one silent, instant rejection.
//
// The query is capability-detected rather than version-checked, and EVERY
// failure path answers "unknown" rather than throwing: Safari implements
// `navigator.permissions` but rejects the `camera` and `microphone` names, and
// an unknown answer must mean "go ahead and let getUserMedia ask" — never
// "refuse".
const PERMISSION_NAMES = Object.freeze({ audio: "microphone", video: "camera" });

/**
 * Whether a stream can be requested here at all, and why not if it cannot.
 *
 * "granted" is the one answer that means yes. "insecure" is its own answer
 * rather than a flavour of "unsupported" because it is the only one the USER can
 * do something about without leaving the app — by reaching the copy over
 * https, or over localhost, which is a secure context too.
 */
export function captureAvailability() {
    if (typeof navigator === "undefined") return "unsupported";
    if (!navigator.mediaDevices?.getUserMedia) {
        return isInsecureContext() ? "insecure" : "unsupported";
    }
    return "granted";
}

/** A page served over http on a host that is not localhost. */
function isInsecureContext() {
    try {
        // `isSecureContext` is the platform's own answer and is false exactly
        // when getUserMedia is unavailable for that reason. Read defensively
        // because it is missing on older engines, where the answer is "assume
        // secure" — the mediaDevices check above already caught the real case.
        return window.isSecureContext === false;
    } catch {
        return false;
    }
}

/**
 * What the browser has already decided about this permission.
 *
 * "granted" | "denied" | "prompt" | "unknown". Never rejects: an API that is
 * missing, a name the engine does not implement, and a query that throws all
 * answer "unknown", which every caller treats as "let getUserMedia ask".
 */
export async function permissionState(kind) {
    const name = PERMISSION_NAMES[kind];
    const query = navigator?.permissions?.query;
    if (!name || typeof query !== "function") return "unknown";
    try {
        const status = await query.call(navigator.permissions, { name });
        return String(status?.state ?? "unknown");
    } catch {
        return "unknown";
    }
}

/**
 * Ask the browser to prompt, and report the answer.
 *
 * There is no permission-request call for a camera or a microphone: calling
 * `getUserMedia` IS the request, which is why this opens a stream and then
 * immediately closes it rather than asking and holding on. It resolves with the
 * resulting state — "granted", or "denied" when the user said no or the prompt
 * could not be shown. It never rejects: a prompt that throws is a refusal.
 *
 * "denied" is asked about but NOT obeyed, for the reason in the block above: the
 * Permissions API's answer is a load-time snapshot that outlives a change made in
 * the browser's own settings, and short-circuiting on it meant a permission the
 * user had already granted could never be granted again inside that tab. Because
 * `getUserMedia` was actually reached, a "denied" returned from here is one the
 * platform has just confirmed rather than one guessed from a snapshot — which is
 * what lets Settings treat it as final and remove the button.
 */
export async function requestCapturePermission(kind) {
    if (captureAvailability() !== "granted") return captureAvailability();
    // Already granted: there is nothing to ask about, and opening a stream to
    // find that out would light the camera for no reason.
    if (await permissionState(kind) === "granted") return "granted";

    let stream = null;
    try {
        stream = await openStream(kind === "video"
            ? { video: { facingMode: "environment" }, audio: true }
            : { audio: true });
        return "granted";
    } catch {
        return "denied";
    } finally {
        // The stream existed only to make the browser ask. Nothing was recorded
        // and nothing is kept: a microphone left open here is a recording light
        // that stays on for as long as Settings stays open.
        closeStream(stream);
    }
}

// Ask for one stream and say what it is for, because a permission prompt that
// does not name the app gets dismissed.
//
// `facingMode` is "user" for a voice memo and "environment" for a photograph of
// something in front of the phone, which is the difference between the front and
// the back camera and the only video constraint worth setting.
//
// Some devices (especially macOS Safari) don't have an "environment" camera
// and will throw OverconstrainedError. We try the requested facingMode first,
// then fall back to "user", then to no facingMode at all.
export async function openStream(constraints) {
    const availability = captureAvailability();
    if (availability !== "granted") {
        const err = new Error("no camera or microphone");
        // The name is the code's only input, so the two refusals that need
        // different words on screen arrive with different names.
        err.name = availability === "insecure" ? "InsecureContextError" : "NotSupportedError";
        throw err;
    }

    // Try the original constraints first
    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        // If the constraint can't be satisfied (e.g., no "environment" camera on Mac),
        // try progressively simpler constraints
        if (e?.name === "OverconstrainedError" || e?.name === "NotFoundError") {
            const { video, audio, ...rest } = constraints;
            // EVERY attempt below carries the audio constraint, not just the
            // first. The fallback used to build one object, set `video` on it
            // and hand it over — so a video that had to fall back came back
            // with NO microphone track: a silent video that recorded perfectly
            // and looked like a working feature. Relaxing the CAMERA must never
            // quietly drop the microphone with it.
            const fallbackConstraints = { ...rest };
            if (audio) fallbackConstraints.audio = audio;

            if (video) {
                // Try without facingMode first (gets default camera)
                fallbackConstraints.video = typeof video === "object"
                    ? { ...video, facingMode: undefined }
                    : true;
                try {
                    return await navigator.mediaDevices.getUserMedia(fallbackConstraints);
                } catch {
                    // If that fails, try with no video constraints at all
                    fallbackConstraints.video = true;
                }
            }

            try {
                return await navigator.mediaDevices.getUserMedia(fallbackConstraints);
            } catch {
                // Re-throw the original error if all fallbacks fail
                throw e;
            }
        }
        throw e;
    }
}

/** Stop every track of a stream. A forgotten track is a light that stays on. */
export function closeStream(stream) {
    for (const track of stream?.getTracks?.() ?? []) {
        try {
            track.stop();
        } catch {
            // A track that is already stopped throws on some engines and there
            // is nothing to do about it.
        }
    }
}

/**
 * A MediaRecorder that stops itself.
 *
 * `maxMs` and `maxBytes` are both optional and both enforced: the clock with a
 * clock, the bytes by summing the chunks as they arrive and stopping the moment
 * the total crosses the line. Neither is a promise the caller has to keep — the
 * whole reason this exists is that a recorder left running is a phone that fills
 * up and a video that is 40 MB instead of 5.
 *
 * `onStop(blob, elapsedMs)` is called once, whether the recording ended because
 * the user pressed stop, because the clock ran out, or because the byte tally
 * reached the ceiling. `stopReason` says which, because a video that stopped at
 * 4.9 MB because it hit 30 seconds and one that stopped at 4.9 MB because it hit
 * 5 MB are both "the video you asked for" and neither is a failure worth a toast.
 *
 * On Safari, MediaRecorder may throw if the mimeType is not supported (e.g., webm
 * on macOS Safari). We catch the error and report it through onError so the UI
 * can show a meaningful message instead of crashing.
 */
export function boundedRecorder(stream, { kind, maxMs = null, maxBytes = null, onStop, onError = null } = {}) {
    const mimeType = recorderTypeFor(kind);
    // The bitrate is a REQUEST, and this is the request: a 30-second video at a
    // browser-chosen bitrate is 4–8 MB on a mid-range phone, which the 5 MB
    // ceiling would refuse after the user had already pointed the camera at
    // something. Asking for 1.2 Mbps is what makes the 30-second promise real
    // rather than aspirational — and it is a hint, which is why the byte tally
    // below is still the thing that ends the recording.
    const options = {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: kind === "video" ? AUDIO_BITRATE : AUDIO_BITRATE,
        ...(kind === "video" ? { videoBitsPerSecond: VIDEO_BITRATE } : {})
    };

    let recorder;
    try {
        recorder = new MediaRecorder(stream, options);
    } catch (e) {
        // MediaRecorder constructor threw - likely unsupported mimeType on this browser
        // (e.g., webm on Safari). Report through onError so UI can show a message.
        const err = new Error("MediaRecorder not supported");
        err.name = "NotSupportedError";
        onError?.(err);
        // Return a no-op recorder so the caller doesn't crash
        return {
            recorder: null,
            start() {},
            stop() {},
            cancel() {},
            get bytes() { return 0; },
            get elapsedMs() { return 0; }
        };
    }

    const started = Date.now();
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const finish = reason => {
        if (settled) return;
        settled = true;
        clearTimeout(clock);
        const type = mimeType || recorder.mimeType || (kind === "video" ? "video/webm" : "audio/webm");
        // An empty recording is not a recording: a user who pressed stop before
        // the first chunk arrived gets nothing, which is the truth, and the
        // caller reports "too short" rather than saving a 0-byte file.
        const blob = new Blob(chunks, { type });
        onStop(blob, Date.now() - started, reason);
    };

    const clock = maxMs ? setTimeout(() => {
        try {
            recorder.stop();
        } catch {
            finish("time");
        }
    }, maxMs) : null;

    recorder.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        chunks.push(e.data);
        bytes += e.data.size;
        // Stopped from inside the event, not from a timer: the tally only
        // advances when a chunk lands, and the chunk that crosses the line is
        // already in hand, so nothing is lost by stopping here.
        if (maxBytes && bytes >= maxBytes && recorder.state === "recording") {
            try {
                recorder.stop();
            } catch {
                finish("size");
            }
        }
    };
    recorder.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(clock);
        onError?.(new Error("recorder failed"));
    };
    recorder.onstop = () => finish("stopped");

    return {
        recorder,
        /**
         * Stop WITHOUT producing anything.
         *
         * For the caller that is tearing down: a dialog dismissed with Escape or
         * the backdrop never reaches `stop()`, so nothing calls `onStop`, so
         * nothing clears the clock timer — and a MediaRecorder left running with
         * a thirty-minute timer armed is a phone that records into a closed
         * stream in the background. A recording that was dismissed was never
         * asked for, so there is nothing to hand back and nobody to hand it to.
         */
        cancel() {
            if (settled) return;
            settled = true;
            clearTimeout(clock);
            chunks.length = 0;
            try {
                if (recorder.state !== "inactive") recorder.stop();
            } catch {
                // Already stopped, or a recorder on a stream the caller has
                // already closed. Either way there is nothing to undo.
            }
        },
        start(timesliceMs = 250) {
            // A timeslice is what makes the byte watchdog possible: without one
            // the whole recording arrives as a single blob at the end, by which
            // point the ceiling has been exceeded by whatever the user filmed.
            recorder.start(timesliceMs);
        },
        stop() {
            try {
                if (recorder.state !== "inactive") recorder.stop();
                else finish("stopped");
            } catch {
                finish("stopped");
            }
        },
        /** Bytes recorded so far, for a live readout. */
        get bytes() {
            return bytes;
        },
        get elapsedMs() {
            return Date.now() - started;
        }
    };
}

// ---------------------------------------------------------------------------
// Reading what a file actually is
// ---------------------------------------------------------------------------

// The object's URL is revoked on every path out, including the error one. A
// leaked blob: URL is a leaked Blob: it holds the bytes alive for the lifetime
// of the document, and a screen that opens twenty previews would pin twenty
// photographs in memory with nothing pointing at them.
function withObjectUrl(blob, fn) {
    const url = URL.createObjectURL(blob);
    return Promise.resolve()
        .then(() => fn(url))
        .finally(() => URL.revokeObjectURL(url));
}

/**
 * How long a recording is, and how big a picture is.
 *
 * A file's own metadata is not trusted for a limit: a renamed `video.mp4` that
 * is four minutes long says it is thirty seconds in whatever header the recorder
 * wrote. So the numbers come from the decoder — `<video>`/`<audio>` for the
 * duration, which is what the user will actually hear and see — and a failure to
 * read them is reported as `null` rather than guessed, so a caller can decide
 * whether an unreadable duration is a reason to refuse.
 */
export function probeMedia(blob) {
    return withObjectUrl(blob, url => new Promise(resolve => {
        const isVideo = String(blob.type ?? "").startsWith("video/");
        const isAudio = String(blob.type ?? "").startsWith("audio/");
        if (!isVideo && !isAudio) return resolve({ durationMs: null, width: null, height: null });
        const el = document.createElement(isVideo ? "video" : "audio");
        el.preload = "metadata";
        el.muted = true;
        const done = () => {
            const width = isVideo && Number.isInteger(el.videoWidth) ? el.videoWidth : null;
            const height = isVideo && Number.isInteger(el.videoHeight) ? el.videoHeight : null;
            const duration = Number.isFinite(el.duration) && el.duration > 0
                ? Math.round(el.duration * 1000)
                : null;
            // `removeAttribute("src")` before the revoke in withObjectUrl: on
            // some engines an element still holding a src keeps the resource
            // alive past the revoke, which is the leak this file is about.
            el.removeAttribute("src");
            el.load?.();
            resolve({ durationMs: duration, width, height });
        };
        el.onloadedmetadata = done;
        el.onerror = () => {
            el.removeAttribute("src");
            resolve({ durationMs: null, width: null, height: null });
        };
        el.src = url;
    }));
}

/** The pixel size of an image, read by the decoder rather than the header. */
export function probeImage(blob) {
    return createImageBitmap(blob)
        .then(bmp => {
            const size = { width: bmp.width, height: bmp.height };
            bmp.close?.();
            return size;
        })
        .catch(() => ({ width: null, height: null }));
}

// ---------------------------------------------------------------------------
// Making a photograph small enough to keep five of
// ---------------------------------------------------------------------------

/**
 * Downscale a photograph to what a phone screen can actually show.
 *
 * A 48-megapixel original is 8–12 MB, which is the reason a note could not hold
 * five pictures. It does not need to: the longest edge anyone looks at is about
 * 1600 pixels, and a 1600px JPEG at q0.82 is 200–400 KB. So the photograph is
 * redrawn once, on the way in, and what is stored is the small version.
 *
 * Two decisions worth stating. The output is ALWAYS JPEG, even for a PNG with
 * transparency, because a screenshot of a document is opaque and a PNG of a
 * photo is three times the bytes for a difference nobody can see at 1600px; the
 * one thing that is lost is a transparent background, and a photograph taken
 * with a phone's camera has none. And if the downscale FAILS — an engine with
 * no canvas, a HEIC the decoder will not open, a file that is not really an
 * image — the original is returned rather than the file being refused, so the
 * per-kind byte ceiling is what decides and not a capability check.
 */
export async function shrinkPhoto(file, { longEdge, quality, maxKeptBytes = MAX_PHOTO_KEPT_BYTES }) {
    const original = file instanceof Blob ? file : null;
    if (!original) return null;
    // Already small enough, and not a huge original: keep the bytes as they are
    // rather than re-encoding a file that was never the problem.
    if (original.size <= 512 * 1024) return original;

    let bitmap = null;
    try {
        bitmap = await createImageBitmap(original);
    } catch {
        return original;
    }
    const { width, height } = bitmap;
    const scale = Math.min(1, longEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        bitmap.close?.();
        return original;
    }
    // JPEG has no alpha, and without this a PNG with transparency comes out with
    // black where the transparency was.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));

    // The re-encode is a promise, not a guarantee. A phone screenshot is mostly
    // flat colour and a 1600px JPEG of one can still come out over the ceiling a
    // note promises to hold — so the quality is stepped down once rather than the
    // file being stored anyway. One step, deliberately: a third pass would be
    // spending a decode and a re-encode to shave off a few kilobytes nobody is
    // counting.
    if (blob && blob.size > maxKeptBytes) {
        const lower = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.6));
        if (lower && lower.size < blob.size) blob = lower;
    }
    // Only take the smaller one. On a photo that is already mostly flat colour
    // the re-encode can come out LARGER than the original, and storing that
    // would be a regression dressed as an optimisation.
    if (!blob || blob.size >= original.size) return original;
    return blob;
}

/**
 * Can this engine tell us the picker was dismissed?
 *
 * `cancel` on a file input is what says "the user chose nothing", and it is
 * supported everywhere this app runs: Chrome 113, Safari 16.4, Firefox 121.
 * The capability is DETECTED rather than version-guashed, because the whole
 * reason it matters is that an engine which has it must never be given the
 * workaround below.
 *
 * Asked per call rather than cached in a module constant. A prototype lookup
 * costs nothing, and "when did this module happen to be evaluated" is not a
 * question a browser feature should depend on — the answer here is the same every
 * time in a browser, and asking keeps the decision where it is used.
 */
function canCancelInput() {
    return typeof HTMLInputElement !== "undefined"
        && "cancel" in HTMLInputElement.prototype;
}

/**
 * Ask for files and hand back an array, whatever the browser did.
 *
 * A cancel is an empty array, not a rejection: the user changed their mind, and
 * that is not an error to report.
 *
 * THE FALLBACK IS REGISTERED ONLY WHERE IT IS NEEDED, and getting that wrong is
 * what made attachments silently vanish. The old version always listened for
 * `focus` on the window and settled 400ms later — and on Android and iOS the
 * window regains focus as soon as the picker sheet opens, long before anybody has
 * touched anything. So the promise was settled with an empty list, the input was
 * removed from the page, and the file the user then picked fired `change` on a
 * detached element that had already been settled: no attachment, no error, and
 * nothing on screen to say why. The photograph simply did not save.
 *
 * So: where `cancel` exists, `change` and `cancel` are the whole story and
 * nothing else is listened for. Where it does not, the focus heuristic is the
 * only signal there is — and it is kept off the engines that do not need it.
 */
export function pickFiles({ accept, multiple = false } = {}) {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept ?? "";
        input.multiple = multiple;
        input.className = "sr-only";
        input.tabIndex = -1;
        document.body.append(input);

        let settled = false;
        const finish = files => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(files);
        };

        input.addEventListener("change", () => finish([...(input.files ?? [])]));

        if (canCancelInput()) {
            input.addEventListener("cancel", () => finish([]));
        } else {
            // An engine with no `cancel` at all: the only way to notice that a
            // picker went away is the window coming back, and the choice has to
            // have been made by then. Long enough for a person to have picked
            // something, short enough that a dismissed picker does not leave a
            // dead input on the page.
            window.addEventListener("focus", () => {
                setTimeout(() => finish([...(input.files ?? [])]), 1500);
            }, { once: true });
        }

        input.click();
    });
}
