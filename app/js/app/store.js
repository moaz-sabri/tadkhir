import { withTx } from "../data/db.js";
import { reader } from "../data/stores.js";
import { metaRepo } from "../data/meta.repo.js";
import { todaySummary } from "../domain/analytics.js";
import { startOfDay } from "../domain/time.js";
import { bus } from "./bus.js";

const tasks = reader("task");
const sessions = reader("session");

// The settings a device starts with, and the floor every read is taken over.
//
// This exists because a settings record is written once and then merged over
// forever, so a key added in a later release is simply ABSENT from every record
// that was written before it — on this device and on every other device that
// syncs one. Reading the stored record as-is turned "absent" into "false" for
// anything that tested it for truth, which is how `keepAwake` became a setting
// with no reader. Reading it over the defaults makes a missing key mean "the
// value this app ships with", which is the only thing the writer of the record
// could have meant by leaving it out.
export const DEFAULT_SETTINGS = Object.freeze({
    language: null,
    keepAwake: true,
    haptics: true,
    sound: true,
    notify: true,
    lastBackup: null
});

let state = {
    ready: false,
    tasks: [],
    active: null,
    recent: [],
    today: { count: 0, totalMs: 0 },
    settings: { ...DEFAULT_SETTINGS },
    ui: { updateAvailable: false }
};

const subs = new Set();

export const store = {
    getState: () => state,

    setState(p) {
        state = { ...state, ...p };
        // A copy, because a subscriber is allowed to unsubscribe from inside its
        // own callback (that is what unmount() does), and iterating the live
        // collection while it shrinks skips whichever subscriber came next.
        for (const s of [...subs]) {
            const v = s.sel(state);
            if (v !== s.last) {
                s.last = v;
                s.fn(v);
            }
        }
    },

    subscribe(sel, fn) {
        const s = { sel, fn, last: sel(state) };
        subs.add(s);
        return () => subs.delete(s);
    },

    async refresh(slice = "all") {
        if (slice === "settings") {
            await this.refreshSettings();
            return;
        }
        const data = await withTx(["tasks", "sessions", "meta"], "readonly", async r => {
            const meta = r.meta;
            const stored = (await metaRepo(meta).get("settings"))?.value || null;
            const lastBackup = (await metaRepo(meta).get("lastBackup"))?.value ?? null;
            const now = Date.now();
            return {
                tasks: await tasks(r).getAll(),
                active: await sessions(r).getActive(),
                recent: await sessions(r).recent(5),
                today: todaySummary(await sessions(r).sinceStarted(startOfDay(now)), now),
                settings: { ...DEFAULT_SETTINGS, ...(stored || {}), lastBackup }
            };
        });
        this.setState(
            slice === "tasks" ? { tasks: data.tasks } :
            slice === "active" ? { active: data.active } :
            slice === "recent" ? { recent: data.recent } : data
        );
    },

    // Settings on their own, without dragging the whole task and session tables
    // across. A language change writes one meta record; re-reading every task to
    // apply it would be the wrong shape for the most common single-key change in
    // the app.
    async refreshSettings() {
        const data = await withTx(["meta"], "readonly", async r => {
            const meta = r.meta;
            const stored = (await metaRepo(meta).get("settings"))?.value || {};
            const lastBackup = (await metaRepo(meta).get("lastBackup"))?.value ?? null;
            return { ...DEFAULT_SETTINGS, ...state.settings, ...stored, lastBackup };
        });
        this.setState({ settings: data });
    },

    // Persists the settings record. Merged over what is already stored, so
    // writing one key (the language) never clears another.
    async saveSettings(patch) {
        const merged = { ...DEFAULT_SETTINGS, ...state.settings, ...patch };
        await withTx(["meta"], "readwrite", async r => {
            const { lastBackup, ...value } = merged;
            await metaRepo(r.meta).set("settings", value);
        });
        this.setState({ settings: merged });
    },

    init() {
        // Guarded: init() registers a bus listener, and a second registration
        // would double every refresh and every wake-lock acquire for the rest of
        // the session, with no visible symptom to trace it back to.
        if (store.initialised) return;
        store.initialised = true;
        bus.on("data-changed", () => { store.refresh("all").catch(() => {}); });
    }
};
