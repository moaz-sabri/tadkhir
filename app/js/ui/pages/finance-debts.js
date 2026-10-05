import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { financeService } from "../../services/finance-service.js";
import { formatMoney } from "../../domain/money.js";
import { formatDate, formatDateTime } from "../../domain/time.js";
import { financeNav } from "../components/finance-nav.js";
import { financeDebtForm } from "../components/finance-debt-form.js";
import { openQuickDebt } from "../components/finance-quick-add.js";
import { financeDebtPaymentForm } from "../components/finance-debt-payment-form.js";
import { categoryLabel } from "../components/finance-fields.js";
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
    statGrid,
    statPanel,
    stat,
    notFoundView
} from "../components/ui.js";

const BASE = "/finance/debts";

// Takes the direction VALUE, not a debt. The Finance overview's copy of this
// helper took a debt and was called with a direction, so it never resolved
// anything and every row on that screen read "I owe" — same name, two
// signatures, two different answers.
const directionLabel = direction => t(`finance.${direction === "owed_to_me" ? "owedToMe" : "owedByMe"}`);

export const debtsPage = {
    title: () => t("finance.debts"),
    async mount(root) {
        const groups = await financeService.listDebtsByPerson();

        // Grouped by person, not by record: the question this screen answers is
        // "what do I have with Sam", and the per-direction totals are derived in
        // the service so the page never does arithmetic. The service already
        // drops empty groups.
        // Two "add" buttons, one per side of the money, because the side is the
        // thing the BUTTON says and the dialog does not ask (see
        // finance-quick-add.js). The words are the directions rather than "add a
        // debt" twice: two identically-labelled buttons that differ only in an icon
        // are a coin toss with a label on it.
        const add = direction => action({
            label: t(direction === "owed_to_me" ? "finance.owedToMe" : "finance.owedByMe"),
            icon: direction === "owed_to_me" ? "owedToMe" : "owedByMe",
            onClick: async () => {
                if (await openQuickDebt({ direction })) router.refresh();
            }
        });

        const body = groups.length === 0
            ? emptyState(t("finance.noDebts"), {
                icon: "scale",
                action: toolbar(add("owed_to_me"), add("owed_by_me"))
            })
            : list(...groups.map(group => {
                // A group can mix currencies in principle, so the header sums
                // are rendered in the currency of the records they came from
                // rather than a hardcoded default.
                const currency = group.debts.find(d => d.currency)?.currency;
                return h("section", { class: "section" },
                    pageSection({
                        title: group.name || t("finance.people.personNone"),
                        icon: "person",
                        action: group.missing
                            ? badge(t("finance.people.missingPerson"), { icon: "warning" })
                            : null,
                        body: h("div", {},
                            // The per-person totals only when they add something:
                            // with one debt the single row underneath already says
                            // the direction and the remaining/total pair, and a
                            // one-figure panel above it is a mostly-empty card
                            // repeating the same two numbers.
                            group.debts.length > 1
                                ? statGrid(
                                    group.owedByMe
                                        ? stat({ label: t("finance.owedByMe"), value: formatMoney(group.owedByMe, currency), icon: "owedByMe" })
                                        : null,
                                    group.owedToMe
                                        ? stat({ label: t("finance.owedToMe"), value: formatMoney(group.owedToMe, currency), icon: "owedToMe" })
                                        : null
                                )
                                : null,
                            list(...group.debts.map(d => listRow({
                                href: `${BASE}/${d.id}`,
                                icon: d.direction === "owed_to_me" ? "owedToMe" : "owedByMe",
                                title: d.title,
                                meta: [
                                    badge(directionLabel(d.direction)),
                                    d.dueAt ? badge(t("finance.dueOn", { date: formatDate(d.dueAt) }), { icon: "calendar" }) : null,
                                    badge(`${formatMoney(d.remaining, d.currency)} / ${formatMoney(d.amount, d.currency)}`),
                                    d.settled ? badge(t("finance.settled"), { icon: "check" }) : null
                                ].filter(Boolean)
                            })))
                        )
                    })
                );
            }));

        root.append(page(
            pageHead({
                title: t("finance.debts"),
                icon: "scale",
                actions: [add("owed_to_me"), add("owed_by_me")]
            }),
            financeNav(BASE),
            body
        ));
    }
};

export const newDebt = {
    title: () => t("finance.newDebt"),
    // A dialog and nothing else on screen; the route stays because a bookmark can
    // point at it. The side of the money is the one thing this address does not
    // carry — there is no /new/:direction route — so it falls back to "I owe", and
    // the two buttons at the top of the list are the way the app itself gets here.
    // See newTransaction for why these are dialogs.
    async mount(root) {
        root.replaceChildren();
        await openQuickDebt({ direction: null });
        router.navigate(BASE);
    }
};

export const debtDetail = {
    title: () => t("finance.debtDetail"),
    async mount(root, params) {
        // What the payment form is working on: null = closed, "new" = adding a
        // payment, a payment id = correcting that payment. Page state, not a
        // route, so the form can sit next to the totals and re-render them the
        // moment a payment lands.
        let mode = null;

        const render = async () => {
            let data;
            try {
                data = await financeService.getDebt(params.id);
            } catch {
                data = null;
            }
            if (!data) {
                notFoundView(root);
                return;
            }
            const { debt, payments, paid, remaining, settled } = data;
            const currency = debt.currency;
            const fail = e => toast.show(`error.${e?.code || "unexpected"}`);

            // A payment that was deleted while the form was open simply closes
            // the form again; the totals are re-read either way.
            const editing = mode && mode !== "new"
                ? payments.find(p => p.id === mode) || null
                : null;
            if (mode && mode !== "new" && !editing) mode = null;

            // What the open form may submit: what is still owed, plus this
            // payment's own amount when an existing one is being corrected.
            const ceiling = editing ? remaining + editing.amount : remaining;

            // The payment form opens in place instead of navigating away, so
            // the totals above it update on the spot.
            const save = async patch => {
                try {
                    if (editing) await financeService.updateDebtPayment(editing.id, patch);
                    else await financeService.addDebtPayment(debt.id, patch);
                    mode = null;
                    await render();
                } catch (e) { fail(e); }
            };
            const formBox = h("div", { hidden: !mode },
                mode ? financeDebtPaymentForm(debt, { ceiling, remaining }, save, { payment: editing }) : null);

            const addPayment = action({
                label: mode ? t("common.cancel") : t("finance.addPayment"),
                icon: mode ? "close" : "plus",
                tone: mode ? "" : "primary",
                disabled: settled,
                onClick: () => { mode = mode ? null : "new"; render(); }
            });

            const paymentList = payments.length
                ? list(...payments.map(p => listRow({
                    icon: "note",
                    title: formatDateTime(p.occurredAt),
                    subtitle: p.note || null,
                    meta: [badge(formatMoney(p.amount, currency))],
                    actions: [
                        rowAction({
                            label: t("finance.editPayment"),
                            icon: "pencil",
                            onClick: () => { mode = mode === p.id ? null : p.id; render(); }
                        }),
                        rowAction({
                            label: t("common.delete"),
                            icon: "trash",
                            onClick: async () => {
                                if (!await dialog.confirm("finance.deletePaymentConfirm")) return;
                                try {
                                    await financeService.removeDebtPayment(p.id);
                                    if (mode === p.id) mode = null;
                                    await render();
                                } catch (e) { fail(e); }
                            }
                        })
                    ]
                })))
                : emptyState(t("finance.noPayments"), { icon: "note" });

            const form = await financeDebtForm(debt, async patch => {
                try {
                    await financeService.updateDebt(debt.id, patch);
                    await render();
                } catch (e) { fail(e); }
            });

            root.replaceChildren(page(
                pageHead({
                    title: debt.person ? `${debt.title} · ${debt.person}` : debt.title,
                    icon: debt.direction === "owed_to_me" ? "owedToMe" : "owedByMe",
                    leading: backTo(BASE)
                }),
                financeNav(BASE),
                statPanel(
                    stat({ label: t("finance.direction"), value: directionLabel(debt.direction), icon: "scale" }),
                    stat({ label: t("finance.original"), value: formatMoney(debt.amount, currency), icon: "moneyOut" }),
                    stat({ label: t("finance.paid"), value: formatMoney(paid, currency), icon: "check" }),
                    stat({ label: t("finance.remaining"), value: formatMoney(remaining, currency), icon: "target" }),
                    debt.dueAt
                        ? stat({ label: t("finance.dueDate"), value: formatDate(debt.dueAt), icon: "calendar" })
                        : null,
                    debt.category
                        ? stat({ label: t("finance.category"), value: categoryLabel(debt.category), icon: "tag" })
                        : null
                ),
                toolbar(
                    // Settled is a state, not a figure, so it is a badge beside
                    // the actions rather than a stat with a made-up value in it.
                    settled ? badge(t("finance.settled"), { icon: "check" }) : null,
                    addPayment,
                    action({
                        label: t("common.delete"),
                        icon: "trash",
                        tone: "danger",
                        onClick: async () => {
                            if (!await dialog.confirm("finance.deleteDebtConfirm")) return;
                            try { await financeService.removeDebt(debt.id); router.navigate(BASE); }
                            catch (e) { fail(e); }
                        }
                    })
                ),
                formBox,
                pageSection({ body: form }),
                pageSection({ title: t("finance.payments"), icon: "history", body: paymentList })
            ));
        };

        await render();
    }
};
