import { withTx } from "../data/db.js";
import { reader } from "../data/stores.js";
import { activityLog, LOG_KINDS } from "../domain/analytics.js";

const tasks = reader("task");
const sessions = reader("session");
const transactions = reader("transaction");
const later = reader("later");
const routines = reader("routine");
const routineLogs = reader("routineLog");

// The Log holds no record of its own. It is a tool over the services: every line
// on it is derived, on read, from records that already exist, so it cannot fall
// behind the lists it summarises and there is nothing extra to export, sync or
// reconcile. See activityLog() in domain/analytics.js for what a line is and what
// each kind is dated by.
//
// The reads are gathered in ONE transaction for the reason every other read in
// this app is: a run that finished between two reads would put a session on one
// side of a day heading and its transaction on the other.
export const logService = {
    /**
     * The log, newest day first.
     *
     * `days` bounds how far back it looks, which is the only knob: the log is a
     * history and a history of everything is a page that never ends, so the reader
     * asks for a window and the app draws one.
     */
    async list({ days = 30, now = Date.now(), kinds = LOG_KINDS } = {}) {
        const to = now;
        const from = startOfDayWindow(days, now);
        const data = await withTx(
            ["tasks", "sessions", "transactions", "later", "routines", "routineLogs"],
            "readonly",
            async r => ({
                tasks: await tasks(r).getAll(),
                sessions: await sessions(r).getAll(),
                transactions: await transactions(r).getAll(),
                later: await later(r).getAll(),
                routines: await routines(r).getAll(),
                routineLogs: await routineLogs(r).getAll()
            })
        );
        return activityLog(data, { from, to, kinds });
    }
};

// The start of the window, as a timestamp. The domain groups by day and does the
// calendar; this only has to say how many days back to look, and it is the same
// rule the rest of the app uses for a window — start of day, minus whole days.
function startOfDayWindow(days, now) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
}
