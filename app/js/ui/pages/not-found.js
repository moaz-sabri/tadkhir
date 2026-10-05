import { t } from "../../i18n/i18n.js";
import { notFoundView } from "../components/ui.js";

// Reached for any path the router does not recognise. The app is offline-first
// with no server-side routing, so this is a normal outcome rather than a failure:
// a stale bookmark, or a link from another device that predates a rename.
//
// It is the same screen a record-that-no-longer-exists gets, from any of the six
// detail pages that used to write a bare "Not found." straight into the page
// container. One screen, one way out.
export const notFound = {
    title: () => t("notFound.title"),
    mount(root) {
        notFoundView(root);
    }
};
