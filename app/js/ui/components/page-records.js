import { t } from "../../i18n/i18n.js";
import { store } from "../../app/store.js";
import { laterService } from "../../services/later-service.js";
import { sessionService } from "../../services/session-service.js";
import { financeService } from "../../services/finance-service.js";
import { laterLabel, hostOf } from "../../domain/later.js";
import { linkFor, targetIdOf } from "../../domain/pages.js";
import { richTextPreview } from "../../domain/rich-text.js";
import { PAGE_ITEM_TARGETS } from "../../domain/validation.js";
import { formatShort, formatDateTime } from "../../domain/time.js";
import { formatMoney } from "../../domain/money.js";

// What a page item that points at something is actually pointing AT.
//
// This is the one place a pointer is followed. The page stores an id; the label,
// the second line and the address all come from the record itself, read through
// the service that owns it. So a task renamed on another device is renamed here
// too, an amount edited in Finance is the amount the page shows, and a page can
// never hold a second version of anything.
//
// Two rules keep it honest:
//
//   1. A service is loaded only when a page really has an item of that kind. A
//      user with no sessions never pays for reading them, and a user with no
//      finance at all never opens the transactions store.
//   2. Nothing here writes. Pointing at a record is not editing it — the row is
//      an `<a>` to the record's own screen, which is where it is changed.

// ---------------------------------------------------------------- choosing --

/**
 * Everything on this device that a given kind of item could point at, as
 * `{ id, title, subtitle }`. This is the chooser's list, and the same shapes are
 * what `resolveAll` matches pointers against, so the label a record is chosen by
 * and the label it is shown by afterwards cannot drift apart.
 */
export async function candidatesFor(type) {
    switch (type) {
        // Tasks are already in memory — the whole store is held in the app state
        // for the home screen and the session checklist, so reading them again
        // would be the same data through a second door.
        case "task":
            return store.getState().tasks.map(taskOption);
        case "session":
            return (await sessionService.list()).map(sessionOption);
        // Both halves of Later, open first: a follow-up you have not dealt with
        // is the one a page is most likely to point at.
        case "reference": {
            const { open, done } = await laterService.list();
            return [...open, ...done].map(referenceOption);
        }
        case "expense":
            return (await financeService.listTransactions()).map(expenseOption);
        default:
            return [];
    }
}

// ---------------------------------------------------------------- resolving -

/**
 * Resolve every pointer on a page in one pass, at most one read per kind.
 *
 * Called once per render, so a page with twenty pointers to twenty tasks is one
 * pass over the in-memory task list and not twenty transactions. Returns a Map
 * keyed by item id, each value either `{ href, title, subtitle }` or
 * `{ missing: true }`.
 *
 * Items that point at nothing (a heading, a paragraph, a divider) are absent from
 * the map, so a caller can ask about an item it has not classified and get
 * nothing rather than a wrong answer.
 */
export async function resolveAll(items) {
    const linked = (Array.isArray(items) ? items : []).filter(x => PAGE_ITEM_TARGETS[x?.type]);
    const kinds = [...new Set(linked.map(x => x.type))];

    // One read per kind, in parallel, rather than one per pointer.
    const byKind = new Map();
    await Promise.all(kinds.map(async type => {
        const options = await candidatesFor(type);
        byKind.set(type, new Map(options.map(o => [o.id, o])));
    }));

    const out = new Map();
    for (const item of linked) {
        const id = targetIdOf(item);
        const hit = id ? byKind.get(item.type)?.get(id) : null;
        out.set(item.id, hit
            ? { href: linkFor(item), title: hit.title, subtitle: hit.subtitle }
            // Deleted here, or on another device. A plain fact, and the row says
            // it in words rather than offering a link to a screen with no record.
            : { missing: true });
    }
    return out;
}

// ----------------------------------------------------------------- options --

const taskOption = task => ({
    id: task.id,
    title: task.title,
    subtitle: formatShort(task.estimatedMs)
});

const sessionOption = session => ({
    id: session.id,
    title: session.taskTitle || t("session.free"),
    subtitle: formatDateTime(session.startedAt)
});

const referenceOption = item => ({
    id: item.id,
    title: laterLabel(item) ?? t("later.untitled"),
    // Where a link points, or the first words of a note — the same two lines the
    // Later list itself uses to tell two otherwise identical rows apart.
    subtitle: item.type === "link" ? hostOf(item.url) : preview(item.content)
});

const expenseOption = tx => ({
    id: tx.id,
    title: tx.title,
    subtitle: `${formatMoney(tx.amount, tx.currency)} · ${formatDateTime(tx.occurredAt)}`
});

// A note's first words on one line, with the formatting parsed away. A row is
// not a place to show bold, and a pointer's subtitle is read at a glance while
// choosing between twenty similar things.
const preview = (content, max = 90) => richTextPreview(content, max);
