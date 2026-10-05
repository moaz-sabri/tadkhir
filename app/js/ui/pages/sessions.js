import { t } from "../../i18n/i18n.js";
import { sessionService } from "../../services/session-service.js";
import { sessionRow } from "../components/session-row.js";
import { page, pageHead, list, emptyState } from "../components/ui.js";

export const sessionsPage = {
    title: () => t("nav.sessions"),
    async mount(root) {
        const data = await sessionService.list();
        const rows = data.sort((a, b) => b.startedAt - a.startedAt);

        // An empty history used to render a blank page with a heading and nothing
        // under it, which reads as a failure rather than as "nothing yet".
        root.append(page(
            pageHead({ title: t("nav.sessions"), icon: "clock" }),
            rows.length === 0
                ? emptyState(t("home.noSessions"), { icon: "clock" })
                : list(...rows.map(sessionRow))
        ));
    }
};
