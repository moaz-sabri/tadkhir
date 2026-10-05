import { openDb } from "./data/db.js";
import { store } from "./app/store.js";
import { router, defineRoutes } from "./app/router.js";
import { registerServiceWorker } from "./app/sw-register.js";
import { installFlushTriggers } from "./app/flush.js";
import { wakeLock } from "./app/wake-lock.js";
import { sessionWatch } from "./app/session-watch.js";
import { initLanguage, t } from "./i18n/i18n.js";
import { readShareParams, stashShare, hasContent } from "./app/share-payload.js";
import { shouldRunOnboarding } from "./app/first-run.js";
import { runOnboarding } from "./ui/components/onboarding.js";
import { hasEncryptionKeys } from "./services/crypto-service.js";
import { home } from "./ui/pages/home.js";
import { tasksPage, newTask } from "./ui/pages/tasks.js";
import { taskDetail } from "./ui/pages/task-detail.js";
import { sessionsPage } from "./ui/pages/sessions.js";
import { sessionDetail } from "./ui/pages/session-detail.js";
import { currentSession } from "./ui/pages/current-session.js";
import { financePage } from "./ui/pages/finance.js";
import { transactionsPage, newTransaction, transactionDetail } from "./ui/pages/finance-transactions.js";
import { recurringPage, newRecurring, recurringDetail } from "./ui/pages/finance-recurring.js";
import { debtsPage, newDebt, debtDetail } from "./ui/pages/finance-debts.js";
import { financeCategoriesPage } from "./ui/pages/finance-categories.js";
import { laterPage, newLater, laterDetail } from "./ui/pages/later.js";
import { pagesPage, pageDetail } from "./ui/pages/pages.js";
import { routinesPage, newRoutine, routineDetail } from "./ui/pages/routines.js";
import { kanbanPage } from "./ui/pages/kanban.js";
import { sharePage } from "./ui/pages/share.js";
import { quickPage } from "./ui/pages/quick.js";
import { reportsPage } from "./ui/pages/reports.js";
import { logPage } from "./ui/pages/log.js";
import { morePage } from "./ui/pages/more.js";
import { settingsPage } from "./ui/pages/settings.js";
import { installPage } from "./ui/pages/install.js";
import { notFound } from "./ui/pages/not-found.js";
import { renderNav } from "./ui/components/nav.js";
import { sessionStrip } from "./ui/components/session-strip.js";
import { addButton } from "./ui/components/add-button.js";
import { bus } from "./app/bus.js";
import { syncService } from "./services/sync-service.js";
import { checkBackupReminder } from "./services/backup-reminder.js";
import { toast } from "./ui/components/toast.js";
import { errorView } from "./ui/components/ui.js";
import { h } from "./ui/dom.js";

const SHARE_PATH = "/share";

defineRoutes([
    { path: "/", page: home },
    { path: "/tasks", page: tasksPage },
    { path: "/tasks/new", page: newTask },
    { path: "/tasks/:id", page: taskDetail },
    { path: "/sessions", page: sessionsPage },
    { path: "/sessions/:id", page: sessionDetail },
    { path: "/session", page: currentSession },
    { path: "/finance", page: financePage },
    { path: "/finance/transactions", page: transactionsPage },
    { path: "/finance/transactions/new", page: newTransaction },
    // One route for both directions, with the type as a parameter. Two literal
    // paths could not do this: the pattern has no `:segment`, so match() built no
    // params and `params.type` was always undefined — which meant the home
    // screen's "add income" button silently opened the form pre-selected as an
    // expense, and the only hint was the user's own mistake later.
    { path: "/finance/transactions/new/:type", page: newTransaction },
    { path: "/finance/transactions/:id", page: transactionDetail },
    { path: "/finance/recurring", page: recurringPage },
    { path: "/finance/recurring/new", page: newRecurring },
    { path: "/finance/recurring/:id", page: recurringDetail },
    { path: "/finance/debts", page: debtsPage },
    { path: "/finance/debts/new", page: newDebt },
    { path: "/finance/debts/:id", page: debtDetail },
    { path: "/finance/categories", page: financeCategoriesPage },
    { path: "/later", page: laterPage },
    { path: "/later/new", page: newLater },
    { path: "/later/:id", page: laterDetail },
    // No /pages/new: a page is created untitled by the list's "New page" action
    // and named on the editor it lands on, so there is no form screen to route
    // to and nothing to clean up if the user backs out of it.
    { path: "/pages", page: pagesPage },
    { path: "/pages/:id", page: pageDetail },
    // Routines are the SECOND service, and the order in ui/components/nav.js is
    // the priority: the person, then what they are doing today, then what they
    // keep doing, then what they are saving, then what they spend. They used to be
    // argued about — kept off the bar while it was nine items wide, on the
    // argument that a routine belongs on the home screen — and the argument was
    // about WIDTH, not about importance. A menu has room for everything, so the
    // question is settled by where the thing sits in the day's thinking, and a
    // daily habit is in it before a note is.
    { path: "/routines", page: routinesPage },
    { path: "/routines/new", page: newRoutine },
    { path: "/routines/:id", page: routineDetail },
    { path: "/kanban", page: kanbanPage },
    { path: "/share", page: sharePage },
    // The manifest's four shortcuts, and the cross-browser answer to them. Not a
    // destination anybody navigates to: like Settings, it is a thing a person does
    // from OUTSIDE the app — a long press on the launcher icon, a bookmark, a
    // home-screen shortcut, an iOS Shortcut — so it is filed in Settings, which
    // is where a person looks for a door of that kind, rather than in the list of
    // sections.
    { path: "/quick", page: quickPage },
    { path: "/reports", page: reportsPage },
    // The Log and the session list are one pair of views over one record, so they
    // are filed together in the tools layer (see ui/components/nav.js) rather than
    // given a layer each: "what happened" and "the sessions it happened in" are
    // two questions about the same thing, and a Log that could not reach the list
    // of what it was reporting on was a dead end.
    //
    // It is a tool over the services rather than one of them, and the only screen
    // that answers "what did I actually do" across all of them at once. It holds
    // no record — every line is derived from records that already exist, so there
    // is nothing extra to export, sync or reconcile. See services/log-service.js.
    { path: "/log", page: logPage },
    // /more is not a service: it is the navigation's own list given an address, so
    // the menu has a bookmark, a home-screen shortcut and a link in a note. The
    // header's button opens the same list as a sheet, which is the fast path and
    // the reason this page is not the way people get around.
    { path: "/more", page: morePage },
    { path: "/settings", page: settingsPage },
    // Under Settings rather than in the list of sections: installing is something
    // a person does once, and a list that carried it would spend a row on a screen
    // most people never open. See the note at the top of ui/pages/install.js.
    { path: "/settings/install", page: installPage },
    { path: "/404", page: notFound }
]);

// The manifest's share target. The share sheet posts to /api/share/intake, which
// parks what was shared and redirects to /share?t=<token>; a browser that
// predates the file share target posts nothing and the old GET params are still
// read, so both shapes arrive here. Either way the router would match /share as
// an ordinary path and then rewrite the query out of the address bar — replaying
// the same share on the next reload — so the parameters are parked here, before
// the router starts, and the path is left for the chooser page to own.
//
// Nothing is written to the database at this point: whether a share becomes an
// income record, an expense, a session or a follow-up item is the user's call,
// and the chooser is where they make it. Parking it also means an offline share
// behaves exactly like every other write in the app — there is no request to
// fail, because there is no request.
function parkIncomingShare() {
    if (location.pathname.replace(/\/+$/, "") !== SHARE_PATH) return false;
    const payload = readShareParams();
    if (hasContent(payload)) stashShare(payload);
    // Replaced, not pushed: Back from the chooser should leave the share behind
    // rather than offer to share it again.
    history.replaceState({}, "", SHARE_PATH);
    return true;
}

/**
 * Sweep attachment bytes no record describes.
 *
 * A note deleted on another device arrives with its attachments already gone
 * from it, and a save interrupted between writing the bytes and writing the
 * record leaves bytes nothing points at. Neither is visible in the app — the UI
 * reads descriptions from the records — so the only symptom is storage that never
 * comes back. Once at startup is enough: nothing else creates a stale row, and
 * every one of them is a row the records will never describe again.
 */
async function sweepAttachments() {
    try {
        const { attachmentService } = await import("./services/attachment-service.js");
        await attachmentService.sweep();
    } catch (e) {
        // A sweep that cannot run is not worth a blank screen. The next one will.
        console.warn("attachment sweep failed:", e);
    }
}

function showDbError() {
    const app = document.querySelector("#app");
    if (!app) return;
    app.replaceChildren(errorView(t("error.db_unavailable")));
}

async function requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
        try {
            const persisted = await navigator.storage.persist();
            if (!persisted) console.log("Persistence not granted");
        } catch (e) { console.warn("Persistence request failed", e); }
    }
}

function setupVersionChangeHandler(db) {
    db.onversionchange = () => {
        // Another tab is upgrading the schema. Close the handle so it is not
        // holding the old version open, and tell the user rather than leaving
        // every subsequent write failing silently against a closed connection.
        db.close();
        const overlay = h("div", { class: "reload-overlay" },
            h("p", {}, t("common.updateAvailable")),
            h("p", {}, t("common.reload"))
        );
        document.body.append(overlay);
        setTimeout(() => location.reload(), 3000);
    };
}

function showErrorBanner() {
    if (document.querySelector("#error-banner")) return;
    const banner = h("div", { id: "error-banner", class: "toast banner" }, t("error.unexpected"));
    document.body.append(banner);
    setTimeout(() => banner.remove(), 5000);
}

function setupErrorHandlers() {
    window.addEventListener("error", e => {
        console.error("Uncaught error", e.error || e.message);
        showErrorBanner();
    });
    window.addEventListener("unhandledrejection", e => {
        console.error("Unhandled rejection", e.reason);
        // Handled: a rejection that reached here has already been logged and
        // shown, and letting it through to the console as well only produces a
        // second, noisier report of the same thing.
        e.preventDefault();
        showErrorBanner();
    });
}

// The screen wake lock, and the alert that fires when a running session reaches
// its estimate. Both used to be wired here and are now their own modules with
// their own lifecycles: a wake lock has to be taken again every time the page
// becomes visible (the platform drops it when the page does not), and the alert
// has to fire once per crossing whether or not a session component happens to be
// on screen. What is left to do at boot is to hand each of them the two facts
// they need — the active session and the stored setting — and let them own the
// rest.
//
// Both subscribe to the store rather than to `data-changed`, so they react to
// the value they care about instead of to every write in the database. The
// setting is a separate subscription because turning it off has to take effect
// immediately, without waiting for a session to change.
function setupDeviceIntegrations() {
    wakeLock.install();
    store.subscribe(s => s.active, () => wakeLock.sync());
    store.subscribe(s => s.settings?.keepAwake, () => wakeLock.sync());
    wakeLock.sync();
    sessionWatch.start();
}

// A notification is asking to be opened on the session it is about. The service
// worker cannot navigate a window it does not own, so it posts this instead, and
// the router here is the only thing in the app that changes the address.
function setupServiceWorkerMessages() {
    navigator.serviceWorker?.addEventListener?.("message", e => {
        if (e.data?.type === "open-session") router.navigate("/session");
    });
}

// Draws the first screen. Returns true when the app is up, false when the
// first-run flow has taken the screen instead and will call router.start()
// itself.
//
// The first-run flow is not a route (see ui/components/onboarding.js for why),
// which means this is the one place that has to know it exists. It is asked
// about, not asserted: shouldRunOnboarding() checks the device's own history, so
// a device that already has a key or any records never sees it — and the failure
// mode of that check being wrong is a welcome screen over somebody's data, so
// the question is asked AFTER the store has been read and never short-circuits
// the router.
async function startApp() {
    const app = document.getElementById("app");
    let firstRun = false;
    try {
        firstRun = await shouldRunOnboarding({
            hasKeys: await hasEncryptionKeys(),
            taskCount: store.getState().tasks.length
        });
    } catch (e) {
        // A decision that cannot be made is a decision not to interrupt. The app
        // works without the flow, and the alternative is a first-run screen on
        // every launch because the flag could not be read.
        console.warn("First-run check failed, starting without onboarding", e);
    }

    if (!firstRun) {
        await router.start();
        return true;
    }

    runOnboarding(app, afterRouteStart);
    return false;
}

// Everything that needs a mounted, routed app. Split out of boot() so the
// first-run path can reach the same tail the moment the flow lets the user
// through, without duplicating the list.
function afterRouteStart() {
    sessionStrip.mount(document.getElementById("session-strip"));
    // The add control and the session bar are the two fixed pieces of the shell,
    // and they are mounted together for one reason: the add button's offset is
    // the session bar's measured height (--bar-h on <html>), so the bar has to
    // exist before the button can sit above it rather than on it.
    addButton.mount(document.getElementById("add-root"));
    registerServiceWorker();
    setupServiceWorkerMessages();
    setupDeviceIntegrations();
    // Before the first page can hide the tab, so a field that mounts on it can
    // register its pending save before anything does.
    installFlushTriggers();
    checkBackupReminder();
    syncService.setup();
}

async function boot() {
    setupErrorHandlers();
    try {
        const db = await openDb();
        setupVersionChangeHandler(db);
        store.init();
        await store.refresh("all");
        // The language comes from the stored settings, so the reader's choice
        // survives a reload. It used to be initialised before the store was read
        // and without an argument, which meant it always fell back to the browser
        // locale: choosing Arabic in Settings changed the screen until the next
        // reload, and then quietly reverted to English.
        initLanguage(store.getState().settings.language);
        store.setState({ ready: true });

        if (store.getState().tasks.length > 0) await requestPersistence();
        bus.on("route", path => renderNav(path));

        parkIncomingShare();
        // Not awaited: it is a storage tidy-up, and holding the first paint for
        // it would make every cold start wait on a write nobody is waiting for.
        sweepAttachments();

        // Everything below the router belongs to a running app, and the
        // first-run flow draws over the shell while it asks its questions — so
        // `started` is what separates "the app is up" from "the app is asking to
        // be set up". The two paths converge on the same tail; only the order
        // differs, and only because the flow has to own the screen before the
        // first page can claim it.
        const started = await startApp();
        if (started) afterRouteStart();

        bus.on("recovery-notification", data => {
            toast.show("settings.syncRecoveryRequired", { fileCode: data?.fileCode });
        });
        bus.on("delete-notification", data => {
            toast.show("settings.syncCrossSpaceDelete", { fileCode: data?.fileCode });
        });
    } catch (e) {
        showDbError();
        console.error(e);
    }
}

boot();
