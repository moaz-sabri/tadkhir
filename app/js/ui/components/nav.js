import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon, NAV_ICON_NAMES } from "../icons.js";
import { router } from "../../app/router.js";
import { dialog } from "./dialog.js";
import { pickRow, sectionTitle } from "./ui.js";

// The destinations, in the order the app thinks about them.
//
// The order is not alphabetical and it is not historical: it is the order of
// PRIORITY — the person, then today's work, then the services, then the tools
// that organise the services, then the settings — and it is written down HERE,
// once, and everything that shows a destination derives from this file. A second
// copy of the order is how a bar and a menu end up disagreeing about what the
// app thinks matters most.
//
// ONE list drives everything, and there are only two things that render it:
//
//   the menu    a button in the header, beside the name, at every width. One tap
//               opens the whole list, grouped by layer.
//   /more       the same list as a page, for a bookmark, a launcher shortcut, or
//               any address that has to stand on its own without the header.
//
// The header used to carry the destinations twice — a scrolling tab strip from
// 1024px and a fixed bottom bar below it — plus a "More" row for the ones that
// did not fit. Three renderings of one list, and the consequence was a bar of
// six icons on a 360px phone whose labels had to be shrunk, clipped and finally
// dropped, and a desktop strip wide enough to need its own scrollbar. One button
// is the honest shape for a list this long: it costs the same width on a phone as
// on a laptop, it needs no breakpoint, and the ORDER — which is the thing that
// carries the priority — is stated in full the first time it is opened rather than
// implied by which icons survived the truncation.

/** The label each destination answers to. A table rather than a lookup on the
 *  path, because `t()` returns the key itself on a miss — and a menu rendering
 *  the literal text "nav.routines" looks like a typo rather than a missing entry.
 *  Exported because /more draws the same list and the two must not be able to
 *  disagree about what one of them is called. */
export const NAV_LABELS = {
    "/": "nav.home",
    "/tasks": "nav.tasks",
    "/routines": "nav.routines",
    "/later": "nav.later",
    "/finance": "nav.finance",
    "/pages": "nav.pages",
    "/kanban": "nav.kanban",
    "/sessions": "nav.sessions",
    "/log": "nav.log",
    "/reports": "nav.reports",
    "/settings": "nav.settings"
};

/** The layers, in priority order, and the destinations in each. This is the
 *  taxonomy — which KIND of thing a screen is — and the menu is derived from it
 *  rather than written out, so a destination added to a layer cannot appear
 *  twice under two headings.
 *
 *  Sessions sits in the tools beside the Log rather than in the services with
 *  the rest, because the Log is where sessions are kept: the list of them is a
 *  view of the same record the Log reports on, not a service of its own. It used
 *  to be a bar destination of its own, which put "what happened" and "the
 *  sessions it happened in" two taps and a layer apart. */
export const NAV_LAYERS = Object.freeze([
    { key: "nav.groupServices", icon: "tasks", paths: ["/tasks", "/routines", "/later", "/finance"] },
    { key: "nav.groupTools", icon: "kanban", paths: ["/pages", "/kanban", "/sessions", "/log", "/reports"] },
    { key: "nav.groupManage", icon: "sliders", paths: ["/settings"] }
]);

/** Where the same list lives as a page of its own. Not a service: it is the menu
 *  with a URL, for the addresses that cannot open a dialog — a bookmark, a
 *  home-screen shortcut, a link in a note. */
export const MORE_PATH = "/more";

/** Every destination, in priority order: the person, then the layers flattened.
 *  Built by concatenation rather than written out, because a layer is the
 *  taxonomy and this is the reading order — and the reading order is what
 *  NAV_ICON_NAMES has to agree with, item for item. */
export const DESTINATIONS = Object.freeze([
    "/",
    ...NAV_LAYERS.flatMap(layer => layer.paths)
]);

/** The menu, as it is drawn: the person alone at the top, then one block per
 *  layer. A section with no caption is the home row, which needs no heading —
 *  there is nothing above it to distinguish it from, and a caption saying "Today"
 *  over a single link is a heading above a heading. */
export const NAV_SECTIONS = Object.freeze([
    { key: null, icon: "home", paths: ["/"] },
    ...NAV_LAYERS
]);

/**
 * Is `path` the menu itself?
 *
 * The header's button is the only control in the app with no destination of its
 * own, so there is nothing for it to be "current" at while a service is open —
 * except on /more, which is the menu drawn as a page, and where marking it says
 * "you are looking at the list of sections" rather than leaving the header blank.
 */
export function inMenu(path) {
    return path === MORE_PATH;
}

/**
 * Draw the header's one navigation control.
 *
 * The button rather than a list, at every width: there is no viewport at which
 * eleven destinations fit legibly across the top of a screen, and there never
 * will be, so the strip's only honest form is a door.
 */
export function renderNav(path) {
    const root = document.getElementById("top-nav");
    if (!root) return;
    root.replaceChildren(
        h("button", {
            class: "btn quiet nav-menu",
            type: "button",
            "aria-haspopup": "dialog",
            "aria-current": inMenu(path) ? "true" : null,
            onClick: () => openNavMenu()
        },
        uiIcon("menu", { className: "icon nav-menu-icon" }),
        h("span", { class: "nav-menu-label" }, t("nav.menu"))
        )
    );
}

/**
 * Open the whole list, grouped by layer, over whatever is on screen.
 *
 * A sheet rather than a page, because this is the app's most-used control and a
 * page would make every section three taps: open, choose, come back. The dialog
 * closes itself on any navigation (see dialog.js), so leaving it open is not a
 * state anything has to reason about.
 *
 * The rows are buttons rather than links, and they navigate through `close()`
 * first. A link here would be caught by the router's document-level click
 * handler, which navigates — and the dialog's own route listener then tears the
 * sheet down mid-navigation, which is the kind of race that leaves a backdrop on
 * screen over a page that has already changed.
 */
export function openNavMenu() {
    return dialog.form(null, {
        titleKey: "nav.menu",
        // Nothing to confirm: the body IS the choice, and a confirm button beside
        // four destinations is a button that does not mean anything.
        submit: null,
        body: close => navMenuBody(path => {
            close();
            router.navigate(path);
        })
    });
}

/**
 * The menu's rows. Shared with /more so the two cannot drift.
 *
 * `onPick` rather than an href, for the reason on openNavMenu: every row answers
 * with the close it was handed, and nothing here knows what a route is.
 */
function navMenuBody(onPick) {
    return NAV_SECTIONS
        .filter(section => section.paths.length > 0)
        .map(section => h("div", { class: "menu-section" },
            section.key ? sectionTitle(t(section.key)) : null,
            h("div", { class: "list" },
                ...section.paths.map(path => pickRow({
                    title: t(NAV_LABELS[path]),
                    icon: NAV_ICON_NAMES[path],
                    onClick: () => onPick(path)
                }))
            )
        ));
}

export { navMenuBody };