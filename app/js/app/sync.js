import { bus } from "./bus.js";

// BroadcastChannel is used for cross-tab sync. Guard it so older browsers
// (or Node during tests) that lack support don't break at import time, and so
// a Node test process never keeps a BroadcastChannel worker alive.
const isBrowser = typeof window !== "undefined";
const channel = isBrowser && "BroadcastChannel" in globalThis
    ? new BroadcastChannel("task-timer-sync")
    : { onmessage: null, postMessage() {} };

// Who else in this tab needs to know that ANOTHER tab wrote something. Kept apart
// from the bus on purpose.
//
// The bus carries "data changed in this tab" — which every service emits after
// its own write, and which sync-service must NOT answer by syncing, because the
// write that caused it has already queued its own sync. A separate list here
// carries the one thing the bus cannot: a change that arrived from a different
// tab, which this tab's outbox knows nothing about and would otherwise not push
// for another full 30 seconds — or, on a device where the other tab is the one
// that gets closed, not at all.
const remoteListeners = new Set();

if (channel.onmessage === null) {
    channel.onmessage = e => {
        if (e.data !== "data-changed") return;
        bus.emit("data-changed");
        for (const fn of [...remoteListeners]) {
            try {
                fn();
            } catch {
                // One listener's failure must not stop the store refresh or the
                // other listeners, and there is nowhere to report it to from
                // inside a message handler.
            }
        }
    };
}

export function broadcastChange() {
    channel.postMessage("data-changed");
}

/**
 * Run `fn` when a DIFFERENT tab of this app wrote something. Returns the
 * unsubscribe.
 *
 * Note what this is not: it is not a request to re-read the database. The store
 * is already listening to the bus and re-renders on its own; this exists for the
 * one thing a local re-render cannot do, which is push the other tab's work.
 */
export function onRemoteChange(fn) {
    remoteListeners.add(fn);
    return () => remoteListeners.delete(fn);
}
