import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { haptics } from "../app/js/app/haptics.js";
import { notifications } from "../app/js/app/notifications.js";
import { createWakeLock } from "../app/js/app/wake-lock.js";
import { createSessionWatch } from "../app/js/app/session-watch.js";
import { store } from "../app/js/app/store.js";

// The device layer: vibration, notifications, the screen wake lock, and the one
// alert that ties them together.
//
// Every one of these is an enhancement over something the app already did, and
// every one of them is optional in the strict sense — the platform may not have
// the API, the user may not want it, and the app has to behave exactly as it did
// before in all three cases. That is the whole contract, and it is the thing these
// tests are about: not "does the pulse fire" but "does nothing here ever throw,
// block, or change the timer".

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");
const existsIcon = src => existsSync(join(root, "app", src));
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every .js under app/js, so a new file is covered without editing this. */
const jsFiles = [];
(function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith(".js")) jsFiles.push(rel);
    }
})("app/js");

// The store is module state, and haptics/notifications read the preference from
// it on every call rather than caching it. That is what makes a settings change
// take effect on the next tap — and it also means a test that turns a preference
// off has to put it back.
const withSetting = async (key, value, fn) => {
    const before = store.getState().settings;
    store.setState({ settings: { ...before, [key]: value } });
    try {
        return await fn();
    } finally {
        store.setState({ settings: before });
    }
};

// ---------------------------------------------------------------- haptics ---

test("a device with no Vibration API is silent, and says so", () => {
    assert.equal(haptics.supported({}), false);
    assert.equal(haptics.supported(null), false);
    assert.equal(haptics.supported({ vibrate: () => {} }), true);
});

test("every pattern in the table is a pattern the platform accepts", () => {
    // A number, or an array of numbers. Anything else — a string, an object — is
    // passed to a platform method that will throw on it, so the table itself is
    // what has to be checked.
    for (const [kind, pattern] of Object.entries(haptics.patterns)) {
        if (Array.isArray(pattern)) {
            assert.ok(pattern.length > 0 && pattern.every(n => typeof n === "number" && n > 0), kind);
        } else {
            assert.equal(typeof pattern, "number", kind);
            assert.ok(pattern > 0, kind);
        }
    }
});

test("there is no pattern for an ordinary tap, which is the point", () => {
    // The reason this app does not feel like a toy. A pulse is a statement about
    // something that happened; a generic "button" pattern is how a web page starts
    // buzzing at someone for pressing a link, and once it does that the pulses
    // that mean something stop being read.
    assert.equal(haptics.patterns.tap, undefined);
    assert.equal(haptics.patterns.click, undefined);
    assert.equal(haptics.patterns.button, undefined);
});

test("a pulse fires on a device that has one, and only once per event", () => {
    const calls = [];
    const nav = { vibrate: p => calls.push(p) };
    haptics.reset();
    assert.equal(haptics.do("finish", { nav }), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], haptics.patterns.finish);

    // The same pulse again inside the window is the same event reported twice —
    // a tap on "Finish" confirms, writes, navigates and reports.
    assert.equal(haptics.do("finish", { nav }), false);
    assert.equal(calls.length, 1);

    // A DIFFERENT kind is a different event and is not suppressed by the first.
    assert.equal(haptics.do("error", { nav }), true);
    assert.equal(calls.length, 2);
});

test("a misspelled kind is silence rather than a default buzz", () => {
    const calls = [];
    const nav = { vibrate: p => calls.push(p) };
    haptics.reset();
    assert.equal(haptics.do("estimateReached", { nav }), false);
    assert.equal(haptics.do("", { nav }), false);
    assert.equal(calls.length, 0);
});

test("a device that exposes vibrate and then throws does not break the timer", () => {
    const nav = { vibrate: () => { throw new Error("the user is in a phone call"); } };
    haptics.reset();
    assert.doesNotThrow(() => haptics.do("start", { nav }));
    assert.equal(haptics.do("start", { nav }), false);
});

test("turning vibration off in Settings silences it on the very next press", async () => {
    const calls = [];
    const nav = { vibrate: p => calls.push(p) };
    await withSetting("haptics", false, () => {
        haptics.reset();
        assert.equal(haptics.do("start", { nav }), false);
        assert.equal(calls.length, 0);
        assert.equal(haptics.enabled(), false);
    });
    haptics.reset();
    assert.equal(haptics.do("start", { nav }), true);
});

test("a settings record from before haptics existed still buzzes", async () => {
    // A key that is ABSENT means "the value this app ships with", not "false".
    // Otherwise every device that synced a record written by an older release
    // would go quiet the day this shipped, without anyone deciding that.
    const calls = [];
    const nav = { vibrate: p => calls.push(p) };
    await withSetting("haptics", undefined, () => {
        haptics.reset();
        assert.equal(haptics.do("start", { nav }), true);
    });
    assert.equal(calls.length, 1);
});

// ----------------------------------------------------------- notifications ---

// A stand-in for the platform's Notification constructor. `last` and `asked` are
// reset per call, so one test's delivery is not the next test's evidence.
const fakeNotifications = permission => {
    fakeNotifications.last = null;
    fakeNotifications.asked = 0;
    return {
        Notification: class {
            constructor(title, options) {
                fakeNotifications.last = { via: "constructor", title, options };
            }
            static permission = permission;
            static async requestPermission() {
                fakeNotifications.asked += 1;
                return permission === "default" ? "granted" : permission;
            }
        }
    };
};

test("a browser with no Notification API is reported as unsupported", () => {
    assert.equal(notifications.supported({}), false);
    assert.equal(notifications.supported(null), false);
    assert.equal(notifications.permission({}), "unsupported");
    assert.equal(notifications.permission({ Notification: {} }), "default");
});

test("the permission is asked once, and never after an answer", async () => {
    const win = fakeNotifications("default");
    win.Notification.requestPermission = async () => { win.asked = (win.asked || 0) + 1; return "granted"; };
    // The fake's static is a snapshot, so set the answer the caller will see.
    win.Notification.permission = "default";
    assert.equal(await notifications.ask(win), "granted");
    assert.equal(win.asked, 1);

    // Second time: the browser has already answered, so nothing is asked. A site
    // that re-prompts is a site that gets blocked.
    win.Notification.permission = "granted";
    assert.equal(await notifications.ask(win), "granted");
    assert.equal(win.asked, 1);

    win.Notification.permission = "denied";
    assert.equal(await notifications.ask(win), "denied");
    assert.equal(win.asked, 1);
});

test("a prompt that throws is a prompt that was refused", async () => {
    const win = {
        Notification: {
            permission: "default",
            requestPermission: async () => { throw new Error("not a user gesture"); }
        }
    };
    assert.equal(await notifications.ask(win), "denied");
});

test("a notification is delivered through the service worker when there is one", async () => {
    // The worker is the only route whose click can be handled, so it is preferred
    // over the bare constructor.
    const shown = [];
    const win = {
        Notification: Object.assign(class {
            constructor(title, options) { shown.push({ via: "constructor", title }); }
        }, { permission: "granted" }),
        navigator: {
            serviceWorker: {
                getRegistration: async () => ({
                    showNotification: async (title, options) => shown.push({ via: "sw", title, options })
                })
            }
        }
    };
    assert.equal(await notifications.send({
        title: "Time is up",
        body: "Deep work · 25:00",
        data: { url: "/session" }
    }, win), true);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].via, "sw");
    assert.equal(shown[0].options.body, "Deep work · 25:00");
    // It carries the destination, and a tag, so a repeat REPLACES rather than
    // stacks. Two identical alerts for one event is what makes people switch
    // notifications off.
    assert.equal(shown[0].options.tag, "task-timer-session");
    assert.equal(shown[0].options.renotify, false);
    assert.equal(shown[0].options.data.url, "/session");
});

test("without a registration the bare constructor is the fallback", async () => {
    const win = fakeNotifications("granted");
    assert.equal(await notifications.send({ title: "Time is up" }, win), true);
    assert.equal(fakeNotifications.last.via, "constructor");
});

test("nothing is shown where the platform would not show it", async () => {
    const win = fakeNotifications("default");
    assert.equal(await notifications.send({ title: "x" }, win), false);
    const denied = fakeNotifications("denied");
    assert.equal(await notifications.send({ title: "x" }, denied), false);
    assert.equal(await notifications.send({ title: "x" }, {}), false);
    assert.equal(fakeNotifications.last, null, "nothing was constructed");
});

test("turning notifications off in Settings stops the alerts", async () => {
    const win = fakeNotifications("granted");
    await withSetting("notify", false, () => {
        assert.equal(notifications.granted(win), false);
    });
    assert.equal(notifications.granted(win), true);
});

test("a delivery that throws is not an error the timer can see", async () => {
    const win = {
        Notification: Object.assign(class {}, { permission: "granted" }),
        navigator: {
            serviceWorker: {
                getRegistration: async () => ({
                    showNotification: async () => { throw new Error("no notification service"); }
                })
            }
        }
    };
    assert.equal(await notifications.send({ title: "x" }, win), false);
});

// --------------------------------------------------------------- wake lock ---

const fakeWakeLock = () => {
    const grants = [];
    const listeners = new Map();
    const nav = {
        wakeLock: {
            request: async type => {
                const lock = {
                    type,
                    released: 0,
                    release() { this.released += 1; },
                    addEventListener: (name, fn) => listeners.set(name, fn)
                };
                grants.push(lock);
                return lock;
            }
        }
    };
    return { nav, grants, platformRelease: () => listeners.get("release")?.() };
};

const fakeWindow = () => {
    const listeners = new Map();
    return {
        document: { hidden: false },
        addEventListener: (name, fn) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
        fire(name) { for (const fn of listeners.get(name) ?? []) fn(); }
    };
};

test("a running session takes the lock, and a paused one gives it back", async () => {
    const { nav, grants } = fakeWakeLock();
    const win = fakeWindow();
    let session = { status: "running" };
    const lock = createWakeLock({ nav, win, getSession: () => session, isEnabled: () => true });

    await lock.sync();
    assert.equal(grants.length, 1);
    assert.equal(lock.isHeld(), true);

    session = { status: "paused" };
    await lock.sync();
    assert.equal(grants[0].released, 1);
    assert.equal(lock.isHeld(), false);
});

test("the lock is never taken twice", async () => {
    // Every data change used to ask for a new one without releasing the old, so
    // each session transition left a sentinel behind that nothing would ever give
    // back. A second request while one is held is a no-op, not a second lock.
    const { nav, grants } = fakeWakeLock();
    const lock = createWakeLock({ nav, win: fakeWindow(), getSession: () => ({ status: "running" }), isEnabled: () => true });
    await lock.sync();
    await lock.sync();
    await lock.sync();
    assert.equal(grants.length, 1);
});

test("the lock is taken again when the page comes back", async () => {
    // The whole reason the old implementation was broken: the platform RELEASES
    // the lock whenever the page stops being visible, and only the page can take a
    // new one. Nothing did, so the screen went dark a minute into every session.
    const { nav, grants, platformRelease } = fakeWakeLock();
    const win = fakeWindow();
    const lock = createWakeLock({ nav, win, getSession: () => ({ status: "running" }), isEnabled: () => true });
    lock.install();
    await lock.sync();
    assert.equal(grants.length, 1);

    // Hidden: the platform drops it, and so do we.
    win.document.hidden = true;
    win.fire("visibilitychange");
    assert.equal(lock.isHeld(), false);
    platformRelease();

    // Visible again with the session still running: a NEW lock, exactly one.
    win.document.hidden = false;
    win.fire("visibilitychange");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(grants.length, 2);
    assert.equal(lock.isHeld(), true);
});

test("a session the user turned the feature off for takes no lock", async () => {
    const { nav, grants } = fakeWakeLock();
    let on = false;
    const lock = createWakeLock({ nav, win: fakeWindow(), getSession: () => ({ status: "running" }), isEnabled: () => on });
    await lock.sync();
    assert.equal(grants.length, 0);

    on = true;
    await lock.sync();
    assert.equal(grants.length, 1);
});

test("a device with no Wake Lock API is a no-op, not a warning", async () => {
    for (const nav of [{}, { wakeLock: {} }, null]) {
        const lock = createWakeLock({ nav, win: fakeWindow(), getSession: () => ({ status: "running" }), isEnabled: () => true });
        await assert.doesNotReject(lock.sync());
        assert.equal(lock.isHeld(), false);
        assert.equal(lock.available(), false);
    }
});

test("a denied request, and a lock that throws on release, are both survivable", async () => {
    const denied = createWakeLock({
        nav: { wakeLock: { request: async () => { throw new Error("denied"); } } },
        win: fakeWindow(),
        getSession: () => ({ status: "running" }),
        isEnabled: () => true
    });
    assert.equal(await denied.sync(), false);
    assert.equal(denied.isHeld(), false);

    const thrower = createWakeLock({
        nav: {
            wakeLock: {
                request: async () => ({
                    release: () => { throw new Error("already gone"); },
                    addEventListener: () => {}
                })
            }
        },
        win: fakeWindow(),
        getSession: () => ({ status: "running" }),
        isEnabled: () => true
    });
    await thrower.sync();
    assert.doesNotThrow(() => thrower.release());
    assert.equal(thrower.isHeld(), false);
});

// ---------------------------------------------------------- session watch ---

// A running task-backed session, 25 minutes into a 25-minute estimate.
const overSession = (over = {}) => ({
    id: "s1",
    taskId: "t1",
    taskTitle: "Deep work",
    estimatedMs: 25 * 60 * 1000,
    status: "running",
    segments: [{ start: Date.now() - 30 * 60 * 1000, end: null }],
    ...over
});

const underSession = () => overSession({ estimatedMs: 6 * 60 * 60 * 1000 });

test("the alert fires once when the estimate is passed, and not before", () => {
    const buzzes = [];
    const rings = [];
    const sent = [];
    let session = underSession();
    const watch = createSessionWatch({
        getSession: () => session,
        buzz: k => buzzes.push(k),
        ring: () => rings.push(true),
        canNotify: () => true,
        notify: m => sent.push(m),
        buildMessage: (s, ms) => ({ title: "Estimated time reached", body: `${s.taskTitle} · ${ms}` })
    });

    // A tick a second early must be silent. A timer that buzzes on the way to the
    // estimate has trained the user to ignore the buzz.
    watch.check();
    watch.check();
    assert.deepEqual(buzzes, []);
    assert.deepEqual(sent, []);

    session = overSession();
    watch.check();
    watch.check();
    watch.check();
    assert.deepEqual(buzzes, ["over"]);
    assert.equal(rings.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /^Deep work · /);
});

test("a session that is paused, or gone, or a different one, re-arms the alert", () => {
    const buzzes = [];
    let session = overSession();
    const watch = createSessionWatch({
        getSession: () => session,
        buzz: k => buzzes.push(k),
        ring: () => {},
        canNotify: () => false,
        notify: () => {}
    });

    watch.check();
    assert.deepEqual(buzzes, ["over"]);

    // Paused: the latch is dropped, because a resumed session that is still past
    // its estimate has not been told anything yet.
    session = overSession({ status: "paused" });
    watch.check();
    session = overSession();
    watch.check();
    assert.deepEqual(buzzes, ["over", "over"]);

    // A new session starts, already past an estimate of its own: its own alert.
    session = overSession({ id: "s2" });
    watch.check();
    assert.equal(buzzes.length, 3);

    // Nothing running at all.
    session = null;
    watch.check();
    assert.equal(buzzes.length, 3);
});

test("an estimate passed while the app was in the background is delivered on the way back", async () => {
    // The case a background tab is throttled for and iOS freezes outright: no
    // timer ran, so nothing noticed. This is the first moment at which anyone can,
    // and the latch is what makes it exactly once.
    const win = fakeWindow();
    const buzzes = [];
    const sent = [];
    const timers = [];
    let session = underSession();
    const watch = createSessionWatch({
        getSession: () => session,
        isHidden: () => win.document.hidden,
        isVisible: () => !win.document.hidden,
        buzz: k => buzzes.push(k),
        ring: () => {},
        canNotify: () => true,
        notify: m => sent.push(m),
        buildMessage: () => ({ title: "x" }),
        win,
        setTimer: (fn, ms) => { timers.push(ms); return timers.length; },
        stopTimer: () => {}
    });

    watch.start();
    assert.equal(buzzes.length, 0);

    // The tab goes away. The clock is a minute now, because a throttled tab
    // answers a one-second question with the same one a minute later.
    win.document.hidden = true;
    win.fire("visibilitychange");
    assert.equal(timers.at(-1), 30000);

    // It came back to a session that had been passed the whole time.
    session = overSession();
    win.document.hidden = false;
    win.fire("visibilitychange");
    assert.equal(timers.at(-1), 1000);
    assert.deepEqual(buzzes, ["over"]);
    assert.equal(sent.length, 1);

    // And a second catch-up says nothing more.
    win.document.hidden = true;
    win.fire("visibilitychange");
    win.document.hidden = false;
    win.fire("visibilitychange");
    assert.deepEqual(buzzes, ["over"]);
    assert.equal(sent.length, 1);
});

test("a watcher with no window and no session is inert, and leaves nothing running", () => {
    // Everything here is optional in the app's favour only, and this is the one
    // place that is easy to get wrong: a watcher that started an interval nobody
    // stops is a process that never exits, and on the page a timer that never
    // stops. The fake timers below count as well as record.
    const timers = new Set();
    let next = 0;
    const win = { addEventListener: () => {}, removeEventListener: () => {} };
    const watch = createSessionWatch({
        win,
        getSession: () => null,
        setTimer: () => { next += 1; timers.add(next); return next; },
        stopTimer: id => timers.delete(id)
    });
    assert.doesNotThrow(() => { watch.check(); watch.start(); });
    assert.equal(timers.size, 1);
    watch.stop();
    assert.equal(timers.size, 0, "stop() must take the interval with it");

    // And a host with no window at all — Node, or a page before the document
    // exists — is not a crash.
    const bare = createSessionWatch({ win: null, getSession: () => null });
    assert.doesNotThrow(() => { bare.start(); bare.check(); bare.stop(); });
});

// ------------------------------------------------------- the wiring itself ---

test("only the haptics module is allowed to vibrate", () => {
    // One place decides whether a device buzzes. A second call site would have to
    // re-decide the same four things — supported, enabled, a known kind, not a
    // repeat — and there are already two of those in this app's history.
    const offenders = [];
    for (const file of jsFiles) {
        if (file === "app/js/app/haptics.js") continue;
        if (/\bnavigator\s*\.\s*vibrate\b|\.vibrate\(/.test(code(read(file)))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `vibration outside app/haptics.js: ${offenders.join(", ")}`);
});

test("only the notifications module is allowed to show a notification", () => {
    const offenders = [];
    for (const file of jsFiles) {
        if (file === "app/js/app/notifications.js") continue;
        const src = code(read(file));
        if (/showNotification|requestPermission|new\s+Notification\b/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `notification delivery outside app/notifications.js: ${offenders.join(", ")}`);
});

test("only the wake-lock module is allowed to ask for a wake lock", () => {
    // The name `wakeLock` is the module's own export and appears wherever it is
    // used; what must not appear anywhere else is the platform behind it.
    const offenders = [];
    for (const file of jsFiles) {
        if (file === "app/js/app/wake-lock.js") continue;
        const src = code(read(file));
        if (/navigator\s*\.\s*wakeLock|wakeLock\s*\.\s*request|\bwakeLock\s*\[/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `the wake lock API outside app/wake-lock.js: ${offenders.join(", ")}`);
});

test("the estimate alert is decided in one place, not in a view", () => {
    // The session panel and the session chip each used to keep their own
    // `vibrated` flag and their own idea of what to do about the crossing, and the
    // alert only existed while one of them happened to be mounted — so on any
    // other screen, reaching the estimate said nothing at all.
    for (const view of ["app/js/ui/components/session-panel.js", "app/js/ui/components/session-chip.js"]) {
        const src = code(read(view));
        assert.ok(!/estimateReached\s*&&/.test(src) || !/vibrat|beep/.test(src),
            `${view} must not decide the estimate alert`);
        assert.ok(!/\bbeep\(/.test(src), `${view} must not ring the bell`);
    }
    // And the decision is made by a module that is not a view at all.
    const watcher = read("app/js/app/session-watch.js");
    assert.match(watcher, /isOver\(/, "the watcher decides on the engine's own answer");
    assert.match(watcher, /alerted/, "and it latches, so the crossing alerts once");
});

test("a free session raises no estimate alert at all", () => {
    // The engine said `elapsed >= estimatedMs`, and a free session's estimate is
    // zero — so every untimed session was over one millisecond after it started,
    // and the alert that follows from that (a pulse, a tone, a notification) is
    // the one a user is most likely to switch off for good.
    const buzzes = [];
    const watch = createSessionWatch({
        getSession: () => ({
            id: "s1",
            taskId: null,
            taskTitle: "Phone call",
            estimatedMs: 0,
            status: "running",
            segments: [{ start: Date.now() - 3600_000, end: null }]
        }),
        buzz: k => buzzes.push(k),
        ring: () => {},
        canNotify: () => true,
        notify: () => buzzes.push("notified")
    });
    watch.check();
    watch.check();
    assert.deepEqual(buzzes, []);
});

test("every screen that asks about the estimate asks the engine", () => {
    // The rule ("a session is only measured when it is on a task that had an
    // estimate") had been written out longhand in the panel, the chip and two
    // other places, and `isOver` in the engine — the one function named after the
    // question — had a different one, and no caller. Now there is one answer.
    for (const file of [
        "app/js/ui/components/session-panel.js",
        "app/js/ui/components/session-chip.js"
    ]) {
        const src = code(read(file));
        assert.match(src, /hasEstimate/, `${file} must use the engine's answer`);
        assert.ok(!/!!\s*\w+\.taskId\s*&&\s*\w+\.estimatedMs\s*>/.test(src),
            `${file} must not re-state the rule in its own words`);
    }
    // The alert asks the question the engine's own way round: `isOver`, which is
    // `hasEstimate` plus the comparison.
    const watcher = code(read("app/js/app/session-watch.js"));
    assert.match(watcher, /isOver\(/);
    assert.ok(!/!!\s*\w+\.taskId\s*&&\s*\w+\.estimatedMs\s*>/.test(watcher),
        "session-watch must not re-state the rule in its own words");
});

test("the permission is asked at the moment a session starts, not at launch", () => {
    const service = code(read("app/js/services/session-service.js"));
    assert.match(service, /notifications\.ask\(\)/,
        "starting a session is the moment the alert starts to matter");
    // Before the first await of THAT method, so it is still inside the tap that
    // caused it: some engines refuse a prompt that is not in the gesture's own
    // task, and by the time the transaction has resolved the gesture is gone.
    const start = /async start\(input\) \{([\s\S]*?)\n    \},/.exec(service);
    assert.ok(start, "start() is findable");
    assert.ok(start[1].indexOf("notifications.ask()") < start[1].indexOf("await"),
        "the ask must come before the first await of start()");
    // And nothing in the boot path asks for it.
    const boot = code(read("app/js/main.js"));
    assert.ok(!/notifications\.ask/.test(boot), "opening the app must not ask for anything");
});

test("a setting the user never heard of is not read as false", () => {
    // The record in IndexedDB was written by an older release and has no such key.
    // Reading it as-is made every new preference false on every device that had
    // one, silently, which is how `keepAwake` became a setting with no reader.
    const store = code(read("app/js/app/store.js"));
    assert.match(store, /export const DEFAULT_SETTINGS = Object\.freeze/,
        "the defaults are a named thing, not an object literal in three places");
    assert.match(store, /\{\s*\.\.\.DEFAULT_SETTINGS,\s*\.\.\.\(stored \|\| \{\}\)/,
        "a stored record is read over the defaults");
    for (const reader of ["haptics.js", "notifications.js", "wake-lock.js"]) {
        assert.match(code(read(`app/js/app/${reader}`)), /!== false/,
            `${reader} must read the preference as "not false"`);
    }
});

// ----------------------------------------------------------------- the PWA ---

test("the manifest describes an installable app, and does not lock the device", () => {
    const manifest = JSON.parse(read("app/manifest.webmanifest"));
    assert.equal(manifest.start_url, "/", "installed app opens at the app, not at a file:// URL");
    assert.equal(manifest.scope, "/", "the scope covers the whole app's routes");
    assert.equal(manifest.display, "standalone", "no browser chrome around the app");
    assert.ok(Array.isArray(manifest.display_override) && manifest.display_override[0] === "standalone",
        "standalone first, with a browser fallback behind it");
    // `orientation` is deliberately NOT "portrait": the session stage is designed
    // to be read in landscape as well, and a timer app that refuses to rotate is a
    // timer app that cannot be put on a desk.
    assert.ok(manifest.orientation === undefined || manifest.orientation === "any");
    assert.equal(manifest.prefer_related_applications, false,
        "this app has nothing to do with a native one, and must not say it does");
    // Every icon a platform needs for an install prompt, and the maskable one so
    // the launcher can crop it to whatever shape it likes.
    const purposes = manifest.icons.map(i => `${i.sizes}:${i.purpose || "any"}`);
    assert.ok(purposes.includes("192x192:any"), "a 192px icon is required to install");
    assert.ok(purposes.includes("512x512:any"), "a 512px icon is required to install");
    assert.ok(purposes.includes("512x512:maskable"), "a maskable icon is what Android crops");
    assert.ok(manifest.icons.every(i => i.src.startsWith("/")), "icon paths are root-relative");
    for (const icon of manifest.icons) {
        assert.ok(existsIcon(icon.src), `${icon.src} is named in the manifest but not on disk`);
    }
    // The share target is the one feature this app has that a bookmark cannot.
    //
    // It is a POST of multipart/form-data to the intake, and BOTH halves are
    // load-bearing rather than incidental. `method`/`enctype` are what a browser
    // requires before it will hand a share target a FILE at all, and the spec
    // allows exactly one share_target per manifest — so this is also the reason
    // the three text parameters come through the same request instead of the
    // GET target they used on, and why the app's Content-Security-Policy has to
    // say `form-action 'self'` rather than 'none'. See api/share-intake.php for
    // the server half and app/js/services/share-intake.js for the client one.
    const target = manifest.share_target;
    assert.equal(target.method, "POST");
    assert.equal(target.enctype, "multipart/form-data");
    assert.equal(target.action, "/api/share/intake");
    // Every text parameter the chooser reads has to be declared here, or the
    // browser does not send it.
    for (const field of ["title", "text", "url"]) {
        assert.equal(target.params[field], field, `the ${field} parameter is not declared`);
    }
    // And the files, with the accept list the same one the app classifies by
    // (app/js/domain/attachments.js) — a mismatch here would offer a file the
    // app then refuses.
    const files = target.params.files;
    assert.ok(Array.isArray(files) && files.length === 1, "one files descriptor is declared");
    assert.equal(files[0].name, "files", "the field name is what the server reads");
    const accept = files[0].accept;
    for (const kind of ["image/*", "audio/*", "video/*", ".pdf", ".docx"]) {
        assert.ok(accept.includes(kind), `the share target does not offer ${kind}`);
    }
    assert.ok(!accept.includes("*/*") && !accept.includes(".html") && !accept.includes(".svg"),
        "the share target must not offer everything, and never a type that could execute");
    // The action has to be inside the scope or the browser refuses the target.
    assert.ok(target.action.startsWith("/") && !target.action.startsWith("//"));
    // …and it has to be a route the server actually serves. `/share` is where
    // the 303 lands, so the SPA fallback must still answer it.
    assert.match(read("app/js/main.js"), /\{ path: "\/share", page: sharePage \}/);
    assert.match(read("api/index.php"), /'\/api\/share\/intake' => 'share_intake'/,
        "the manifest posts to a path the front controller does not route");
});

// The launcher's long-press menu. It was empty because the manifest had no
// `shortcuts` key at all — not because of a bad entry, but because there was
// nothing to show.
//
// Everything about this key is Chromium-only, and that is why each assertion
// below is about a property the SPEC states rather than about the feature
// working: iOS Safari and Firefox read the manifest, ignore `shortcuts`, and
// offer nothing on a long press, and no web API replaces it — a page cannot ask
// to be put in a launcher's menu. So the browser-independent half of this is
// `/quick`, an ordinary route every shortcut points at and anyone can bookmark.
test("the manifest offers the four actions as launcher shortcuts", () => {
    const manifest = JSON.parse(read("app/manifest.webmanifest"));
    assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 4,
        "a long press with nothing in it is the reported bug");

    const expected = {
        session: "start a session",
        note: "a note to come back to",
        income: "money received",
        expense: "money spent"
    };
    const routes = read("app/js/main.js");
    for (const [action, why] of Object.entries(expected)) {
        const s = manifest.shortcuts.find(x => x.url === `/quick?do=${action}`);
        assert.ok(s, `no shortcut for ${why} (expected /quick?do=${action})`);
        // A shortcut is a launcher entry: it is drawn in a menu with a label and
        // an icon, so a missing name is a blank row rather than a small one, and
        // `short_name` is what fits when the label does not.
        assert.ok(typeof s.name === "string" && s.name.length > 0, `${action} has no name`);
        assert.ok(typeof s.short_name === "string" && s.short_name.length > 0,
            `${action} has no short_name, which is what the launcher draws`);
        // Chromium IGNORES the whole key if a shortcut leaves the app's scope,
        // so every one of them has to be inside it.
        assert.ok(s.url.startsWith("/") && !s.url.startsWith("//"),
            `${action} must be a same-origin path inside scope "/"`);
        // …and the route has to exist, or the entry opens the 404 screen.
        assert.match(routes, /\{ path: "\/quick", page: quickPage \}/,
            `/quick?do=${action} is routed to nothing`);
    }

    // One icon each, and it must be a file on disk — a shortcut icon that 404s
    // is a launcher entry drawn with a blank square beside it.
    for (const s of manifest.shortcuts) {
        assert.ok(Array.isArray(s.icons) && s.icons.length > 0, `${s.url} has no icon`);
        for (const icon of s.icons) {
            assert.ok(existsIcon(icon.src), `${icon.src} is named in the manifest but not on disk`);
        }
    }
});

test("every browser can reach the same four actions at one address", () => {
    // The honest answer to "make it work on every browser". `shortcuts` and
    // `share_target` are Chromium features with no equivalent on iOS or Firefox,
    // so what has to be everywhere is a plain URL — and every manifest entry has
    // to point at it rather than at a route only Chromium can enter.
    const quick = read("app/js/ui/pages/quick.js");
    for (const action of ["note", "income", "expense"]) {
        assert.match(quick, new RegExp(`${action}: "/`), `quick.js has no ${action} destination`);
    }
    assert.match(quick, /asked === "session"/, "quick.js does no session shortcut");
    // The chooser is what makes the address useful on its own — bookmarked, or
    // added to a home screen by hand.
    assert.match(quick, /targetGrid\(\[/, "/quick with no ?do= is a chooser, not an error");
    // …and Settings is where somebody on a browser with no long-press menu finds
    // it. Without that row this page is unreachable on iOS.
    assert.match(read("app/js/ui/pages/settings.js"), /href: "\/quick"/,
        "the shortcut address must be offered where a bookmark can be made from it");
});

test("the iOS standalone tags are all present", () => {
    const html = read("app/index.html");
    // Each engine reads exactly one spelling of "run me as an app" and ignores the
    // other, and iOS names a home-screen icon from `apple-mobile-web-app-title` —
    // without which the installed app is called "Safari".
    assert.match(html, /name="apple-mobile-web-app-capable"\s+content="yes"/);
    assert.match(html, /name="mobile-web-app-capable"\s+content="yes"/);
    assert.match(html, /name="apple-mobile-web-app-title"\s+content="Tadkhir"/);
    // The viewport that makes the safe-area insets mean anything.
    assert.match(html, /viewport-fit=cover/);
});

test("the service worker handles the one notification the app sends", () => {
    const sw = read("app/sw.js");
    assert.match(sw, /addEventListener\("notificationclick"/,
        "an alert nobody can act on is an alert nobody acts on");
    assert.match(sw, /clients\.matchAll/,
        "an open window is brought forward rather than duplicated");
    assert.match(sw, /postMessage\(\{\s*type:\s*"open-session"/,
        "and is asked to open the session, since only the page owns the router");
    assert.match(sw, /clients\.openWindow/,
        "with a window opened when there is none, which is the case after a dismissal");
});

test("the first controller change is not mistaken for an update", () => {
    // install() does skipWaiting() and activate() does clients.claim(), so the very
    // first visit gets a controllerchange too. Reloading on it reloaded the app a
    // second time, moments after boot, on the first run and on no release at all.
    const src = read("app/js/app/sw-register.js");
    assert.match(src, /hadController/);
    assert.match(src, /if \(!hadController\)/);
    assert.match(src, /location\.reload\(\)/);
});

test("the install prompt is offered only where the browser offers one", () => {
    const src = read("app/js/app/sw-register.js");
    assert.match(src, /beforeinstallprompt/, "the event is captured while it is still live");
    assert.match(src, /preventDefault\(\)/, "or it cannot be shown later");
    assert.match(src, /appinstalled/, "and the offer is withdrawn once it is taken");
    // …and the button that uses it is not drawn when there is no offer.
    const settings = read("app/js/ui/pages/settings.js");
    assert.match(settings, /canInstall\(\) \? toolbar\(/,
        "the install control is conditional on the browser actually offering one");
});

// -------------------------------------------------------------------- CSS ---

test("touch targets are sized for a finger, and only where there is one", () => {
    const css = read("app/css/base.css") + read("app/css/tokens.css");
    // The 300ms tap delay is the single largest thing that makes a web page feel
    // unlike an app, and `manipulation` is the one line that removes it.
    assert.match(css, /touch-action:\s*manipulation/,
        "a tap on a control must not wait to find out whether it is a zoom");
    assert.match(css, /@media \(pointer: coarse\)/,
        "the pointer being a finger is knowable, so the target can be sized for it");
    assert.match(read("app/css/tokens.css"), /--tap: 44px/,
        "the desktop target is unchanged — 44px is still the floor");
});

test("motion is the user's to decide, and the new animations go with it", () => {
    const base = read("app/css/base.css");
    // One block, above everything, that collapses every animation in the app —
    // including the ones this change added. The haptics are NOT gated on it:
    // reduced motion is about movement, and no platform query exists for haptics.
    assert.match(base, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(base, /animation-duration: 0\.001ms !important/);
    // Nothing may reintroduce an animation outside that block's reach.
    for (const file of ["app/css/base.css", "app/css/components.css", "app/css/layout.css"]) {
        const src = read(file);
        for (const m of src.matchAll(/animation:\s*([^;]+);/g)) {
            const name = m[1].split(",")[0].trim();
            assert.notEqual(name, "none", `${file} must not disable the reduced-motion block`);
        }
    }
    assert.match(read("app/css/components.css"), /\.stage\[data-flash\]/);
    assert.match(read("app/css/components.css"), /\.session-chip\[data-flash\]/);
});

test("the switch is a real control, and moves with the writing direction", () => {
    const fields = code(read("app/js/ui/components/fields.js"));
    assert.match(fields, /type: "checkbox"/, "a real checkbox: keyboard, focus, form semantics");
    assert.match(fields, /role: "switch"/, "announced as on and off, not checked and unchecked");
    // The label is the control's accessible name, so a control that draws no text
    // is not announced as nothing.
    assert.match(fields, /aria-labelledby/);
    const css = read("app/css/components.css");
    // A LOGICAL property, so the knob travels the other way in Arabic with no
    // direction-specific rule and nothing to re-apply when the language changes.
    assert.match(css, /\.switch input:checked \+ \.switch-track::after \{[^}]*inset-inline-start/s,
        "the knob moves by inset-inline-start, not by a transform");
    assert.ok(!/switch[^{]*\{[^}]*transform\s*:/s.test(css.split("---- Finance")[0]),
        "no transform on the switch: that is the bug this project wrote down once");
});
