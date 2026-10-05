import { t } from "../../i18n/i18n.js";
import { page, pageHead, pageSection, list, listRow } from "../components/ui.js";
import { NAV_ICON_NAMES } from "../icons.js";
import { NAV_SECTIONS, NAV_LABELS } from "../components/nav.js";

// The menu as a page: every destination, grouped by layer, in priority order.
//
// This is not a service and it holds no records. It is the same list the header's
// button opens, given an address of its own so there is one thing that can be
// bookmarked, put on a home screen, linked from a note, or reached when the
// header is not in the picture. The bar used to be a bar for the leading
// destinations and a "More" row for the rest, which meant the priority order was
// only ever visible in two halves — and the halves were the two things that
// disagreed.
//
// The list is NAV_SECTIONS, not a copy of it, so this page and the sheet cannot
// come to hold different answers to "what exists".
export const morePage = {
    title: () => t("nav.menu"),

    mount(root) {
        root.append(page(
            pageHead({ title: t("nav.menu"), icon: "menu" }),
            ...NAV_SECTIONS
                .filter(section => section.paths.length > 0)
                .map(section => pageSection({
                    // One glyph per layer, so the groups read as three kinds of
                    // thing rather than as three more headings in a row. It is the
                    // glyph of the layer, not of any one destination in it, because
                    // the layer is what the heading is naming.
                    icon: section.icon,
                    title: section.key ? t(section.key) : null,
                    body: list(...section.paths.map(path => listRow({
                        href: path,
                        icon: NAV_ICON_NAMES[path],
                        title: t(NAV_LABELS[path])
                    })))
                }))
        ));
    }
};