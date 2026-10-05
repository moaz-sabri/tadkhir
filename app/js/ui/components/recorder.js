import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";
import { action, toolbar } from "./ui.js";
import { formatClock } from "../../domain/time.js";
import {
    captureAvailability,
    openStream,
    closeStream,
    boundedRecorder,
    captureErrorCode
} from "../../app/capture.js";
import {
    MAX_AUDIO_MS,
    MIN_AUDIO_MS,
    MAX_VIDEO_BYTES,
    MAX_VIDEO_MS
} from "../../domain/attachments.js";

// One dialog, two recorders.
//
// Audio and video are the same gesture with a different picture and different
// ceilings: a stream, a clock that stops itself, a byte tally that stops itself,
// a red dot while it runs. Written twice, the two copies would disagree about
// when the stop button becomes available, and only one of them would be right
// about the five-second minimum.
//
// THE MINIMUM IS ENFORCED ON THE BUTTON, NOT ON THE RESULT. A recording shorter
// than five seconds is refused with a message rather than saved and then
// rejected: the alternative is a file the user chose to make being thrown away
// after the fact, and a button that says why it is disabled is better than a
// button that works and then apologises.

// How often the readouts refresh. 100 ms is fast enough to look live and slow
// enough that a two-minute recording is 1200 repaints rather than 12000.
const TICK_MS = 100;

// The meter. An AnalyserNode is the only way to see a level without an audio
// file, and it costs one node: the stream is already being recorded, so this is
// a tap, not a second capture.
function levelMeter(stream) {
    const bars = Array.from({ length: 12 }, () => h("span", { class: "recorder-meter-bar" }));
    const node = h("div", { class: "recorder-meter", "aria-hidden": "true" }, ...bars);
    let audio = null;
    let raf = 0;
    // Null when there is nothing to run: no AudioContext at all, or one that will
    // not take this stream. A missing meter is a nicety, not a reason to refuse
    // to record, so every caller treats a null `paint` the same way.
    let paint = null;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
            audio = new Ctx();
            const source = audio.createMediaStreamSource(stream);
            const analyser = audio.createAnalyser();
            analyser.fftSize = 32;
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);
            paint = () => {
                analyser.getByteTimeDomainData(data);
                // Peak deviation from the midpoint, on a curve: a linear meter on
                // speech spends its life in the bottom two bars.
                let peak = 0;
                for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
                const lit = Math.min(bars.length, Math.round(Math.sqrt(peak) * bars.length));
                bars.forEach((bar, i) => {
                    bar.dataset.on = i < lit ? "true" : "false";
                });
                raf = requestAnimationFrame(paint);
            };
        }
    } catch {
        // No AudioContext, or the stream is video-only: the meter is a nicety
        // and a missing one is not a reason to refuse to record.
        paint = null;
    }
    return {
        node,
        // The repaint loop and the context's lifetime are asked for at different
        // moments, and treating them as one thing is what a "too short"
        // recording cost. The dialog stays open with the record button back, the
        // second attempt begins, and the meter it inherited was already closed and
        // already unscheduled — twelve bars frozen at whatever the first attempt
        // reached, on the one screen where somebody is trying to find out whether
        // they are being heard at all.
        start() {
            if (!paint || raf) return;
            raf = requestAnimationFrame(paint);
        },
        stop() {
            cancelAnimationFrame(raf);
            raf = 0;
        },
        // Once per dialog, from the teardown, and only from there: `stop()` runs on
        // every exit path that ends a recording — and two of those run on a single
        // successful one, `onStop` and the caller's `finally` — while this runs
        // once, as the dialog goes away.
        //
        // It is also idempotent, because that is the only safe assumption about a
        // teardown: forgetting the context leaves the second call with nothing to
        // do, and `AudioContext.close()` REJECTS with `InvalidStateError` when
        // the context is already closed. It rejects ASYNCHRONOUSLY, so the `try`
        // around the call could never see it — a `try` catches a throw, not a
        // rejection — and the second close became an unhandled rejection that the
        // window reported as an unexpected error at the exact moment the recording
        // landed. Twelve bars nobody asked for were the reason somebody watching a
        // finished voice memo believed it had been lost.
        dispose() {
            this.stop();
            const closing = audio;
            audio = null;
            if (!closing || closing.state === "closed") return;
            try {
                // The rejection is handled where it is created. This is called
                // from a `finally` three frames down, which has returned by the
                // time the promise settles.
                closing.close()?.catch(() => {});
            } catch {
                // An engine that refuses outright to close a context that never
                // opened is not worth surfacing to somebody recording a voice
                // memo.
            }
        }
    };
}

/**
 * Record a voice memo or a short video, and resolve with what was captured.
 *
 * Resolves `null` when the user backs out — a cancelled recording is not a
 * failure and must not leave an error on the screen. Rejects nothing: a refused
 * permission, an absent camera and a full disk are all reported as a toast and
 * resolve `null`, because from the form's point of view the attachment simply
 * was not added.
 */
async function record(kind) {
    const isVideo = kind === "video";
    const maxMs = isVideo ? MAX_VIDEO_MS : MAX_AUDIO_MS;
    const minMs = isVideo ? 0 : MIN_AUDIO_MS;
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : null;

    // The stream is opened BEFORE the dialog, so a permission prompt is a
    // permission prompt rather than a dialog that then asks for one. A refusal
    // is the common case on a first attempt and it deserves its own message.
    //
    // ONE refusal is answered before the attempt, because it would otherwise
    // cost a failed capture to discover: a page on http at a non-localhost host
    // has no mediaDevices at all, so there is nothing to prompt for and the fix
    // is the address, not a permission.
    //
    // A permission the Permissions API reports as "denied" is deliberately NOT
    // answered here, though it can be, and an earlier version did. That answer
    // is a snapshot taken when the page loaded, and Chrome and Edge keep
    // reporting "denied" for an origin until the tab is reloaded — even after
    // the user has allowed the camera in the browser's own settings. Short-
    // circuiting on it meant `getUserMedia` was never called, so no prompt ever
    // appeared, and the only thing on screen was a toast telling somebody to
    // allow a permission they had already allowed. Nothing here can refuse on a
    // guess: `openStream` is the authority, and its own rejection distinguishes
    // every case `captureErrorCode` knows about.
    const blocked = captureAvailability();
    if (blocked !== "granted") {
        toast.show(`error.${blocked === "insecure" ? "capture_insecure" : "capture_unsupported"}`);
        return null;
    }

    let stream;
    try {
        stream = await openStream(isVideo
            ? { video: { facingMode: "environment" }, audio: true }
            : { audio: true });
    } catch (e) {
        toast.show(`error.${captureErrorCode(e)}`);
        return null;
    }

    let live = null;
    // Filled in by the dialog's body once it exists, and used by the `finally`
    // below. Null until then, and null is the "nothing to stop" answer.
    const handle = { cancel: null };
    try {
        live = livePreview(stream, isVideo);
        // dialog.form RESOLVES with CANCELLED when the dialog is dismissed — it
        // does not reject — so the check is explicit. Without it a cancelled
        // recording resolved to the CANCELLED symbol, and the caller's
        // `captured?.blob` guard was what quietly turned that into "nothing
        // recorded", which reads as a recorder that failed rather than one the
        // user walked away from.
        const captured = await dialog.form(
            // No message line under the title: the dialog is titled by what it
            // is, and the hint inside the body is the part that changes.
            null,
            {
                titleKey: isVideo ? "attachments.recordingVideo" : "attachments.recordingAudio",
                // The recorder's own buttons are the dialog's buttons. A confirm
                // in the footer would offer to save a recording that has not
                // been started yet.
                submit: null,
                // `close` is the ONLY way to answer this dialog with a value.
                // `dialog.close()` dismisses it and resolves with CANCELLED, so
                // calling that with the blob threw the recording away.
                body: close => buildBody({ kind, stream, live, minMs, maxMs, maxBytes, close, handle })
            }
        );
        return captured === dialog.CANCELLED ? null : captured;
    } finally {
        // The stream outlives every exit path — the dialog closing, the recorder
        // throwing, the user navigating away mid-recording — and a live camera is
        // the one thing in this app that stays on when the screen is not looking
        // at it. So it is closed here and nowhere else. The recorder is stopped
        // first, or it would be handed a closed stream to fail on.
        handle.cancel?.();
        live?.stop();
        closeStream(stream);
    }
}

// The live picture. `muted` + `playsinline` together are what make an autoplay
// video work on iOS at all, and without them the dialog opens showing a black
// rectangle on half the phones this app runs on.
function livePreview(stream, isVideo) {
    if (!isVideo) return null;
    const video = h("video", {
        class: "recorder-preview",
        autoplay: true,
        muted: true,
        playsInline: true
    });
    video.srcObject = stream;
    video.play?.().catch(() => {
        // Autoplay refused even with muted: the picture is a nicety, and the
        // recording is unaffected, so there is nothing to report.
    });
    return {
        node: video,
        stop() {
            video.pause();
            video.srcObject = null;
        }
    };
}

function buildBody({ kind, stream, live, minMs, maxMs, maxBytes, close, handle }) {
    const isVideo = kind === "video";
    const clock = h("p", { class: "recorder-clock", role: "timer", "aria-live": "off" }, "0:00");
    const hint = h("p", { class: "recorder-hint muted" });
    const fill = h("span", { class: "recorder-bar-fill" });
    const bar = h("div", { class: "recorder-bar", role: "presentation" }, fill);

    const meter = isVideo ? null : levelMeter(stream);
    const preview = live?.node ?? null;

    const start = action({
        label: isVideo ? t("attachments.startVideo") : t("attachments.startAudio"),
        icon: isVideo ? "video" : "mic",
        onClick: () => begin()
    });
    const finish = action({
        label: t("attachments.stopRecording"),
        icon: "stop",
        onClick: () => active?.stop()
    });
    finish.hidden = true;

    let active = null;
    let elapsed = 0;
    let bytes = 0;
    let tick = 0;
    // Its own flag rather than "is the hint still the one we started with?": that
    // test only ever matched the AUDIO hint, so a video showed its limits line for
    // all thirty seconds and the one line saying the red dot is live never came.
    let running = false;
    let hintKey = "";
    const setHint = key => {
        if (key === hintKey) return;
        hintKey = key;
        hint.textContent = t(key);
    };
    setHint(isVideo ? "attachments.videoHint" : "attachments.audioHint");

    const paint = () => {
        // formatClock takes milliseconds, which is what `elapsed` already is.
        // Dividing first — the obvious-looking "elapsed is seconds by now" — made
        // the readout stall at 0:00 and then jump, because 70_000 ms is 70 seconds
        // and not 70 of anything.
        clock.textContent = formatClock(elapsed);
        // ONE ratio, used for both the width and the colour, and it is the NEARER
        // of the two ceilings — which is the one that will actually stop the
        // recording. The two used to be computed independently (the width from
        // the nearer, the colour from the farther), so on a video the bar filled
        // towards 30 seconds while it went red at 4.25 MB, and a bar whose colour
        // and length disagree is a bar nobody can read.
        const byTime = Math.min(1, elapsed / maxMs);
        const bySize = maxBytes ? Math.min(1, bytes / maxBytes) : 0;
        const toward = maxBytes ? Math.min(byTime, bySize) : byTime;
        fill.style.width = `${Math.round(toward * 100)}%`;
        fill.dataset.hot = toward > 0.85 ? "true" : "false";
        finish.disabled = elapsed < minMs;
    };

    // "Nothing is recording any more": the readout interval and the meter's
    // repaint loop both stop here, and neither is destroyed. This is what runs
    // between two attempts inside one dialog as well as at the end of one, which
    // is why it must leave the meter's context open.
    const release = () => {
        clearInterval(tick);
        tick = 0;
        meter?.stop();
    };

    // A dialog that goes away without the recorder having finished — Escape, the
    // backdrop, a route change — has to take the recorder with it. `release()`
    // alone is not enough: the clock timer lives inside `boundedRecorder` and is
    // only cleared by its own `onStop`, so without this the recorder kept
    // recording into a stream the caller had already closed, with a timer armed
    // for thirty minutes and nothing that would ever fire to stop it. The meter's
    // AudioContext is here for the same reason and belongs here alone: it is the
    // one resource this dialog owns outright rather than lending to an attempt.
    //
    // Exposed through the `handle` the caller passes in, because the dialog's
    // body builder can only RETURN the node it draws — it has no way to hand a
    // teardown back out. The caller cancels from its own `finally`, which runs on
    // every exit including the dismissed one.
    const stopEverything = () => {
        release();
        active?.cancel();
        meter?.dispose();
        active = null;
        running = false;
    };
    handle.cancel = stopEverything;

    const begin = () => {
        // Reset before the first paint. Without this a second attempt — after a
        // recording that was too short, say — opened on the previous attempt's
        // clock and byte count: the bar started part full, the readout started
        // counting from the last recording's length, and the stop button came
        // back already enabled.
        elapsed = 0;
        bytes = 0;
        running = true;
        hintKey = "";
        start.hidden = true;
        finish.hidden = false;
        setHint(isVideo ? "attachments.videoHint" : "attachments.audioHint");
        // Every attempt, not only the first: the meter outlives an attempt that
        // ended in "too short", and this is what puts it back to work.
        meter?.start();
        active = boundedRecorder(stream, {
            kind,
            maxMs,
            maxBytes,
            onStop: (blob, ms, reason) => {
                release();
                active = null;
                running = false;
                if (!blob.size) {
                    setHint("attachments.nothingRecorded");
                    start.hidden = false;
                    finish.hidden = true;
                    return;
                }
                // The five-second minimum is checked here as well as on the
                // button, because a recorder that stopped ITSELF (the clock, the
                // byte tally) has no button to have been disabled.
                if (ms < minMs) {
                    setHint("attachments.audioTooShort");
                    start.hidden = false;
                    finish.hidden = true;
                    return;
                }
                // A `size` stop means the video hit its ceiling, which is a
                // success that happens to have a number attached, not an error —
                // but the user asked for a video, not a truncated one, and a
                // silent stop is indistinguishable from a bug. A TOAST, not a
                // hint: the dialog is about to close, and a hint set one line
                // before the close is a hint nobody ever sees.
                if (reason === "size" && isVideo) toast.show("attachments.videoAtSizeLimit");
                close({ blob, durationMs: ms, bytes: blob.size });
            },
            onError: () => {
                release();
                setHint("attachments.captureFailed");
            }
        });
        active.start(TICK_MS * 5);
        tick = setInterval(() => {
            elapsed = active.elapsedMs;
            bytes = active.bytes;
            paint();
            // For an audio memo the line changes once the five seconds are up,
            // because until then it is explaining why Stop is not available yet.
            // For a video it changes at once: there is no minimum to wait out.
            if (running && elapsed >= minMs && hintKey !== "attachments.recording") {
                setHint("attachments.recording");
            }
        }, TICK_MS);
        paint();
    };

    return h("div", { class: "recorder" },
        preview,
        clock,
        bar,
        meter?.node ?? null,
        hint,
        toolbar(start, finish)
    );
}

/** Record a voice memo. Resolves `{ blob, durationMs }` or null. */
export function recordAudio() {
    return record("audio");
}

/** Record a short video. Resolves `{ blob, durationMs }` or null. */
export function recordVideo() {
    return record("video");
}
