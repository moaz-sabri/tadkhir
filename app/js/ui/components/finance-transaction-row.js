import { t } from "../../i18n/i18n.js";
import { formatMoney } from "../../domain/money.js";
import { formatDateTime } from "../../domain/time.js";
import { categoryLabel } from "./finance-fields.js";
import { listRow, rowAction, badge } from "./ui.js";

// One row in a transaction list. `onDelete` is omitted where a list is only a
// preview (the overview's "recent"), so the same component serves both.
export function financeTransactionRow(record, { onDelete = null } = {}) {
    return listRow({
        href: `/finance/transactions/${record.id}`,
        // The direction is the first thing a reader wants to know about a
        // movement of money, so it is a glyph on the row rather than a word in
        // the middle of it.
        icon: record.type === "income" ? "moneyIn" : "moneyOut",
        title: record.title,
        meta: [
            badge(formatDateTime(record.occurredAt), { icon: "calendar" }),
            record.category ? badge(categoryLabel(record.category), { icon: "tag" }) : null,
            badge(formatMoney(record.amount, record.currency))
        ].filter(Boolean),
        actions: onDelete
            ? [rowAction({ label: t("common.delete"), icon: "trash", onClick: onDelete })]
            : []
    });
}
