import { t } from "../../i18n/i18n.js";
import { financeService } from "../../services/finance-service.js";
import { formatMoney } from "../../domain/money.js";
import { financeNav } from "../components/finance-nav.js";
import { financeTransactionRow } from "../components/finance-transaction-row.js";
import { categoryLabel, financeDueLabel } from "../components/finance-fields.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    listRow,
    emptyState,
    badge,
    action,
    statPanel,
    stat
} from "../components/ui.js";

// The Finance landing page. Deliberately totals, not analysis: this month in,
// this month out, what is due next, what is still owed, and the last few
// records. No charts, no trends, no forecasts.
export const financePage = {
    title: () => t("nav.finance"),
    async mount(root) {
        const [data, debts] = await Promise.all([
            financeService.overview(),
            financeService.listDebts()
        ]);
        const currency = data.currency ?? null;

        const open = debts.filter(d => !d.settled);
        // Takes the direction VALUE, not a debt — which is how the debts screen
        // already read it. The overview's copy took a debt and was called with a
        // direction, so `d.direction` was always undefined and every row on this
        // screen said "I owe" whatever it actually was. Two helpers with one name
        // and two signatures is exactly the kind of drift the shared kit exists to
        // stop, and it is why this one is now written down as a rule.
        const directionLabel = direction => t(`finance.${direction === "owed_to_me" ? "owedToMe" : "owedByMe"}`);

        // The four figures the screen is about, as stat cells with a glyph each —
        // the same component the reports and task screens use. It used to be four
        // grey sentences with the label and the value run together by a colon,
        // which is the one thing a number panel should never do: a figure that
        // cannot be told apart from its own label at a glance.
        const summary = statPanel(
            stat({ label: t("finance.income"), value: formatMoney(data.income, currency), icon: "moneyIn" }),
            stat({ label: t("finance.expenses"), value: formatMoney(data.expenses, currency), icon: "moneyOut" }),
            stat({ label: t("finance.owedByMe"), value: formatMoney(data.debts.owedByMe, currency), icon: "owedByMe" }),
            stat({ label: t("finance.owedToMe"), value: formatMoney(data.debts.owedToMe, currency), icon: "owedToMe" })
        );

        const upcoming = data.upcoming.length
            ? list(...data.upcoming.map(({ recurring, dueAt }) => listRow({
                href: `/finance/recurring/${recurring.id}`,
                icon: "repeat",
                title: recurring.title,
                meta: [
                    badge(financeDueLabel(dueAt), { icon: "calendar" }),
                    badge(formatMoney(recurring.amount, recurring.currency ?? currency))
                ]
            })))
            : emptyState(t("finance.noRecurring"), { icon: "repeat" });

        const debtList = open.length
            ? list(...open.map(d => listRow({
                href: `/finance/debts/${d.id}`,
                icon: d.direction === "owed_to_me" ? "owedToMe" : "owedByMe",
                title: d.person ? `${d.title} · ${d.person}` : d.title,
                meta: [
                    badge(directionLabel(d.direction)),
                    badge(`${formatMoney(d.remaining, d.currency ?? currency)} / ${formatMoney(d.amount, d.currency ?? currency)}`)
                ]
            })))
            : emptyState(t("finance.noDebts"), { icon: "scale" });

        const categories = data.categories.length
            ? list(...data.categories.map(x => listRow({
                href: "/finance/transactions",
                icon: "tag",
                title: categoryLabel(x.category),
                meta: [badge(formatMoney(x.amount, currency))]
            })))
            : emptyState(t("finance.noTransactions"), { icon: "tag" });

        const recent = data.recent.length
            ? list(...data.recent.map(record => financeTransactionRow(record)))
            : emptyState(t("finance.noTransactions"), { icon: "note" });

        root.append(page(
            pageHead({
                title: t("nav.finance"),
                icon: "wallet",
                actions: action({ label: t("finance.newTransaction"), icon: "plus", tone: "primary", href: "/finance/transactions/new" })
            }),
            financeNav("/finance/transactions"),
            summary,
            pageSection({
                title: t("finance.upcoming"),
                icon: "repeat",
                action: action({ label: t("finance.newRecurring"), icon: "plus", href: "/finance/recurring/new" }),
                body: upcoming
            }),
            pageSection({
                title: t("finance.debts"),
                icon: "scale",
                action: action({ label: t("finance.newDebt"), icon: "plus", href: "/finance/debts/new" }),
                body: debtList
            }),
            pageSection({
                title: `${t("finance.thisMonth")} · ${t("finance.byCategory")}`,
                icon: "tag",
                action: action({ label: t("finance.transactions"), icon: "forward", href: "/finance/transactions" }),
                body: categories
            }),
            pageSection({
                title: t("finance.recent"),
                icon: "history",
                action: action({ label: t("finance.transactions"), icon: "forward", href: "/finance/transactions" }),
                body: recent
            })
        ));
    }
};
