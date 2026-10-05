// The one piece of transport plumbing the two request helpers share.
//
// Both services (sync and auth) POST JSON to the same API with the same cookie,
// and both used to have no timeout at all. That is the bug this module exists to
// prevent, so it is written down here rather than in one of the two callers: a
// second caller must not be able to make the same mistake.

/**
 * An AbortSignal that fires after `ms`, or `null` where that cannot be built.
 *
 * `AbortSignal.timeout` is the whole implementation on any engine from 2022
 * onwards, and it needs no cleanup because it holds no timer the page must keep
 * alive. The fallback exists because a thrown Signal is not a graceful
 * degradation — it would be a rejected fetch on every request on an older
 * browser, which is worse than no timeout at all — and a controller with a
 * `setTimeout` that is never cleared is the standard shape underneath it.
 *
 * Returning `null` (no signal, no timeout) is the honest last resort: the app
 * keeps working exactly as it did before this existed.
 */
export function requestSignal(ms) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(ms);
    }
    if (typeof AbortController !== "function") return null;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}
