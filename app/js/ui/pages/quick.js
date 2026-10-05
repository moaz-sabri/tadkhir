import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { store } from "../../app/store.js";
import { peekShare, sharePrefill } from "../../app/share-payload.js";
import { sessionService } from "../../services/session-service.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { toast } from "../components/toast.js";
import { openQuickTransaction } from "../components/finance-quick-add.js";
import { pageTall, pageHead, targetGrid, target, rowAction } from "../components/ui.js";

// The four things somebody reaches for this app to do, as ONE address each.
//
// These exist because the manifest's `shortcuts` are the obvious home for them
// and they are not available everywhere. `shortcuts` is Chromium-only: iOS
// Safari and Firefox read the manifest, ignore that key, and offer nothing on a
// long press. There is no web API that replaces it — a page cannot ask to be
// put in a launcher's long-press menu, and a page cannot receive an OS share
// either — so "every browser" cannot mean "the launcher's menu".
//
// What CAN be everywhere is a plain URL. This is it: `/quick` is an ordinary
// route on the same origin, every manifest shortcut points at it, and it is
// bookmarkable, shareable, and reachable from an iOS Shortcut, a home-screen
// bookmark, or the link in Settings. The destinations are the screens the app
// already has, so a shortcut is a shortcut and not a second implementation of
// "start a session".
//
// `?do=` names which one to perform. With no `?do=` this is the chooser, so
// the address is useful on its own and not only when something built it.
//
// It is read from `location.search` here rather than as a router parameter
// because the router matches on the PATHNAME and rewrites the URL it matched:
// a route that took its parameter out of the query string would lose it on the
// first navigation, which is the same trap the share target parks its payload
// to get out of.
const DESTINATIONS = {
    note: "/later/new",
    income: "/finance/transactions/new/income",
    expense: "/finance/transactions/new/expense"
};
export const quickPage = {
    title: () => t("quick.title"),

    async mount(root) {
        const asked = new URLSearchParams(location.search).get("do");

        // The parked payload is only READ here, never written: this is an entry
        // point somebody tapped, not a share, and a share that arrived a moment
        // ago is still waiting on the chooser. Using it as the default title is
        // the one overlap worth having — a shortcut launched straight after a
        // share should not silently drop what was shared.
        const parked = peekShare();

        if (asked === "session" || asked in DESTINATIONS) {
            await run(asked, parked);
            return;
        }

        root.append(pageTall(
            pageHead({
                title: t("quick.title"),
                icon: "bolt",
                // The way out, as a glyph like everything else here. This screen is
                // an ADDRESS somebody was sent to by something that is not this
                // app — a launcher long-press, a bookmark, an iOS Shortcut — so it
                // owes them a way back, and the header's action slot is where every
                // other screen puts one.
                actions: [rowAction({
                    label: t("common.close"),
                    icon: "close",
                    onClick: () => router.navigate("/")
                })]
            }),
            // Four glyphs, side by side, filling what is left of the screen.
            //
            // The hint line each of these carried is gone: this is the one screen
            // in the app that is chosen with one thumb from a home screen without
            // being read, so a tile big enough to press and a name under it are the
            // whole answer. A second line of prose under a glyph twice the size of
            // the target's own label is the thing this screen has no room for.
            targetGrid([
                target({
                    name: sessionRunning() ? t("quick.openSession") : t("quick.startSession"),
                    icon: sessionRunning() ? "clock" : "play",
                    onClick: () => run("session", parked)
                }),
                target({
                    name: t("quick.writeNote"),
                    icon: "bookmark",
                    onClick: () => run("note", parked)
                }),
                target({
                    name: t("quick.addIncome"),
                    icon: MONEY_ICON_NAMES.income,
                    onClick: () => run("income", parked)
                }),
                target({
                    name: t("quick.addExpense"),
                    icon: MONEY_ICON_NAMES.expense,
                    onClick: () => run("expense", parked)
                })
            ], { fill: true })
        ));
    }
};

// A session can only be running one at a time, so while one is live "start a
// session" would fail on every tap. The label is the honest one and the icon
// follows it — the same rule the share chooser follows, asked in one place per
// screen rather than guessed from a manifest nobody can ask.
function sessionRunning() {
    const active = store.getState().active;
    return !!active && ["running", "paused"].includes(active.status);
}

// Perform one action, then leave — the whole point of the shortcut.
//
// A session is started HERE rather than by handing over to the running-session
// screen, because a shortcut that opens a screen with a button on it is a
// shortcut that made the user press twice, and this is the one action of the
// four that has nothing to ask.
//
// The two money ones are asked for HERE, in this screen's own dialog, and for the
// same reason: a shortcut that lands on a form page is a shortcut that navigated
// twice to ask one question. The addresses they used to navigate to are still
// routes — they are what a launcher with no `?do=` on it ends up at, and what a
// bookmark to "add income" resolves to — but this path no longer goes through one.
//
// The note still opens its page, because it is a sentence before it is a record
// and that page has a field for writing it in.
async function run(action, parked) {
    if (action === "session") {
        if (sessionRunning()) {
            router.navigate("/session");
            return;
        }
        try {
            await sessionService.start({ title: sharePrefill(parked) || null });
            router.navigate("/session");
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        }
        return;
    }
    if (action === "income" || action === "expense") {
        const record = await openQuickTransaction({ type: action, title: sharePrefill(parked) || "" });
        // The chooser under this dialog is a snapshot of nothing that changed, but
        // re-mounting it is free and keeps one rule everywhere: after a write, the
        // page you are on is the page as it now is.
        if (record) router.refresh();
        return;
    }
    router.navigate(DESTINATIONS[action]);
}
