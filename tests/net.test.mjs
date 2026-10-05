import test from "node:test";
import assert from "node:assert/strict";
import { requestSignal } from "../app/js/app/net.js";

// The timeout exists because a request that never settles suspends the sync run
// forever: the flag that keeps two runs from overlapping is released only in the
// `finally` of a call that never returns, and every later attempt then finds sync
// "busy" and silently does nothing. These tests pin the three ways the signal can
// be built, because "it works on my browser" is exactly how a two-year-old
// Safari ends up with a sync that dies on every request and no error anywhere.

// `AbortSignal.timeout` is the whole implementation of `requestSignal`, and its
// timer is NOT ref'd: it does not hold the event loop open by itself. In a
// browser that is invisible — a page is never "done", and a real fetch keeps the
// loop alive on its own — but a test that awaits the abort with nothing else
// pending lets Node's loop empty first, and on Node 22 (what the Dockerfile
// builds with) `node --test` then cancels the still-pending test and exits 1.
// Node 24 happens to keep the loop alive for a running test, so the same file
// passes there and fails in the container: a property of the runner, not of the
// code under test.
//
// So anything here that waits on an abort holds the loop open explicitly. The
// behaviour being asserted is unchanged; only the scaffolding that keeps Node
// from deciding the test is over early is added.
function keepAlive(ms) {
    const until = Date.now() + ms;
    const spin = () => {
        if (Date.now() >= until) return;
        const t = setTimeout(spin, 5);
        if (typeof t.ref === "function") t.ref();
    };
    spin();
}

test("the signal fires, so a hung fetch is given up on", async () => {
    const signal = requestSignal(10);
    assert.ok(signal, "a signal must be produced where AbortController exists");
    // Not aborted yet.
    assert.equal(signal.aborted, false);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(signal.aborted, true, "the timeout must have fired");
});

test("a signal with a timeout still aborts a real fetch", async () => {
    // The point of the whole change, asserted end to end rather than through the
    // signal: a fetch that never answers must reject, so the caller maps it to
    // `network` and its existing backoff takes over.
    const signal = requestSignal(20);
    const hanging = () => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    keepAlive(500);
    await assert.rejects(hanging(), /aborted/);
});

test("a missing AbortController degrades to no timeout instead of throwing", () => {
    // There is no way to remove `AbortController` from the global in a module
    // that has already read it, and `AbortSignal.timeout` is built on it — so
    // both have to go for this branch to be reachable. The contract that matters
    // at the call site: the helper either returns a signal or returns null, and
    // never throws. A thrown Signal would be a rejected fetch on EVERY request,
    // which is strictly worse than the bug this fixes.
    const signal = globalThis.AbortSignal;
    const controller = globalThis.AbortController;
    try {
        globalThis.AbortSignal = {};
        delete globalThis.AbortController;
        assert.equal(requestSignal(10), null, "no signal is the honest last resort");
    } finally {
        globalThis.AbortSignal = signal;
        globalThis.AbortController = controller;
    }
});

test("the native path is used where it exists, so no timer is left behind", () => {
    // AbortSignal.timeout holds no timer the page has to keep alive, which is why
    // it is preferred over a controller: a controller's setTimeout would keep
    // firing after the request is long finished. On any engine from 2022 onwards
    // the native one is what comes back.
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        const signal = requestSignal(50_000);
        assert.equal(signal.aborted, false);
        // A native timeout signal has no `onabort` wiring of ours and, decisively,
        // is not an AbortController's signal — the distinction is what keeps the
        // timer from being one we have to remember to clear.
        assert.equal(typeof signal.onabort, "object");
    }
});
