import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { financeService } from "../../services/finance-service.js";
import { nextDueAt, paymentsByRecurring, sumByType } from "../../domain/finance.js";
import { formatMoney } from "../../domain/money.js";
import { formatDateTime } from "../../domain/time.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { financeNav } from "../components/finance-nav.js";
import { financeRecurringForm } from "../components/finance-recurring-form.js";
import { openQuickRecurring } from "../components/finance-quick-add.js";
import { categoryLabel, financeDueLabel } from "../components/finance-fields.js";
import { toast } from "../components/toast.js";
import { dialog } from "../components/dialog.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    listRow,
    rowAction,
    emptyState,
    badge,
    action,
    backTo,
    toolbar,
    statPanel,
    stat,
    notFoundView
} from "../components/ui.js";

const BASE = "/finance/recurring";

export const recurringPage = {
    title: () => t("finance.recurring"),
    async mount(root) {
        const [items, transactions] = await Promise.all([
            financeService.listRecurring({ includeDisabled: true }),
            financeService.listTransactions()
        ]);
        const history = paymentsByRecurring(transactions);

        // A rule's history is its linked transactions, so the list can show a
        // real "next due" and a real total paid without a second store.
        const rows = items.map(r => {
            const payments = history.get(r.id) || [];
            return {
                recurring: r,
                dueAt: nextDueAt(r, payments),
                paid: sumByType(payments, r.type),
                count: payments.length
            };
        }).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.recurring.title.localeCompare(b.recurring.title));

        // Two "add" buttons rather than one, and the reason is the same on every
        // list that can record money: the direction is in the BUTTON. The dialog
        // asks for a title, an amount and how often — see finance-quick-add.js.
        //
        // `router.refresh()` rather than a local re-read: this screen reads four
        // stores once at mount and has no page state worth keeping, so re-mounting
        // it is the whole of "show the new rule", and it is the one call every
        // screen makes after a write.
        const add = type => action({
            label: t(type === "income" ? "home.addIncome" : "home.addExpense"),
            icon: MONEY_ICON_NAMES[type],
            onClick: async () => {
                if (await openQuickRecurring({ type })) router.refresh();
            }
        });

        root.append(page(
            pageHead({
                title: t("finance.recurring"),
                icon: "repeat",
                actions: [add("income"), add("expense")]
            }),
            financeNav(BASE),
            rows.length === 0
                ? emptyState(t("finance.noRecurring"), {
                    icon: "repeat",
                    action: toolbar(add("income"), add("expense"))
                })
                : list(...rows.map(({ recurring, dueAt, paid, count }) => listRow({
                    href: `${BASE}/${recurring.id}`,
                    icon: recurring.type === "income" ? "moneyIn" : "moneyOut",
                    title: recurring.title,
                    meta: [
                        badge(formatMoney(recurring.amount, recurring.currency)),
                        badge(t(`finance.${recurring.frequency}`), { icon: "calendar" }),
                        badge(financeDueLabel(dueAt), { icon: "bell" }),
                        count > 0 ? badge(`${t("finance.paid")}: ${formatMoney(paid, recurring.currency)} · ${count}`) : null,
                        // A disabled rule is a state, not a fact about the money,
                        // so it is dimmed on the row instead of a second word.
                        recurring.active ? null : badge(t("finance.disabled"), { tone: "danger" })
                    ].filter(Boolean)
                })))
        ));
    }
};

export const newRecurring = {
    title: () => t("finance.newRecurring"),
    // A dialog and nothing else on screen; the route stays because something points
    // at it (a bookmark, and the addresses in the manifest). The type is the one
    // thing this address does not carry — there is no /new/:type route — so it falls
    // back to expense, and the two buttons at the top of the list are the way the
    // app itself gets here. See newTransaction for why these are dialogs.
    async mount(root) {
        root.replaceChildren();
        await openQuickRecurring();
        router.navigate(BASE);
    }
};

export const recurringDetail = {
    title: () => t("finance.editRecurring"),
    async mount(root, params) {
        const render = async () => {
            let data;
            try {
                data = await financeService.getRecurring(params.id);
            } catch {
                data = null;
            }
            if (!data) {
                notFoundView(root);
                return;
            }
            const { recurring, payments, dueAt } = data;
            const currency = recurring.currency;
            const nothingDue = dueAt == null;
            const paidTotal = payments.reduce((sum, p) => sum + p.amount, 0);

            const fail = e => toast.show(`error.${e?.code || "unexpected"}`);

            const form = await financeRecurringForm(recurring, async patch => {
                try {
                    await financeService.updateRecurring(recurring.id, patch);
                    await render();
                } catch (e) { fail(e); }
            });

            const history = payments.length
                ? list(...payments.map(p => listRow({
                    href: `/finance/transactions/${p.id}`,
                    icon: "note",
                    title: formatDateTime(p.occurredAt),
                    meta: [badge(formatMoney(p.amount, p.currency ?? currency))],
                    actions: [rowAction({ label: t("finance.editTransaction"), icon: "forward", href: `/finance/transactions/${p.id}` })]
                })))
                : emptyState(t("finance.noPayments"), { icon: "note" });

            root.replaceChildren(page(
                pageHead({
                    title: recurring.title,
                    icon: recurring.type === "income" ? "moneyIn" : "moneyOut",
                    leading: backTo(BASE)
                }),
                financeNav(BASE),
                statPanel(
                    stat({ label: t("finance.next"), value: financeDueLabel(dueAt), icon: "calendar" }),
                    stat({ label: t("finance.frequency"), value: t(`finance.${recurring.frequency}`), icon: "repeat" }),
                    stat({ label: t("finance.paid"), value: formatMoney(paidTotal, currency), icon: "check" }),
                    stat({
                        label: t("finance.category"),
                        value: recurring.category ? categoryLabel(recurring.category) : t("finance.categories.none"),
                        icon: "tag"
                    })
                ),
                toolbar(
                    // "Mark as paid" writes a real transaction dated on the due
                    // day; "Skip" only advances the schedule. Neither
                    // pre-generates anything.
                    action({
                        label: t("finance.markPaid"),
                        icon: "check",
                        tone: "primary",
                        disabled: !recurring.active || nothingDue,
                        onClick: async () => {
                            try { await financeService.markRecurringPaid(recurring.id); await render(); }
                            catch (e) { fail(e); }
                        }
                    }),
                    action({
                        label: t("finance.skip"),
                        icon: "skip",
                        disabled: nothingDue,
                        onClick: async () => {
                            try { await financeService.skipRecurring(recurring.id); await render(); }
                            catch (e) { fail(e); }
                        }
                    }),
                    action({
                        label: recurring.active ? t("finance.disable") : t("finance.enable"),
                        icon: recurring.active ? "pause" : "play",
                        onClick: async () => {
                            try { await financeService.setRecurringActive(recurring.id, !recurring.active); await render(); }
                            catch (e) { fail(e); }
                        }
                    }),
                    action({
                        label: t("common.delete"),
                        icon: "trash",
                        tone: "danger",
                        onClick: async () => {
                            if (!await dialog.confirm("finance.deleteRecurringConfirm")) return;
                            try { await financeService.removeRecurring(recurring.id); router.navigate(BASE); }
                            catch (e) { fail(e); }
                        }
                    })
                ),
                pageSection({ body: form }),
                pageSection({ title: t("finance.payments"), icon: "history", body: history })
            ));
        };

        await render();
    }
};
