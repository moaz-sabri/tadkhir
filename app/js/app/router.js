import { bus } from "./bus.js";
import { APP_NAME } from "../config.js";
import { errorView } from "../ui/components/ui.js";

const routes = [];

// Bumped by every navigate(). A mount() is async — it reads from IndexedDB
// before it draws — so two navigations can overlap, and the slower one finishes
// last. It then writes into #app, which by then belongs to the newer page: a
// `root.replaceChildren` from a stale page erases the page the user is actually
// looking at, and a `root.append` injects the old one underneath it.
let generation = 0;
let current = null;

export function defineRoutes(rs) {
    routes.push(...rs);
}

function decode(segment) {
    // A stray `%` in a hand-typed or bookmarked path makes decodeURIComponent
    // throw. Unguarded, that throw happened inside match(), so a malformed URL
    // surfaced as whatever the caller's catch reported — which for the initial
    // load meant "local storage is unavailable" for what was a bad address.
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function match(path) {
    for (const r of routes) {
        const keys = [];
        const re = new RegExp(
            "^" + r.path.replace(/:[^/]+/g, m => (keys.push(m.slice(1)), "([^/]+)")) + "/?$"
        );
        const m = path.match(re);
        if (m) {
            return {
                page: r.page,
                params: Object.fromEntries(keys.map((k, i) => [k, decode(m[i + 1])]))
            };
        }
    }
}

export const router = {
    async navigate(path, { replace = false, historyUpdate = true, scrollToTop = true } = {}) {
        const token = ++generation;
        const m = match(path) || match("/404");
        if (current?.page.unmount) {
            current.page.unmount();
        }
        current = m;
        document.title = typeof m.page.title === "function"
            ? m.page.title(m.params)
            : m.page.title;

        const app = document.querySelector("#app");
        // Each page draws into its own container rather than into #app itself.
        // A mount that is still awaiting when a newer navigation arrives can then
        // only ever write into a node nobody is looking at, which is what makes
        // the token check below a cleanup rather than a correctness requirement.
        const view = document.createElement("div");
        view.className = "view";
        // Focusable programmatically but not in the tab order, so moving focus
        // here after a navigation announces the new page without adding a stop.
        view.tabIndex = -1;
        app.replaceChildren(view);

        try {
            await m.page.mount(view, m.params);
        } catch (e) {
            // A page that throws while mounting would otherwise leave #app empty:
            // no heading, no error, just a blank screen. Say something instead,
            // in the same error screen every other failure uses.
            if (token !== generation) return;
            console.error("Page failed to mount:", path, e);
            view.replaceChildren();
            view.append(errorView(e?.message || "Something went wrong."));
            return;
        }

        if (token !== generation) {
            // Superseded while this page was still loading. Unmount it now so its
            // subscriptions and timers go away immediately rather than when the
            // page it displaced finally unloads.
            if (m.page.unmount) m.page.unmount();
            return;
        }

        // Move focus to the new page so a keyboard or screen-reader user lands
        // on it rather than at the top of the document — unless the page has
        // already put focus somewhere more specific, which is what a form that
        // wants the user to start typing does. Focusing the container here would
        // have pulled focus straight back out of that field.
        //
        // preventScroll is not optional: focusing a full-height element scrolls
        // it into view, which parked the page 80px down with the heading hidden
        // behind the sticky header. And the scroll position is reset explicitly
        // because a navigation is a new page — without this, moving from the
        // bottom of a long list to the next screen kept you at the bottom of it.
        if (scrollToTop) window.scrollTo(0, 0);
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) {
            view.focus({ preventScroll: true });
        }
        if (historyUpdate) {
            if (replace) {
                history.replaceState({}, "", path);
            } else if (location.pathname !== path) {
                history.pushState({}, "", path);
            }
        }
        bus.emit("route", path);
    },

    refresh() {
        // Same screen, new data: keep the reader where they were, which on a long
        // form or a scrolled list is the difference between "it updated" and
        // "where did it go".
        return this.navigate(location.pathname, { replace: true, scrollToTop: false });
    },

    // Title of the currently matched page (used to restore the tab title
    // after a session countdown finishes overwriting it).
    pageTitle() {
        if (!current?.page) return APP_NAME;
        return typeof current.page.title === "function"
            ? current.page.title(current.params)
            : current.page.title;
    },

    start() {
        window.addEventListener("popstate", () => this.navigate(location.pathname, { historyUpdate: false }));
        document.addEventListener("click", e => {
            const a = e.target.closest("a[data-link]");
            if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            if (a.target === "_blank") return;
            e.preventDefault();
            // Not awaited: a click handler cannot wait, and every failure mode in
            // navigate() is already handled inside it.
            this.navigate(new URL(a.href).pathname);
        });
        return this.navigate(location.pathname, { replace: true });
    }
};
