import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";

// The four Finance areas, each with the glyph that names it. The overview
// (/finance) is reached from the main navigation, so the sub-nav carries only the
// internal sections. `startsWith` keeps the right tab marked while a detail or
// "new" page below it is open.
//
// The same strip shape, the same mark and the same `aria-current` as any other set
// of destinations — an icon and a label, current one marked. It used to be four
// bare words that wrapped onto two rows on a phone; see `.subnav` in
// components.css. It is not the main navigation and does not replace it: this is
// four screens INSIDE one section, which the main list names and this one opens.
const TABS = [
    ["/finance/transactions", "finance.transactions", "note"],
    ["/finance/recurring", "finance.recurring", "repeat"],
    ["/finance/debts", "finance.debts", "scale"],
    ["/finance/categories", "finance.categoriesPage", "tag"]
];

export function financeNav(path) {
    return h("nav", { class: "subnav", "aria-label": t("finance.title") },
        ...TABS.map(([p, k, glyph]) =>
            h("a", {
                href: p,
                "data-link": true,
                "aria-current": path === p || path.startsWith(`${p}/`) ? "true" : "false"
            },
                uiIcon(glyph, { className: "icon icon-sm" }),
                t(k)
            )
        )
    );
}
