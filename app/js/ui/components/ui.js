import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { safeHref } from "../../domain/rich-text.js";

// The design system's building blocks.
//
// Every screen in this app is assembled from what is in this file and
// `fields.js` — nothing else writes a page header, a row, a stat, an empty
// state or a button by hand. That is the whole point of the file: the eight
// pages used to each have their own near-identical copy of "a title and a
// button at the top", and they had already drifted apart (one put an `<a>`
// there, one a `<button>`, one a `<label class="row">`; six wrote the title as
// a bare `<h1>` and eight wrapped it in a header). One shape, one place.
//
// Three rules the rest of the app follows:
//   1. An icon is the signal and the word is the confirmation. Where both fit
//      (a page header, a form's Save) the control carries both; where the word
//      would not fit — inside a list row, or on a 360px-wide bar — the icon
//      alone stands in, and the control keeps an `aria-label` so nothing is
//      lost to a screen reader.
//   2. `aria-label` is never the only label on a visible text button, and
//      `title` is never used in place of one. An icon-only control gets both.
//   3. The class names returned here are the ones in components.css. A page
//      that needs a shape that does not exist yet adds it to the stylesheet as a
//      component, not as an inline style on one screen.

// ------------------------------------------------------------- containers ---

// The page body: one vertical stack, aligned to the top, with a fluid gap.
export function page(...children) {
    return h("div", { class: "page" }, ...children);
}

// The same page body for the screens that ARE one screen.
//
// `page()` is align-content: start, which is right for a list or a form — both
// end where their rows end, and neither has any business owning the space below
// its last one. This is the other case: a screen whose content is a handful of
// things a person chooses between, where the content is given the height the
// viewport has so the targets can be as large as the screen allows rather than
// as large as their words do. The page head keeps its own height and everything
// below it takes the rest.
export function pageTall(...children) {
    return h("div", { class: "page page-tall" }, ...children);
}

// A boxed group. The unit of grouping on a screen; a hairline and a soft shadow
// lift it off the black, and no second background colour is needed for that.
export function card(...children) {
    return h("div", { class: "card" }, ...children);
}

// A two-column container for cards, from one column up.
export function cardGrid(...children) {
    return h("div", { class: "card-grid" }, ...children);
}

// ------------------------------------------------------------- headings -----

// A large heading. The page title, and the session panel's own title — the two
// places a screen states what it is about. `tag` is h1 on a page and h2 inside a
// panel, so the document outline stays right.
export function heading(text, { icon = null, tag = "h1" } = {}) {
    return h(tag, { class: "title" },
        icon ? uiIcon(icon, { className: "icon icon-lg title-icon" }) : null,
        text
    );
}

// The page heading, with two optional slots.
//
//   leading — a node at the inline-start, for the way back out of a detail page
//             or a piece of page-level context.
//   actions — nodes at the inline-end, for what this screen lets you do here.
//
// Both slots are the same slot on every screen, which is why a "New" link, a
// "Back" button, a filter and a dialog opener can all appear in the same place
// without any of them looking like a different kind of header.
export function pageHead({ title, icon = null, leading = null, actions = [] } = {}) {
    const acts = [].concat(actions).filter(Boolean);
    return h("div", { class: "page-head" },
        h("div", { class: "page-head-main" },
            leading,
            heading(title, { icon })
        ),
        acts.length ? h("div", { class: "page-head-actions" }, ...acts) : null
    );
}

// The grey micro-caption that names a group of rows. A class rather than a
// selector on `.section > h2`: a direct-child selector silently missed every
// heading that sat inside a section header, so seven of them rendered as a
// browser-default 24px bold h2 next to seven that rendered as the intended
// caption, on identical containers.
export function sectionTitle(text, { icon = null } = {}) {
    return h("h2", { class: "section-title" },
        icon ? uiIcon(icon, { className: "icon icon-sm" }) : null,
        text
    );
}

// A titled group of content, with an optional single action at the end of its
// header. Omit the title for a section that is just a slot.
export function pageSection({ title = null, icon = null, action = null, body = null, hidden = false, className = "" } = {}) {
    const hasHead = title != null || action != null;
    return h("section", { class: `section ${className}`.trim(), hidden },
        hasHead
            ? h("div", { class: "section-head" },
                title != null ? sectionTitle(title, { icon }) : null,
                action
            )
            : null,
        body
    );
}

// --------------------------------------------------------------- actions ----

// The one button factory. It returns an `<a>` when there is an `href` and a
// `<button>` otherwise, so "go to the list" and "do the thing" are the same call
// and can never be styled apart.
//
//   label     — the visible word. Omit it with `icon` for an icon-only control.
//   icon      — a key of ICONS; drawn before the label, or alone.
//   tone      — "" | "primary" | "danger" | "quiet".
//   href      — navigates (via the router's data-link click handler).
//   external  — opens in a new tab, hardened; mutually exclusive with `onClick`.
//   className — an extra class, for the one control in the app that is a card
//               rather than a button (see `target`). Nothing else uses it.
export function action({
    label = null,
    icon = null,
    tone = "",
    href = null,
    external = false,
    onClick = null,
    type = null,
    title = null,
    ariaLabel = null,
    disabled = false,
    block = false,
    className = ""
}, ...extra) {
    const classes = ["btn"];
    if (tone) classes.push(tone);
    if (block) classes.push("block");
    if (className) classes.push(className);
    // A control with no visible word is square and icon-only; one with a word
    // keeps the word. Decided here so no call site can get it wrong.
    if (!label && !extra.length) classes.push("icon-only");

    const content = [
        icon ? uiIcon(icon, { className: "icon btn-icon" }) : null,
        label,
        ...extra
    ];

    if (href) {
        // An EXTERNAL href is the one kind of href in this app that is not a
        // route this app owns, so it is the one kind that can be a scheme like
        // `javascript:` — which on an anchor is a script execution sink. The
        // values that arrive here include a Later item's saved link, and a Later
        // record that arrived through sync or a restored backup is not re-run
        // through validateLaterUrl() on its way into the database.
        //
        // safeHref() is the same policy the rich-text renderer already uses
        // (http, https, mailto only, and no control characters), so the two
        // places a user-supplied URL becomes a link agree by construction rather
        // than by memory. A URL the policy refuses renders no link at all: there
        // is nothing useful to point at, and a button is not a better answer
        // than doing nothing.
        const target = external ? safeHref(href) : href;
        if (target) {
            return h("a", {
                class: classes.join(" "),
                href: target,
                // Only in-app links carry data-link; the router's click handler turns
                // those into a client navigation and must not see an external one.
                ...(external ? { target: "_blank", rel: "noopener noreferrer" } : { "data-link": true }),
                title: title ?? label,
                "aria-label": ariaLabel
            }, content);
        }
        return h("button", {
            class: classes.join(" "),
            type: "button",
            title: title ?? label,
            "aria-label": ariaLabel,
            disabled: true
        }, content);
    }

    return h("button", {
        class: classes.join(" "),
        type: type ?? "button",
        onClick,
        title: title ?? label,
        "aria-label": ariaLabel,
        disabled
    }, content);
}

// An icon-only control for a list row. The word becomes the accessible name and
// the tooltip instead of the visible text, which is what keeps a row of four
// actions the same width as a row of one.
export function rowAction({ label, icon, tone = "", onClick = null, href = null, external = false, title = null, disabled = false } = {}) {
    return action({ label: null, icon, tone, href, external, onClick, title, ariaLabel: label, disabled });
}

// The trailing cluster of a list row or a page's action bar.
export function actionRow(...children) {
    const kids = children.flat().filter(Boolean);
    return h("div", { class: "row-actions" }, ...kids);
}

// A page-level action bar: the destructive and secondary things a screen offers,
// below the content they act on.
export function toolbar(...children) {
    return h("div", { class: "toolbar" }, ...children.flat().filter(Boolean));
}

// The way back out of a detail screen. An icon plus the word, because this is
// the one control that has to be unmistakable on a small screen.
export function backTo(href, label = null) {
    return action({ label: label ?? t("common.back"), icon: "back", href });
}

// ------------------------------------------------------------------ rows ----

// A list of rows. Rows are separated by a hairline rather than by gaps, so a long
// list reads as one continuous list instead of a stack of floating cards.
export function list(...children) {
    return h("div", { class: "list" }, ...children);
}

// A row that is itself the option — the shape a chooser needs, where tapping
// anywhere on the entry picks it. The same row anatomy, with the whole line as
// one button rather than a link plus a trailing control.
export function pickRow({ title, subtitle = null, icon = null, onClick = null } = {}) {
    return h("button", { class: "list-row list-row-pick", type: "button", onClick },
        icon ? h("span", { class: "row-glyph" }, uiIcon(icon)) : null,
        h("span", { class: "row-body" },
            h("span", { class: "row-line" }, h("span", { class: "row-title" }, title)),
            subtitle ? h("span", { class: "row-sub" }, subtitle) : null
        )
    );
}

// One row: an optional leading glyph, a body of one or two lines, and a trailing
// cluster of icon actions.
//
// The title is always its own element (a link when the row opens something) even
// when a subtitle follows it. The old markup nested the link inside a `.stack`
// div, which the stylesheet's `.list-row > a:first-child` rules could not see, so
// those rows silently lost their hover and tap-target behaviour. Here the shape
// does not change when a second line is added.
export function listRow({
    href = null,
    icon = null,
    // A leading IMAGE in place of a glyph, for a row whose content IS a
    // picture. A note that is three photographs and no words was drawn as a
    // generic note glyph with the word "Untitled" beside it, which is the one
    // thing about it a person could recognise at a glance.
    //
    // It is a node and not a URL because the caller owns its lifetime: a row
    // re-render must revoke the object URL it made, and a `src` string handed
    // to a kit that has no idea where it came from is how that gets forgotten.
    thumb = null,
    title,
    subtitle = null,
    meta = null,
    actions = [],
    tag = null,
    titleClass = ""
} = {}) {
    const titleNode = href
        ? h("a", { class: `row-title ${titleClass}`.trim(), href, "data-link": true }, title)
        : h("span", { class: `row-title ${titleClass}`.trim() }, title);
    const metas = [].concat(meta).filter(Boolean);

    return h("div", { class: `list-row ${thumb ? "has-thumb" : ""}`.trim() },
        thumb
            ? h("span", { class: "row-thumb" }, thumb)
            : icon ? h("span", { class: "row-glyph" }, uiIcon(icon)) : null,
        h("div", { class: "row-body" },
            h("div", { class: "row-line" },
                titleNode,
                tag,
                metas.length ? h("span", { class: "row-meta" }, ...metas) : null
            ),
            subtitle ? h("span", { class: "row-sub" }, subtitle) : null
        ),
        actions.length ? actionRow(actions) : null
    );
}

// A small read-only fact about a row — a direction, a frequency, a category, a
// state. One shape, so a list of them lines up and dims together.
export function badge(text, { icon = null, tone = "" } = {}) {
    return h("span", { class: `badge ${tone}`.trim() },
        icon ? uiIcon(icon, { className: "icon icon-sm" }) : null,
        text
    );
}

// ---- Large targets ---------------------------------------------------------

// A grid of them. Two side by side from 480px up, one below that.
//
// `fill` is for the grid that is the whole body of a `pageTall` screen: its
// tiles then take the height it is given rather than the height a word needs, and
// the glyph inside them is sized against that tile — so the target is as large as
// the screen allows on a wall display and as large as a thumb on a phone, from one
// rule.
export function targetGrid(targets, { compact = false, fill = false } = {}) {
    return h("div", { class: `target-grid ${compact ? "compact " : ""}${fill ? "fill" : ""}`.trim() },
        ...[].concat(targets).filter(Boolean));
}

// A glyph, a name, and an optional line saying what it will do.
//
// The control for "these four things, pick one". It is an `<a>` when it opens a
// page and a `<button>` when it acts, because the share chooser does both: two
// of its four targets navigate to a form and two of them navigate, but all four
// are the same card. The home screen's two money shortcuts and the share
// chooser's four are the same component at two sizes — which is why a new
// "pick one of these" screen never needs a new style.
export function target({ name, hint = null, icon, href = null, onClick = null, external = false }) {
    return action({
        label: null,
        icon: null,
        href: onClick ? null : href,
        external,
        onClick: onClick ?? null,
        block: false,
        className: "target"
    }, h("span", { class: "target-glyph" }, uiIcon(icon, { className: "icon icon-lg" })),
        h("span", { class: "target-name" }, name),
        hint ? h("span", { class: "target-hint" }, hint) : null);
}

// ----------------------------------------------------------------- stats ----

// One figure with its name above it. The unit every screen reports numbers in.
export function stat({ label, value, icon = null, tone = "" } = {}) {
    return h("div", { class: `stat ${tone}`.trim() },
        h("span", { class: "stat-label" },
            icon ? uiIcon(icon, { className: "icon icon-sm" }) : null,
            label
        ),
        h("span", { class: "stat-value number" }, String(value))
    );
}

// A grid of figures. One column on a very narrow screen, growing to four on a
// wide one — the count never squeezes a cell below the width its label needs.
export function statGrid(...cells) {
    return h("div", { class: "stat-grid" }, ...cells.flat().filter(Boolean));
}

/**
 * A grid of figures that are ONE set — never three across.
 *
 * `statGrid` grows with the WIDTH and stops at three, which is right for a report
 * whose figures are unrelated and whose number changes with the period. It is
 * wrong for a fixed set of four that belong together: at the wide breakpoint they
 * land as 3 + 1, and an orphan figure on a row of its own reads as a section of
 * its own rather than as the fourth of a set.
 *
 * So this is the same cells in the same shape with the count pinned: one column
 * on a very narrow screen, two from 400px, and four on every screen above that.
 * A monthly summary is four figures about one month, and it should look like four
 * figures however much room there is.
 */
export function statPairs(...cells) {
    return h("div", { class: "stat-grid pairs" }, ...cells.flat().filter(Boolean));
}

// A strip of figures in a bordered card. The same cells as `statGrid`, boxed:
// used where the figures are a summary of one screen rather than a grid of
// panels.
export function statPanel(...cells) {
    return h("div", { class: "stats" }, statGrid(...cells));
}

// --------------------------------------------------------------- states -----

// Nothing here yet. An icon and a sentence, so every empty list in the app reads
// the same way and none of them is a bare grey line floating under a heading.
export function emptyState(text, { icon = "inbox", action = null } = {}) {
    return h("div", { class: "empty" },
        h("span", { class: "empty-icon" }, uiIcon(icon, { className: "icon icon-lg" })),
        h("p", { class: "empty-text" }, text),
        action
    );
}

// The record a page was asked for is gone — deleted here, deleted on another
// device, or a stale bookmark. One component, so the six detail screens that
// used to write a bare "Not found." straight into the page container all answer
// the same way, with the same way out.
export function notFoundView(root = null) {
    const view = h("div", { class: "page" },
        pageHead({ title: t("error.not_found"), icon: "warning" }),
        h("p", { class: "muted" }, t("notFound.hint")),
        toolbar(
            action({ label: t("nav.home"), icon: "home", tone: "primary", href: "/" }),
            action({ label: t("nav.tasks"), icon: "tasks", href: "/tasks" })
        )
    );
    if (root) root.replaceChildren(view);
    return view;
}

// Something failed, with nothing the user can do about it on this screen.
export function errorView(text, { icon = "warning" } = {}) {
    return h("div", { class: "page" },
        pageHead({ title: text, icon })
    );
}
