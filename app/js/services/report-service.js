import { withTx } from "../data/db.js";
import { reader } from "../data/stores.js";
import { reportSummary, homeGlance, activeDays, averageSessionMs } from "../domain/analytics.js";

// One reader per store this file touches, and the list is deliberately NOT
// narrowed to the glance: `summary` below reads debts and debt payments for the
// reports, and the glance now reads them too — but narrowing the list to what
// one caller happens to want is how `summary` ended up calling an undefined
// name, and it is a failure the test suite cannot see, because the reports page
// is only reachable by navigating to it.
const tasks = reader("task");
const sessions = reader("session");
const transactions = reader("transaction");
const debts = reader("debt");
const payments = reader("debtPayment");
const recurring = reader("recurring");
const later = reader("later");
const routines = reader("routine");
const routineLogs = reader("routineLog");
const pages = reader("page");

// Reports are read-only. This service exists only to gather the records in one
// transaction and hand them to the pure aggregation in domain/analytics.js —
// there is no report record, nothing is written, and no report syncs anywhere.
export const reportService = {
    async summary(period = "month", now = Date.now()) {
        // Routines and their days are read here, in the same transaction, for the
        // same reason every other store on this line is: the figures this screen
        // shows side by side have to come from one snapshot, and a run finished
        // between two reads would put a routine's time and the day's total in
        // different moments. The sessions are already here — a timed routine's
        // proof is a session — so attributing it costs no extra read at all.
        const data = await withTx(
            ["tasks", "sessions", "transactions", "debts", "debtPayments", "routines", "routineLogs"],
            "readonly",
            async r => ({
                tasks: await tasks(r).getAll(),
                sessions: await sessions(r).getAll(),
                transactions: await transactions(r).getAll(),
                debts: await debts(r).getAll(),
                debtPayments: await payments(r).getAll(),
                routines: await routines(r).getAll(),
                routineLogs: await routineLogs(r).getAll()
            })
        );
        return reportSummary(data, period, now);
    },

    // The small "how have I been using this" indicator, which needs the
    // sessions read again — kept apart so the page does not ask twice.
    async usage(now = Date.now()) {
        const all = await withTx(["sessions"], "readonly", r => sessions(r).getAll());
        return { activeDays7: activeDays(all, 7, now) };
    },

    /**
     * The home screen's figures, gathered in ONE transaction.
     *
     * The home screen is the only screen that shows a slice of every store at
     * once, and reading them one service at a time would mean nine
     * transactions, nine different moments, and two numbers side by side that
     * could disagree because one was read a second after the other. One
     * transaction, one snapshot, one derivation.
     *
     * The debts and their payments are on it, and they were not: a debt is a
     * BALANCE and not a flow, which is why the home screen used to leave them to
     * Finance. It reports them now because "how much do I owe" is not a summary
     * of the month — it is the one figure on this screen the person is carrying
     * in their head, and a month that ends with three zeroes beside it is the
     * easier half of the story. Two more stores on an already-open transaction,
     * and the derivation is the same one Finance and Reports already use
     * (debtBalance), so the three cannot disagree about it.
     */
    async glance(now = Date.now()) {
        const data = await withTx(
            ["tasks", "sessions", "transactions", "recurring", "later", "routines", "pages", "debts", "debtPayments"],
            "readonly",
            async r => ({
                tasks: await tasks(r).getAll(),
                sessions: await sessions(r).getAll(),
                transactions: await transactions(r).getAll(),
                recurring: await recurring(r).getAll(),
                later: await later(r).getAll(),
                routines: await routines(r).getAll(),
                pages: await pages(r).getAll(),
                debts: await debts(r).getAll(),
                debtPayments: await payments(r).getAll()
            })
        );
        return homeGlance(data, now);
    },

    averageSessionMs
};
