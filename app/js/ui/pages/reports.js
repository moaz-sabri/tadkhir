import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { reportService } from "../../services/report-service.js";
import { formatMoney, formatSignedMoney } from "../../domain/money.js";
import { formatDate, formatShort } from "../../domain/time.js";
import { REPORT_PERIODS } from "../../domain/analytics.js";
import {
    page,
    pageHead,
    cardGrid,
    card,
    sectionTitle,
    statGrid,
    stat,
    list,
    listRow,
    badge
} from "../components/ui.js";
import { selectControl, caption } from "../components/fields.js";
import { counterRatio } from "../components/routine-row.js";

// Reports are numbers: no table, no chart, no derived series, and nothing stored.
// Every figure is read straight from the report service, which derives it on
// demand from the records that exist right now — so nothing shown here can drift
// away from the lists it was computed from.
//
// This screen is where the figures the home screen deliberately does NOT carry
// live. The home screen is a glance at now, and everything that only makes sense
// in aggregate — a fortnight of bars, a day streak, a week average, what a period
// adds up to — is here. One place holds a summary, so there is one place for it to
// be right or wrong.
//
// The one card with rows in it is the routines' activity, and those rows are
// numbers too: which routine, how long, how many times. It is a log of what
// happened and not a plan of what should have, so it can hold no expectation, no
// missed day and no percentage — see routineCard().
export const reportsPage = {
    title: () => t("reports.title"),

    async mount(root) {
        const body = h("div", { class: "card-grid" });

        // The period is page state, not a URL: the router matches paths only,
        // so re-reading it would lose the selection.
        let period = "month";

        // The period picker is the app's select control, in the page header's
        // action slot — the same slot a "New" button occupies on other screens,
        // because it is the one thing you can change about this screen.
        const { select, element } = selectControl({
            options: REPORT_PERIODS.map(p => ({ value: p, label: t(`reports.period_${p}`) })),
            value: period,
            ariaLabel: t("reports.period")
        });
        select.addEventListener("change", () => {
            period = select.value;
            this.render(body, period);
        });

        root.append(page(
            pageHead({
                title: t("reports.title"),
                icon: "chart",
                actions: h("label", { class: "head-filter" },
                    caption(t("reports.period")),
                    element
                )
            }),
            body
        ));

        await this.render(body, period);
    },

    async render(body, period) {
        const [summary, usage] = await Promise.all([
            reportService.summary(period),
            reportService.usage()
        ]);
        const currency = summary.currency;

        // A window with nothing in it is a real answer, not an error, so the
        // figures are still shown — at zero. Only the "all time" window has no
        // start to describe.
        const periodLine = summary.from
            ? h("p", { class: "muted small" },
                t("reports.periodInfo", {
                    from: formatDate(summary.from),
                    to: formatDate(Date.now())
                }))
            : null;

        // A zero is a real measurement here, so it is shown as 0 and never as the
        // "no data" dash that would hide an empty period.
        body.replaceChildren(
            card(
                sectionTitle(t("reports.time"), { icon: "clock" }),
                statGrid(
                    stat({ label: t("reports.totalTime"), value: formatShort(summary.totalMs), icon: "clock" }),
                    stat({ label: t("reports.sessionCount"), value: summary.count, icon: "history" }),
                    stat({ label: t("reports.completedTasks"), value: summary.completedTasks, icon: "check" }),
                    stat({ label: t("reports.avgSession"), value: formatShort(reportService.averageSessionMs(summary)), icon: "target" })
                ),
                periodLine
            ),
            card(
                sectionTitle(t("reports.money"), { icon: "wallet" }),
                statGrid(
                    stat({ label: t("reports.totalIncome"), value: formatMoney(summary.income, currency), icon: "moneyIn" }),
                    stat({ label: t("reports.totalExpenses"), value: formatMoney(summary.expenses, currency), icon: "moneyOut" }),
                    // Signed, because a net that prints its absolute value turns a
                    // loss into a gain — see formatSignedMoney in domain/money.js.
                    stat({ label: t("reports.net"), value: formatSignedMoney(summary.net, currency), icon: "scale" })
                )
            ),
            // Debt balances are all-time on purpose: "what do I still owe" is a
            // balance, and slicing it by the selected period would answer a
            // question nobody asked. The label says so.
            card(
                sectionTitle(t("reports.debts"), { icon: "scale" }),
                statGrid(
                    stat({ label: t("reports.owedByMe"), value: formatMoney(summary.debts.owedByMe, currency), icon: "owedByMe" }),
                    stat({ label: t("reports.owedToMe"), value: formatMoney(summary.debts.owedToMe, currency), icon: "owedToMe" }),
                    stat({ label: t("reports.debtNet"), value: formatSignedMoney(summary.debts.net, currency), icon: "scale" }),
                    stat({ label: t("reports.openDebts"), value: summary.debts.open, icon: "scale" })
                ),
                h("p", { class: "muted small" }, t("reports.debtsAllTime"))
            ),
            card(
                sectionTitle(t("reports.usage"), { icon: "tasks" }),
                statGrid(
                    stat({ label: t("reports.activeDays"), value: usage.activeDays7, icon: "calendar" }),
                    stat({ label: t("reports.openTasks"), value: summary.openTasks, icon: "tasks" }),
                    stat({ label: t("reports.totalTasks"), value: summary.totalTasks, icon: "check" })
                )
            ),
            this.routineCard(summary.routine)
        );
    },

    /**
     * What the repeated activities actually produced, and nothing else.
     *
     * This is a LOG, not a scoreboard, and that is the whole design of the card.
     * There is no expected column beside the real one, no missed day and no
     * adherence percentage — a routine is something the user chooses to repeat,
     * and a day they did not repeat is not a debt they owe the app. So a routine
     * with nothing in the window is left out completely rather than shown at
     * zero: the card is about things that happened, and an empty window says so
     * in a sentence.
     *
     * A timed routine's time is read from the sessions it produced, which are
     * counted in the "Time" card above as well — deliberately the same number
     * from the same records, so the two cards cannot disagree and cannot add up to
     * more time than was spent.
     */
    routineCard(activity) {
        const rows = activity.routines.map(r => listRow({
            icon: r.kind === "counter" ? "target" : "clock",
            title: r.title,
            meta: r.kind === "counter"
                ? [
                    badge(counterRatio(r.count, r.target), { icon: "target" }),
                    badge(daysPhrase(r.days), { icon: "calendar" })
                ]
                : [
                    badge(formatShort(r.totalMs), { icon: "clock" }),
                    badge(runsPhrase(r.runs), { icon: "check" })
                ]
        }));

        return card(
            sectionTitle(t("reports.routineActivity"), { icon: "repeat" }),
            statGrid(
                stat({ label: t("reports.routineTime"), value: formatShort(activity.totalMs), icon: "clock" }),
                stat({ label: t("reports.routineRuns"), value: activity.runs, icon: "check" }),
                stat({ label: t("reports.routineCounterDays"), value: activity.counterDays, icon: "calendar" })
            ),
            rows.length ? list(...rows) : h("p", { class: "muted small" }, t("reports.routineNone"))
        );
    }
};

// A count with a noun, and the substitution layer has no plural rules — so the
// singular is its own key rather than "1 runs". Same rule the attachment counts
// follow, and for the same reason.
const runsPhrase = n => (n === 1
    ? t("reports.routineRunsOne")
    : t("reports.routineRuns", { count: n }));

const daysPhrase = n => (n === 1
    ? t("reports.routineDaysOne")
    : t("reports.routineDays", { count: n }));
