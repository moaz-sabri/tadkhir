import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { financeService } from "../../services/finance-service.js";
import { expensesByCategory } from "../../domain/finance.js";
import { FINANCE_TYPES } from "../../domain/validation.js";
import { formatMoney } from "../../domain/money.js";
import { formatDateTime } from "../../domain/time.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { financeNav } from "../components/finance-nav.js";
import { financeTransactionForm } from "../components/finance-transaction-form.js";
import { openQuickTransaction } from "../components/finance-quick-add.js";
import { financeTransactionRow } from "../components/finance-transaction-row.js";
import { categoryLabel } from "../components/finance-fields.js";
import { categoryService } from "../../services/category-service.js";
import { takeShare, sharePrefill } from "../../app/share-payload.js";
import { bus } from "../../app/bus.js";
import { toast } from "../components/toast.js";
import { dialog } from "../components/dialog.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    emptyState,
    action,
    backTo,
    toolbar,
    notFoundView
} from "../components/ui.js";
import { searchField, selectControl } from "../components/fields.js";

const BASE = "/finance/transactions";

export const transactionsPage = {
    title: () => t("finance.transactions"),
    async mount(root) {
        // The router matches paths only — there is no query string to carry a
        // filter in — so the search box and the category filter are page state
        // and every re-read goes back through the service.
        const filters = { query: "", category: null };
        let renderSeq = 0;

        // The same search control the task list uses: a magnifier inside the field
        // and a clear button, built by one function. The two screens used to have
        // two hand-written copies of a bare input whose only label was its own
        // placeholder.
        const { element: searchBox, input: query } = searchField(t("finance.searchPlaceholder"));
        const category = selectControl({
            options: [{ value: "", label: t("finance.allCategories") }],
            value: "",
            ariaLabel: t("finance.category")
        });
        const totalsBox = h("div", { class: "chips" });
        const listBox = h("div", { class: "list" });

        // The filter is built from the categories store, not from a constant
        // list, so a category the user adds shows up here without a reload.
        const categories = await categoryService.list();
        category.select.replaceChildren(
            h("option", { value: "" }, t("finance.allCategories")),
            ...categories.map(c => h("option", { value: c.id }, categoryLabel(c.id)))
        );

        const render = async () => {
            // Read the search scope once, then narrow by category in place: the
            // totals must stay visible while a category is selected, otherwise
            // the chips that set the filter would disappear with it.
            const seq = ++renderSeq;
            const scope = await financeService.listTransactions({ query: filters.query });
            // Two keystrokes can have two reads in flight at once, and they do
            // not finish in order. The older one is dropped here rather than
            // painting a list and a set of totals from a query the user has
            // already typed past.
            if (seq !== renderSeq) return;
            const rows = filters.category
                ? scope.filter(x => (x.category ?? null) === filters.category)
                : scope;

            if (rows.length === 0) {
                listBox.replaceChildren(emptyState(
                    scope.length === 0 && !filters.query
                        ? t("finance.noTransactions")
                        : t("finance.noResults"),
                    { icon: "note" }
                ));
            } else {
                listBox.replaceChildren(list(...rows.map(record => financeTransactionRow(record, {
                    onDelete: async () => {
                        if (!await dialog.confirm("finance.deleteConfirm")) return;
                        try {
                            await financeService.removeTransaction(record.id);
                            await render();
                        } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                }))));
            }

            // Tapping a total filters by that category; tapping the selected
            // one clears the filter again.
            const totals = expensesByCategory(scope);
            const currency = scope.find(x => x.currency)?.currency ?? null;
            totalsBox.replaceChildren(...totals.map(x => h("button", {
                class: "btn",
                "aria-pressed": filters.category === x.category ? "true" : "false",
                onClick: () => {
                    filters.category = filters.category === x.category ? null : x.category;
                    category.select.value = filters.category ?? "";
                    render();
                }
            }, t("finance.categoryTotal", {
                category: categoryLabel(x.category),
                amount: formatMoney(x.amount, currency)
            }))));
            totalsBox.hidden = totals.length === 0;
        };

        // Typing is debounced: one read per pause rather than one per keystroke,
        // which is both cheaper and the reason two reads can no longer interleave.
        let searchTimer = null;
        query.addEventListener("input", () => {
            filters.query = query.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { render().catch(() => {}); }, 180);
        });
        category.select.addEventListener("change", () => {
            filters.category = category.select.value || null;
            clearTimeout(searchTimer);
            render().catch(() => {});
        });
        // Bumped on the way out, which makes any read still in flight a no-op, and
        // the pending debounce is dropped rather than left to resolve into a
        // container the router has already detached.
        const offRoute = bus.on("route", () => {
            renderSeq++;
            clearTimeout(searchTimer);
        });

        // The two ways to add one here, and the same pair the corner button and
        // /quick offer: the direction is the thing the BUTTON knows, and the form
        // does not ask (see finance-quick-add.js). Two controls where there was one
        // "new", because a list whose only add action cannot say which kind of
        // record it makes is a list that has to ask afterwards.
        //
        // `render()` and not a re-mount: this screen's search box and category
        // filter are page state, and a write must not clear the scope the person set
        // up. A dismissed dialog wrote nothing, so it redraws nothing.
        const add = type => action({
            label: t(type === "income" ? "home.addIncome" : "home.addExpense"),
            icon: MONEY_ICON_NAMES[type],
            onClick: async () => {
                if (await openQuickTransaction({ type })) await render();
            }
        });

        root.append(page(
            pageHead({
                title: t("finance.transactions"),
                icon: "note",
                actions: [add("income"), add("expense")]
            }),
            financeNav(BASE),
            h("div", { class: "toolbar" }, searchBox, category.element),
            pageSection({ title: t("finance.byCategory"), icon: "tag", body: totalsBox }),
            listBox
        ));

        await render();
        this.dispose = offRoute;
    },

    unmount() {
        this.dispose?.();
        this.dispose = null;
    }
};

export const newTransaction = {
    // The heading follows the direction when the caller supplied one, so arriving
    // from the share chooser reads "New income" rather than the neutral label
    // the same screen shows when no direction was chosen.
    title: params => (FINANCE_TYPES.includes(params?.type)
        ? t("finance.newTransactionOf", { type: t(`finance.${params.type}Type`) })
        : t("finance.newTransaction")),
    // A DIALOG, and nothing else on screen.
    //
    // The route stays because something points at it: every launcher shortcut in
    // the manifest is an address, and `/quick?do=income` opens this one by type.
    // What changed is what it draws — a form on a page said "you will be here for
    // a while" and asked six questions to record one number, three of which the
    // address had already answered.
    //
    // So the route presents the dialog and navigates back to the list either way,
    // which is also what makes the browser's Back button do the obvious thing: it
    // returns to the list the dialog was opened from.
    async mount(root, params) {
        // The home screen and the share chooser both link straight here with the
        // direction already chosen (/finance/transactions/new/income), so the
        // direction is read here and never asked for. `params.type` comes from the
        // `:type` segment of that route; the bare /new — an address that names no
        // direction at all, which nothing in the app links to any more — falls back
        // to expense.
        const type = FINANCE_TYPES.includes(params?.type) ? params.type : "expense";

        // A share that chose "income" or "expense" leaves its text parked here.
        // It becomes the title and is then consumed, so returning to this form
        // does not refill it and a reload cannot replay the share.
        const shared = takeShare();
        const prefill = sharePrefill(shared);

        root.replaceChildren();
        await openQuickTransaction({ type, title: prefill });
        router.navigate(BASE);
    }
};

export const transactionDetail = {
    title: () => t("finance.editTransaction"),
    async mount(root, params) {
        let record;
        try {
            record = await financeService.getTransaction(params.id);
        } catch {
            record = null;
        }
        if (!record) {
            notFoundView(root);
            return;
        }

        const form = await financeTransactionForm(record, async patch => {
            try {
                await financeService.updateTransaction(record.id, patch);
                router.refresh();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        });

        root.append(page(
            pageHead({
                title: record.title,
                icon: record.type === "income" ? "moneyIn" : "moneyOut",
                leading: backTo(BASE)
            }),
            h("p", { class: "muted" }, formatDateTime(record.occurredAt)),
            // A transaction produced by "mark as paid" keeps a link to its rule,
            // so the two views are connected and the link survives an edit.
            record.recurringId
                ? h("p", { class: "muted" },
                    action({
                        label: t("finance.recurring"),
                        icon: "repeat",
                        href: `/finance/recurring/${record.recurringId}`
                    }))
                : null,
            pageSection({ body: form }),
            toolbar(action({
                label: t("common.delete"),
                icon: "trash",
                tone: "danger",
                onClick: async () => {
                    if (!await dialog.confirm("finance.deleteConfirm")) return;
                    try {
                        await financeService.removeTransaction(record.id);
                        router.navigate(BASE);
                    } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                }
            }))
        ));
    }
};
