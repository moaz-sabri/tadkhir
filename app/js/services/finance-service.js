import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import {
    validateFinanceTransactionInput,
    validateFinanceRecurringInput,
    validateFinanceDebtInput,
    validateFinanceDebtPaymentInput
} from "../domain/validation.js";
import {
    createTransaction,
    createRecurring,
    createDebt,
    createDebtPayment,
    nextDueAt,
    debtTotals,
    debtTotalsById,
    assertPaymentFits,
    assertDebtExists,
    assertRecurringExists,
    sumByType,
    expensesByCategory,
    debtSummary,
    debtsByPerson,
    paymentsByRecurring,
    upcomingRecurring,
    unlinkRecurringPayments
} from "../domain/finance.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { startOfMonth } from "../domain/time.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";
import { peopleService } from "./people-service.js";

// The stores this service owns, each bound to the repo that reads it by
// data/stores.js. Two names instead of three: the service says which RECORD it
// means, and the registry knows the store to put in the transaction and the
// repo to read it with.
//
// They live under one `store` object rather than as loose consts because half
// of these are also the name of a record in scope â€” `const { recurring } =
// await getRecurring(id)` is the ordinary way this file reads a rule â€” and a
// loose reader const was shadowed by exactly that, which made the reader
// unusable inside the four methods that handle one.
const store = {
    transactions: reader("transaction"),
    recurring: reader("recurring"),
    debts: reader("debt"),
    payments: reader("debtPayment"),
    categories: reader("category"),
    people: reader("person")
};

// Finance rides the same generic record protocol as tasks, sessions and events:
// { type, id, op, data, updatedAt } against the existing outbox, push, pull,
// encryption and LWW handling. These are the type names, which data/stores.js
// binds to the stores above. No finance-specific transport.
const T_TRANSACTION = "transaction";
const T_RECURRING = "recurring";
const T_DEBT = "debt";
const T_PAYMENT = "debtPayment";

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

// Local order is never trusted across devices: every read that feeds a total
// or a list is re-sorted from the record fields.
const byOccurredDesc = (a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id);

// Categories are free text, so a record could name one that no longer exists
// (deleted on another device, or typed in an old build). Every write resolves
// the name against the categories store first: silently filing the record under
// "Other" would move money the user can see, and storing a dangling name would
// show up as a blank label later.
//
// `previous` is the value the record already held. An edit that does not touch
// the category is allowed to keep a dangling one, because that is not the user
// naming a category that does not exist â€” it is them fixing a typo in the title
// of a record that was already in that state. Without this, a stale category
// could not be removed except by clearing it on purpose, and the alternative
// that looked friendlier (the select quietly showing "No category") wiped the
// value on any save at all.
async function assertCategoryExists(r, category, previous = undefined) {
    if (!category) return;
    if (category === previous) return;
    if (await store.categories(r).get(category)) return;
    throw new ValidationError("category", "category_missing");
}

// A debt belongs to a person. The form offers "pick someone" and "type a new
// name" side by side, so a write can carry either: a personId, a bare name, or
// both. Resolving here means the caller never has to know which is which, and
// the name snapshot on the debt always matches the person it points at.
async function resolvePerson(input) {
    const { personId, person } = input;
    if (personId) {
        const record = await withTx(["people"], "readonly", r => store.people(r).get(personId));
        // A stale id (person removed on another device) keeps the debt, with
        // whatever name it already carried.
        return record ? { personId: record.id, person: record.name } : { personId, person: person ?? null };
    }
    const name = typeof person === "string" ? person.trim() : "";
    if (!name) return { personId: null, person: null };
    // An inline name that is already on file links to that person instead of
    // creating a duplicate: the same name is the same person.
    const existing = await peopleService.findByName(name);
    if (existing) return { personId: existing.id, person: existing.name };
    const created = await peopleService.create({ name });
    return { personId: created.id, person: created.name };
}


export const financeService = {
    // ------------------------------------------------------------ read side

    async listTransactions({ category = null, type = null, query = "" } = {}) {
        const q = query.trim().toLowerCase();
        // A category on its own has an index to answer it, so the store does the
        // filtering instead of loading every transaction and discarding most of
        // them. A free-text query looks inside title and note, so no index can
        // serve it: that case is still a scan, deliberately and only there.
        const byIndex = category && !q && !type;
        const rows = await withTx(["transactions"], "readonly", r => (byIndex
            ? store.transactions(r).byCategory(category)
            : store.transactions(r).getAll()));
        return rows
            .filter(t => (!category || (t.category ?? null) === category)
                && (!type || t.type === type)
                && (!q || `${t.title} ${t.note ?? ""}`.toLowerCase().includes(q)))
            .sort(byOccurredDesc);
    },

    async getTransaction(id) {
        return withTx(["transactions"], "readonly", r => store.transactions(r).get(id));
    },

    async listRecurring({ includeDisabled = false } = {}) {
        const all = await withTx(["recurring"], "readonly", r => store.recurring(r).getAll());
        return all
            .filter(r => includeDisabled || r.active)
            .sort((a, b) => a.title.localeCompare(b.title));
    },

    // A recurring item plus its payment history. The history is not stored
    // twice: it is the set of transactions that carry this recurring's id.
    async getRecurring(id) {
        const out = await withTx(["recurring", "transactions"], "readonly", async r => {
            const item = await store.recurring(r).get(id);
            if (!item) return null;
            const history = await store.transactions(r).byRecurring(id);
            return { recurring: item, payments: history.sort(byOccurredDesc) };
        });
        if (!out) throw new NotFoundError("recurring", id);
        return { ...out, dueAt: nextDueAt(out.recurring, out.payments) };
    },

    async listDebts({ direction = null } = {}) {
        const rows = await withTx(["debts", "debtPayments"], "readonly", async r => {
            // direction has an index, so a filtered list never loads the other
            // half; without one the whole store is the only option.
            const debts = direction
                ? await store.debts(r).byDirection(direction)
                : await store.debts(r).getAll();
            const allPayments = await store.payments(r).getAll();
            // One grouping pass for the whole list. Totalling debt by debt
            // walked every payment once per debt â€” 2.5 million comparisons at
            // the app's own caps, on the main thread, every time this screen
            // opened.
            const totals = debtTotalsById(debts, allPayments);
            return debts.map(debt => ({ ...debt, ...totals.get(debt.id) }));
        });
        return rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    },

    // A debt plus its payments and the derived paid/remaining figures.
    async getDebt(id) {
        const out = await withTx(["debts", "debtPayments"], "readonly", async r => {
            const debt = await store.debts(r).get(id);
            if (!debt) return null;
            const history = await store.payments(r).byDebt(id);
            return { debt, payments: history.sort(byOccurredDesc) };
        });
        if (!out) throw new NotFoundError("debt", id);
        return { ...out, ...debtTotals(out.debt, out.payments) };
    },

    // The debts screen groups by person rather than by record: "what do I have
    // with Sam" is the question, and the per-direction totals are derived here
    // so the page never does arithmetic.
    async listDebtsByPerson({ direction = null } = {}) {
        return withTx(["debts", "debtPayments", "people"], "readonly", async r => {
            const [allDebts, allPayments, people] = await Promise.all([
                store.debts(r).getAll(),
                store.payments(r).getAll(),
                store.people(r).getAll()
            ]);
            return debtsByPerson(allDebts, allPayments, people)
                .map(g => ({ ...g, debts: g.debts.filter(d => !direction || d.direction === direction) }))
                .filter(g => g.debts.length > 0);
        });
    },

    // The Finance landing view: practical totals, not analysis.
    async overview(nowTs = now()) {
        return withTx(["transactions", "recurring", "debts", "debtPayments"], "readonly", async r => {
            const all = await store.transactions(r).getAll();
            const rules = await store.recurring(r).getAll();
            const debtRows = await store.debts(r).getAll();
            const allPayments = await store.payments(r).getAll();

            const from = startOfMonth(nowTs);
            const month = all.filter(t => t.occurredAt >= from);
            const history = paymentsByRecurring(all);
            // One grouping for both figures below. This used to call
            // debtTotals() twice per debt: once for the summary, once more to
            // count the unsettled ones.
            const totals = debtTotalsById(debtRows, allPayments);

            return {
                monthFrom: from,
                income: sumByType(month, "income"),
                expenses: sumByType(month, "expense"),
                currency: month.find(t => t.currency)?.currency ?? null,
                upcoming: upcomingRecurring(rules, history, nowTs),
                debts: debtSummary(debtRows, allPayments),
                debtCount: debtRows.filter(d => !totals.get(d.id).settled).length,
                categories: expensesByCategory(month),
                // The five newest, straight off the occurredAt index â€” instead
                // of copying and sorting the whole store to keep five of them.
                recent: await store.transactions(r).recent(5)
            };
        });
    },

    // --------------------------------------------------------- transactions

    async createTransaction(input) {
        const at = now();
        const x = validateFinanceTransactionInput(input, at);
        const record = createTransaction(x, { now: at, id: crypto.randomUUID() });
        await withTx(["transactions", "categories"], "readwrite", async r => {
            await guardQuota(r, T_TRANSACTION);
            await assertCategoryExists(r, record.category);
            await store.transactions(r).put(record);
        });
        await syncService.enqueue(T_TRANSACTION, record.id, "upsert", record);
        notify();
        return record;
    },

    async updateTransaction(id, patch) {
        const at = now();
        const current = await this.getTransaction(id);
        if (!current) throw new NotFoundError("transaction", id);
        const x = validateFinanceTransactionInput({ ...current, ...patch }, at);
        // The link to a recurring item is owned by the recurring flow, not by
        // a hand edit, so it survives an update untouched.
        const record = { ...current, ...x, recurringId: current.recurringId, updatedAt: at };
        await withTx(["transactions", "categories"], "readwrite", async r => {
            await assertCategoryExists(r, record.category, current.category);
            await store.transactions(r).put(record);
        });
        await syncService.enqueue(T_TRANSACTION, id, "upsert", record);
        notify();
        return record;
    },

    async removeTransaction(id) {
        await withTx(["transactions"], "readwrite", r => store.transactions(r).delete(id));
        await syncService.enqueue(T_TRANSACTION, id, "delete", null, now());
        notify();
    },

    // ------------------------------------------------------------ recurring

    async createRecurring(input) {
        const at = now();
        const x = validateFinanceRecurringInput(input, at);
        const record = createRecurring(x, { now: at, id: crypto.randomUUID() });
        await withTx(["recurring", "categories"], "readwrite", async r => {
            await guardQuota(r, T_RECURRING);
            await assertCategoryExists(r, record.category);
            await store.recurring(r).put(record);
        });
        await syncService.enqueue(T_RECURRING, record.id, "upsert", record);
        notify();
        return record;
    },

    async updateRecurring(id, patch) {
        const at = now();
        const { recurring } = await this.getRecurring(id);
        assertRecurringExists(recurring, id);
        const x = validateFinanceRecurringInput({ ...recurring, ...patch }, at);
        const record = { ...recurring, ...x, skipped: recurring.skipped || [], updatedAt: at };
        await withTx(["recurring", "categories"], "readwrite", async r => {
            await assertCategoryExists(r, record.category, recurring.category);
            await store.recurring(r).put(record);
        });
        await syncService.enqueue(T_RECURRING, id, "upsert", record);
        notify();
        return record;
    },

    async setRecurringActive(id, active) {
        const { recurring } = await this.getRecurring(id);
        return this.updateRecurring(id, { active: Boolean(active) });
    },

    async removeRecurring(id) {
        const at = now();
        const { recurring, payments } = await this.getRecurring(id);
        assertRecurringExists(recurring, id);
        // A recurring rule is meaningless without its history, and the
        // transactions may also be real entries the user wants to keep. Keep
        // the transactions, drop the link: the history becomes plain records.
        //
        // The rows are rewritten in one transaction and queued for sync only
        // AFTER it. enqueue() writes the outbox store, which is a different
        // transaction and therefore a different task â€” awaiting it inside this
        // one let the loop go idle, IndexedDB auto-committed, and every payment
        // after the first was silently dropped: the rule was deleted while its
        // history kept pointing at it. Same order as categoryService.rename
        // and sessionService.remove.
        const plain = unlinkRecurringPayments(payments, at);
        await withTx(["recurring", "transactions"], "readwrite", async r => {
            await store.recurring(r).delete(id);
            const tr = store.transactions(r);
            for (const row of plain) await tr.put(row);
        });
        // One outbox transaction for the whole batch, not one per payment.
        await syncService.enqueueMany([
            ...plain.map(row => ({ type: T_TRANSACTION, id: row.id, op: "upsert", data: row, at })),
            { type: T_RECURRING, id, op: "delete", data: null, at }
        ]);
        notify();
    },

    // Pay a due occurrence: one real transaction is created, dated on the due
    // day, and the next due date follows from the schedule on read. No future
    // transactions are ever pre-generated.
    async markRecurringPaid(id, { occurredAt = null, note = null } = {}) {
        const at = now();
        const { recurring, payments, dueAt } = await this.getRecurring(id);
        assertRecurringExists(recurring, id);
        if (!recurring.active) throw new ValidationError("recurring", "recurring_inactive");
        if (dueAt == null) throw new ValidationError("recurring", "nothing_due");

        const record = createTransaction({
            type: recurring.type,
            title: recurring.title,
            amount: recurring.amount,
            currency: recurring.currency,
            category: recurring.category,
            occurredAt: occurredAt ?? dueAt,
            note: note ?? recurring.note ?? null,
            recurringId: recurring.id
        }, { now: at, id: crypto.randomUUID() });

        await withTx(["transactions"], "readwrite", async r => {
            await guardQuota(r, T_TRANSACTION);
            await store.transactions(r).put(record);
        });
        await syncService.enqueue(T_TRANSACTION, record.id, "upsert", record);
        notify();
        return { transaction: record, recurring, payments: [record, ...payments] };
    },

    // Skip the current occurrence: it is remembered on the rule itself, so the
    // next due date moves on without inventing a transaction.
    async skipRecurring(id) {
        const at = now();
        const { recurring, dueAt } = await this.getRecurring(id);
        assertRecurringExists(recurring, id);
        if (dueAt == null) throw new ValidationError("recurring", "nothing_due");
        const record = {
            ...recurring,
            skipped: [...(recurring.skipped || []), dueAt].sort((a, b) => a - b),
            updatedAt: at
        };
        await withTx(["recurring"], "readwrite", r => store.recurring(r).put(record));
        await syncService.enqueue(T_RECURRING, id, "upsert", record);
        notify();
        return record;
    },

    // ---------------------------------------------------------------- debts

    async createDebt(input) {
        const at = now();
        // Resolved before the record is built: a name typed inline becomes a
        // real person here, and the debt stores the name it resolved to.
        const who = await resolvePerson(input);
        const x = validateFinanceDebtInput({ ...input, ...who }, at);
        const record = createDebt(x, { now: at, id: crypto.randomUUID() });
        await withTx(["debts", "categories"], "readwrite", async r => {
            await guardQuota(r, T_DEBT);
            await assertCategoryExists(r, record.category);
            await store.debts(r).put(record);
        });
        await syncService.enqueue(T_DEBT, record.id, "upsert", record);
        notify();
        return record;
    },

    async updateDebt(id, patch) {
        const at = now();
        const { debt, payments } = await this.getDebt(id);
        assertDebtExists(debt, id);
        // A patch that drops the person link (the form sent no id and no name)
        // keeps the debt's existing one: clearing a person is not something
        // this form can accidentally do.
        const who = ("personId" in patch || "person" in patch)
            ? await resolvePerson({ personId: patch.personId ?? null, person: patch.person ?? null })
            : { personId: debt.personId ?? null, person: debt.person ?? null };
        const x = validateFinanceDebtInput({ ...debt, ...patch, ...who }, at);
        // Lowering the original amount below what is already paid would make
        // the debt show as over-settled; refuse instead of hiding it.
        const { paid } = debtTotals(debt, payments);
        if (x.amount < paid) throw new ValidationError("amount", "below_paid");
        const record = { ...debt, ...x, updatedAt: at };
        await withTx(["debts", "categories"], "readwrite", async r => {
            await assertCategoryExists(r, record.category, debt.category);
            await store.debts(r).put(record);
        });
        await syncService.enqueue(T_DEBT, id, "upsert", record);
        notify();
        return record;
    },

    // The debt and its payments go together, in one transaction, and each
    // removal is queued for sync so another device deletes them too.
    async removeDebt(id) {
        const at = now();
        const { debt, payments } = await this.getDebt(id);
        assertDebtExists(debt, id);
        await withTx(["debts", "debtPayments"], "readwrite", async r => {
            await store.payments(r).deleteByDebt(id);
            await store.debts(r).delete(id);
        });
        await syncService.enqueueMany([
            ...payments.map(p => ({ type: T_PAYMENT, id: p.id, op: "delete", data: null, at: p.updatedAt ?? at })),
            { type: T_DEBT, id, op: "delete", data: null, at }
        ]);
        notify();
    },

    async addDebtPayment(debtId, input) {
        const at = now();
        const x = validateFinanceDebtPaymentInput({ ...input, debtId }, at);
        const record = createDebtPayment(x, { now: at, id: crypto.randomUUID() });
        await withTx(["debts", "debtPayments"], "readwrite", async r => {
            const debt = await store.debts(r).get(debtId);
            assertDebtExists(debt, debtId);
            // Re-checked inside the transaction so two quick taps can never
            // both pass the same remaining-amount check.
            const history = await store.payments(r).byDebt(debtId);
            assertPaymentFits(debt, history, record.amount);
            await guardQuota(r, T_PAYMENT);
            await store.payments(r).put(record);
        });
        await syncService.enqueue(T_PAYMENT, record.id, "upsert", record);
        notify();
        return record;
    },

    async updateDebtPayment(id, patch) {
        const at = now();
        const current = await withTx(
            ["debtPayments"],
            "readonly",
            r => store.payments(r).get(id)
        );
        if (!current) throw new NotFoundError("debtPayment", id);
        const { debt, payments } = await this.getDebt(current.debtId);
        const x = validateFinanceDebtPaymentInput({ ...current, ...patch }, at);
        const next = { ...current, ...x, updatedAt: at };
        await withTx(["debts", "debtPayments"], "readwrite", async r => {
            // Judged against the other payments only, so shrinking this
            // payment is allowed while still refusing to overpay the debt.
            assertPaymentFits(debt, payments.filter(p => p.id !== id), x.amount);
            await store.payments(r).put(next);
        });
        await syncService.enqueue(T_PAYMENT, id, "upsert", next);
        notify();
        return next;
    },

    async removeDebtPayment(id) {
        const at = now();
        const current = await withTx(["debtPayments"], "readonly", r => store.payments(r).get(id));
        if (!current) throw new NotFoundError("debtPayment", id);
        await withTx(["debtPayments"], "readwrite", r => store.payments(r).delete(id));
        await syncService.enqueue(T_PAYMENT, id, "delete", null, at);
        notify();
    }
};
