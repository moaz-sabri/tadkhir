import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { store } from "../../app/store.js";
import { bus } from "../../app/bus.js";
import { router } from "../../app/router.js";
import { sessionService } from "../../services/session-service.js";
import { toast } from "./toast.js";
import { dialog } from "./dialog.js";
import { action, targetGrid, target } from "./ui.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { openQuickTransaction } from "./finance-quick-add.js";
import { field } from "./fields.js";

// What a record added from this button does to the screen underneath it. The
// dialog is over whatever the user was doing, and a glance is a SNAPSHOT: the home
// screen read its figures when it mounted, so a new transaction would not show up
// in them until they navigated away and back. Re-mounting the current route is one
// line and the same thing the app does after a save on any other screen; there is
// no subscription to add, because the numbers on this screen are read once and
// drawn once.
//
// `null` is a dismissed dialog — nothing was written, so nothing is redrawn.
function afterQuickAdd(record) {
    if (record) router.refresh();
}

// The add control: one button, and the four things anybody opens this app to
// record.
//
// It exists because the alternative was a launcher ON the home screen — a form
// with a title field and a Start button, plus two money shortcuts, taking the
// top of the first screen before the day's figures. That is a page of controls
// above a page of answers, and the person who opens this app at nine in the
// morning is reading, not composing. Putting the four actions behind one control
// gives the home screen its whole height back and costs one tap.
//
// It floats at the bottom corner rather than sitting in the flow, for two
// reasons: the same control then works from every screen rather than only the
// one that happens to hold it, and it is the one thing worth reaching for
// without reading the page first. It rides ABOVE the active-session bar — the bar
// publishes its measured height as `--bar-h`, and the button adds that to its own
// offset — so recording an expense while a timer runs does not put the two on top
// of each other.
//
// The four actions are the app's whole vocabulary of recording, and each one goes
// straight to the form that already asks for its details. Nothing is written
// before there is something to write: a shortcut that recorded an empty expense
// would leave the number to be guessed later, which is the one thing a ledger
// must never ask for.
const ACTIONS = Object.freeze([
    // Two of the four reuse a word that already existed elsewhere in the app — the
    // share chooser and the old home launcher said exactly these — so "add an
    // expense" is the same phrase everywhere rather than a fourth synonym.
    //
    // The two money entries open the quick dialogs rather than following a link to
    // the new-transaction page, because the page is gone: a link would have had to
    // land on a route that immediately opened a dialog over an empty view, which is
    // the same thing with a page history entry in the middle. The address those two
    // used to point at is still a route (see finance-transactions.js) — it is what a
    // launcher shortcut opens — but nothing in the running app navigates to it.
    { key: "home.addIncome", icon: MONEY_ICON_NAMES.income, quick: "transaction", type: "income" },
    { key: "home.addExpense", icon: MONEY_ICON_NAMES.expense, quick: "transaction", type: "expense" },
    { key: "session.startSession", icon: "clock", onClick: "session" },
    { key: "add.note", icon: "bookmark", href: "/later/new" }
]);

export const addButton = {
    /**
     * Mounted once, next to the session strip, and kept for the life of the app.
     *
     * The one screen it stands down for is the session page: that page IS the
     * session, drawn to fill the viewport, and a record button in the corner of a
     * screen somebody is reading across a room is one more thing to look at. The
     * session is the thing being recorded; the others are things noticed while it
     * runs, and for those the strip's own presence is the reminder that /session
     * is one tap away.
     */
    mount(root) {
        if (!root) return () => {};

        // A GLYPH AND NOTHING ELSE, in the corner it already floats in.
        //
        // It used to be a pill with the word beside the plus, and that word was
        // the app's caption for the same control on every screen it appears on —
        // including the ones whose only other content is a caption. One control,
        // one meaning, one shape: a plus in a circle in the corner is the same
        // signal in a third of the width, and nothing is lost to anybody who
        // cannot draw it — the word is the tooltip and the accessible name, which
        // is what an icon-only button carries instead of visible text.
        const button = action({
            label: null,
            icon: "plus",
            tone: "primary",
            title: t("add.title"),
            ariaLabel: t("add.title"),
            className: "fab",
            onClick: () => this.open()
        });

        root.replaceChildren(h("div", { class: "fab-root" }, button));

        const render = path => {
            // `hidden` rather than a class: a control you can reach with the
            // keyboard and cannot see is worse than one that is not there.
            button.hidden = path === "/session";
        };
        render(location.pathname);
        const offRoute = bus.on("route", render);

        return () => {
            offRoute();
            root.replaceChildren();
        };
    },

    /**
     * The chooser: the four actions, as the same targets the share sheet offers.
     *
     * `dialog.form` with `submit: null` because the body IS the choice — a
     * confirm button beside four destinations is a control that does not mean
     * anything. It still gets the standard cancel, so the sheet is escapable by
     * tap and not only by Escape.
     *
     * A dialog that opens a dialog — the two money entries do — is safe here
     * because this one is CLOSED first, every time. Only one dialog can be on
     * screen (see dialog.js), so leaving the chooser up while the add form opens
     * would replace the chooser and leave the button that opened it answering a
     * question nobody is looking at any more.
     */
    open() {
        return dialog.form(null, {
            titleKey: "add.title",
            submit: null,
            body: close => targetGrid(
                ACTIONS.map(item => target({
                    name: t(item.key),
                    icon: item.icon,
                    onClick: () => {
                        // Closed first, always: a sheet left on screen over a form
                        // that has just opened is two answers to "what now", and the
                        // route listener would close it a frame later anyway.
                        close();
                        if (item.quick === "transaction") {
                            openQuickTransaction({ type: item.type }).then(afterQuickAdd);
                            return;
                        }
                        if (item.href) router.navigate(item.href);
                        else this.startSession();
                    }
                })),
                { compact: true }
            )
        });
    },

    /**
     * Start a free session, asking for its name first.
     *
     * A name is asked and never required, because "gym" and "phone call" are the
     * only difference between two hours of recorded time and two hours nobody can
     * find again — and an untimed session has to be recognisable later, or the Log
     * is a list of durations.
     *
     * The question is a dialog rather than a field on the home screen because there
     * is no longer a launcher on the home screen: this is the one place the name
     * can be asked, so it is asked here.
     *
     * The answer comes from what the dialog RESOLVED to, never from the field.
     * Dismissal is a distinct value rather than null (dialog.CANCELLED), and a
     * dismissed dialog would otherwise be read as an empty title — which is
     * indistinguishable from the user having pressed Start with the field left
     * blank, and starts a session nobody asked for.
     */
    async startSession() {
        const active = store.getState().active;
        // One session at a time. While one is live this is not a new session, it
        // is the one already running — and saying so beats a start that fails on
        // every tap.
        if (active && ["running", "paused"].includes(active.status)) {
            router.navigate("/session");
            return;
        }

        const title = h("input", {
            type: "text",
            name: "title",
            maxLength: 120,
            autocomplete: "off",
            placeholder: t("home.sessionTitlePlaceholder"),
            "aria-label": t("home.sessionTitle")
        });

        // Enter in the field is the same as the button: a dialog whose only field
        // is a text field has exactly one answer, so the keyboard can give it.
        const answer = await dialog.form(null, {
            titleKey: "add.newSession",
            submitLabel: "session.start",
            submitIcon: "play",
            body: close => {
                const form = h("form", {
                    onSubmit: e => { e.preventDefault(); close(title.value.trim()); }
                }, field(t("home.sessionTitle"), title));
                title.addEventListener("keydown", e => {
                    if (e.key === "Enter") { e.preventDefault(); close(title.value.trim()); }
                });
                return form;
            },
            submit: close => close(title.value.trim())
        });

        if (answer === dialog.CANCELLED) return;
        try {
            await sessionService.start({ title: answer || null });
            router.navigate("/session");
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    }
};