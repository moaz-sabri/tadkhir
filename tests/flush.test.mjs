import test from "node:test";
import assert from "node:assert/strict";
import { onFlush, flushNow, installFlushTriggers } from "../app/js/app/flush.js";

// The 500ms debounce on every autosaving field means that switching apps right
// after typing loses the last word or two — and on a phone the tab is then frozen
// or discarded, so the loss is permanent and silent. These tests pin the two
// halves of the fix: that a registered save is actually run at the right moment,
// and that a screen that has gone away stops being asked.

// Everything each test registers is dropped when it is done, so one test's
// callbacks cannot fire in the next. The module has one Set for the whole app.
const after = [];
const register = fn => { const off = onFlush(fn); after.push(off); return off; };
test.afterEach?.(() => { while (after.length) after.pop()(); });

test("a registered save runs when the app is flushed", () => {
    let saved = 0;
    register(() => { saved += 1; });
    flushNow();
    assert.equal(saved, 1);
});

test("a save that throws does not stop the next one", () => {
    // Two fields on one page are two independent writes for two independent
    // records. The second matters exactly as much as the first, and this runs
    // from an event handler on the way out of the page where there is nowhere to
    // report a failure to.
    const ran = [];
    register(() => { throw new Error("the first field's write failed"); });
    register(() => { ran.push("second"); });
    register(() => { ran.push("third"); });
    assert.doesNotThrow(() => flushNow());
    assert.deepEqual(ran, ["second", "third"]);
});

test("unsubscribing stops a save from running", () => {
    // The reason this is a Set with an unsubscribe rather than a list: a screen
    // that mounts and unmounts (the same page, navigated back to) must not pile up
    // callbacks writing into a DOM that is no longer there.
    let saved = 0;
    const off = register(() => { saved += 1; });
    flushNow();
    assert.equal(saved, 1);
    off();
    flushNow();
    assert.equal(saved, 1, "an unsubscribed save must not run again");
});

test("registering the same function twice runs it once", () => {
    let saved = 0;
    const fn = () => { saved += 1; };
    register(fn);
    register(fn);
    flushNow();
    assert.equal(saved, 1);
});

test("flushing with nothing registered is not an error", () => {
    assert.doesNotThrow(() => flushNow());
});

// A window stand-in with just the two events the app reacts to, so the triggers
// can be tested without a DOM.
const fakeWindow = (hidden = false) => {
    const listeners = new Map();
    return {
        document: { hidden },
        addEventListener: (name, fn) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        fire(name) {
            for (const fn of listeners.get(name) ?? []) fn();
        },
        count(name) {
            return (listeners.get(name) ?? new Set()).size;
        }
    };
};

test("hiding the tab flushes, and showing it again does not", () => {
    const win = fakeWindow();
    installFlushTriggers(win);
    let saved = 0;
    register(() => { saved += 1; });

    // The tab being hidden is the moment that matters: switching apps, locking
    // the screen, minimising. An IndexedDB write started from here usually
    // completes, because the page is still alive — it is only frozen after.
    win.document.hidden = true;
    win.fire("visibilitychange");
    assert.equal(saved, 1);

    // Coming back is not a moment that needs saving, and flushing on the way in
    // would fire writes for fields nobody has touched.
    win.document.hidden = false;
    win.fire("visibilitychange");
    assert.equal(saved, 1, "returning to the tab must not flush again");
});

test("a visible tab that fires visibilitychange does nothing", () => {
    const win = fakeWindow(false);
    installFlushTriggers(win);
    let saved = 0;
    register(() => { saved += 1; });
    win.fire("visibilitychange");
    assert.equal(saved, 0);
});

test("pagehide flushes, because bfcache and dismissal do not fire blur", () => {
    const win = fakeWindow(false);
    installFlushTriggers(win);
    let saved = 0;
    register(() => { saved += 1; });
    win.fire("pagehide");
    assert.equal(saved, 1);
});

test("installing on something that cannot listen does not throw", () => {
    // Node during tests, and any host without a window. boot() calls this before
    // the router starts; if it threw there the app would show its database error
    // screen for a missing DOM listener.
    assert.doesNotThrow(() => installFlushTriggers({}));
    assert.doesNotThrow(() => installFlushTriggers(null));
});
