import { toast } from "../ui/components/toast.js";

// The PWA's own half: the service worker, and the browser's offer to install the
// app. Both are captured here, at boot, because both are events that fire once
// and are worthless afterwards.

// The install prompt, held. Chrome fires `beforeinstallprompt` when the app
// becomes installable, and ONLY the handler that calls `preventDefault()` gets to
// put up its own dialog later — so the event has to be caught while it is live
// and kept. It is kept here rather than acted on, because an install prompt is a
// decision about the whole app and belongs on a settings row the user chose to
// open, not in the face of someone who came to start a timer.
//
// Browsers that will never fire it — Firefox and Safari do not, and Chrome stops
// once the app is installed — simply leave this null, and the settings row that
// offers it is not drawn at all. Progressive enhancement, in the strict sense:
// the control that cannot work is not on the screen.
let deferred = null;

// Listeners at MODULE SCOPE, not inside registerServiceWorker().
//
// The event fires once per document, and it fires early — after load, while the
// app is still booting. registerServiceWorker() is called from main.js at the END
// of the boot sequence, after the store has been read and the first page has
// mounted, which is a genuine race: on a document that got there first the event
// is simply gone, and the install control is present on one page and missing from
// the next. It was seen doing exactly that — the button there in Settings and
// absent from the install page, on two consecutive loads of one site in one
// browser.
//
// A module body runs when the bundle is evaluated, which is the earliest moment
// available from JavaScript, so there is nothing left to race. The cost is that
// the listener exists even on a browser with no service worker, which is
// harmless: the event is the one being listened for, and it does not fire there.
window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferred = e;
});

window.addEventListener("appinstalled", () => {
    deferred = null;
    toast.show("settings.installed");
});

// How long this document has been alive, in the same clock `performance.now()`
// reports. Read at the moment the question is asked rather than at import,
// because the module body runs during boot and the controller can change
// seconds later.
const aliveFor = () => (typeof performance?.now === "function" ? performance.now() : 0);

export function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    // `updateViaCache: "none"` asks the browser not to answer the update check
    // from its own HTTP cache. Every server in this project already sends
    // `no-store` for /sw.js, and this is the belt to that pair of braces: it is
    // a request option rather than a header, so it holds on the browsers that
    // have historically decided `Cache-Control: no-store` did not mean them —
    // and a service worker served from a stale cache is one the browser stops
    // re-reading, which is how a shipped fix reaches nobody. Harmless where the
    // option is unsupported.
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});

    // The FIRST controllerchange is the worker claiming a page it did not control
    // before — which is every single first visit, because install does
    // skipWaiting() and activate does clients.claim(). Reloading on it reloaded
    // the app a second time, a moment after it had booted, on the first run and
    // on no release at all. Only a change FROM a controller this page already had
    // is an update, and only that one is worth throwing the page away for.
    let hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController) {
            hadController = true;
            return;
        }
        if (reloaded) return;
        reloaded = true;

        // …but not while the page is still starting, and not straight after it
        // started. This listener exists to pick up a release that landed while
        // the app was open, and the update check that finds one runs AS PART OF
        // the navigation — so a pull-to-refresh, which is a navigation the user
        // just asked for, used to be answered by the worker taking over and the
        // page reloading itself again underneath them. On a phone that lands
        // inside the refresh gesture, where a second navigation has nowhere
        // good to go, and it is indistinguishable from the app failing to open.
        //
        // The worker has already skipWaiting()ed and clients.claim()ed by the
        // time this fires, so it IS in control; what is stale is only this
        // document's bundle. Waiting is free: the next launch reads the new
        // worker and the new assets, which is the update path that works
        // anyway.
        if (aliveFor() < 4000) return;

        location.reload();
    });
}

/** Whether the browser is currently offering to install this app. */
export function canInstall() {
    return !!deferred;
}

/**
 * Put up the browser's own install dialog, at the user's request.
 *
 * Resolves to whether it was accepted. The event is consumed either way: a
 * browser only offers it once, so holding onto a dismissed prompt would only
 * produce a button that does nothing.
 */
export async function promptInstall() {
    const event = deferred;
    if (!event) return false;
    deferred = null;
    try {
        event.prompt();
        const choice = await event.userChoice;
        return choice?.outcome === "accepted";
    } catch {
        return false;
    }
}
