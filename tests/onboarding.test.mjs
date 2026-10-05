// The first-run gate, and the two rules that keep it from becoming an
// interruption.
//
// The flow is the one piece of the app that can put itself in front of a screen
// the user did not ask for, so the tests below are mostly about WHEN IT MUST NOT
// APPEAR. A welcome screen that shows once is a feature; one that shows on every
// launch, or over somebody's year of data, is a bug nobody can report usefully
// because it looks exactly like the feature working.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.mjs";

installFakeIndexedDB();

const { hasSeenOnboarding, markOnboardingSeen, shouldRunOnboarding } = await import("../app/js/app/first-run.js");

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

// Comments are prose about the design, and several of them quote the very things
// these scans look for. Stripped so a note about the old code cannot fail a test
// about the new code.
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/* -------------------------------------------------------------------------- */
/* When the flow runs                                                           */
/* -------------------------------------------------------------------------- */

test("a virgin device with no key and no records is the only case that runs it", async () => {
    assert.equal(await hasSeenOnboarding(), false, "the flag starts unset");
    assert.equal(
        await shouldRunOnboarding({ hasKeys: false, taskCount: 0 }),
        true,
        "a brand new device is exactly who this is for"
    );
});

test("a device with records is in use, and is not interrupted", async () => {
    // The permissive direction is the expensive mistake: a user with a year of
    // sessions is shown a welcome screen on every launch and has no way to argue
    // with it. One task is enough to close this.
    assert.equal(await shouldRunOnboarding({ hasKeys: false, taskCount: 1 }), false);
});

test("a device that already has a key was set up, however it got one", async () => {
    // Set up by a previous version of the app, by importing a backup, or by hand
    // in Settings. None of those wrote a first-run flag, and all of them are
    // finished; asking again is a welcome screen over somebody's data.
    assert.equal(await shouldRunOnboarding({ hasKeys: true, taskCount: 0 }), false);
});

test("the flag is written once and read back, and is idempotent", async () => {
    await markOnboardingSeen();
    assert.equal(await hasSeenOnboarding(), true);
    // Every exit from the flow calls this, so a second write must not be an error
    // its caller has to know about.
    await markOnboardingSeen();
    assert.equal(await hasSeenOnboarding(), true);
});

test("a device that has seen the flow never sees it again", async () => {
    // markOnboardingSeen() ran in the test above, so the flag is set for the rest
    // of the file. This is the case that matters most: a skip is a decision, and
    // showing the flow again on the next launch is how a first-run screen gets
    // described as broken.
    assert.equal(await shouldRunOnboarding({ hasKeys: false, taskCount: 0 }), false);
});

test("the flag alone decides, whichever way the rest of the device looks", async () => {
    // Every combination, so no combination can slip through as an interruption.
    const virgin = await hasSeenOnboarding();
    assert.equal(virgin, true, "the flag is set from here on");
    for (const hasKeys of [false, true]) {
        for (const taskCount of [0, 1, 500]) {
            assert.equal(
                await shouldRunOnboarding({ hasKeys, taskCount }),
                false,
                `hasKeys=${hasKeys} taskCount=${taskCount} must not run the flow`
            );
        }
    }
});

/* -------------------------------------------------------------------------- */
/* Where the flag lives                                                         */
/* -------------------------------------------------------------------------- */

test("the flag is its own meta key, not a setting", () => {
    // This is the whole design of app/first-run.js. `settings` is synced wholesale
    // between devices, so a flag stored there would mean: finish onboarding on the
    // phone, and a tablet that has never seen the app silently skips it. Whether
    // you have been introduced to the app is a fact about the DEVICE.
    const src = code(read("app/js/app/first-run.js"));
    assert.match(src, /SEEN_KEY\s*=\s*"onboardingSeen"/, "the flag must name its own key");
    assert.doesNotMatch(
        src,
        /metaRepo\([^)]*\)\.set\(\s*["']settings["']/,
        "the flag must not be written into settings, which syncs between devices"
    );
    assert.doesNotMatch(src, /localStorage/, "localStorage is not used in this app at all");
});

test("the flow needs no migration, because meta is keyed", () => {
    // A brand new key in a keyPath store reads as undefined, which is the correct
    // answer both for a fresh install and for every install made before this
    // feature existed. That is why the migrations file is untouched — and the
    // check below is what stops a later version adding a migration for it.
    const migrations = read("app/js/data/migrations.js");
    assert.doesNotMatch(migrations, /onboarding/i, "this needs no migration: a missing key reads as unset");
});

/* -------------------------------------------------------------------------- */
/* How it is reached                                                            */
/* -------------------------------------------------------------------------- */

test("the flow is not a route, and never appears in the navigation", () => {
    // A first-run screen is not a destination: it cannot be linked to, and giving
    // it a nav entry would make it a tab a user can return to for ever. The test
    // that matters is the route table, because a route there would also need a
    // NAV_ICON_NAMES entry — and the existing nav test would then be satisfied by
    // an entry that should not exist.
    const main = read("app/js/main.js");
    assert.doesNotMatch(main, /\{\s*path:\s*"[^"]*onboard/i, "onboarding must not be a route");

    // It is drawn over the shell and resolves into router.start(), which is the
    // only thing in the app allowed to do that.
    const flow = read("app/js/ui/components/onboarding.js");
    assert.match(flow, /router\.start\(\)/, "the flow must start the router when it is done");
    assert.match(code(main), /shouldRunOnboarding\(/, "main.js must ask before showing it");
});

test("the decision is asked about, never asserted, and never blocks the app", () => {
    // Two failure modes, both of which used to be one line of code in main.js.
    // A check that THROWS takes the whole boot down with it, so it is caught and
    // the app starts without the flow: a decision that cannot be made is a
    // decision not to interrupt.
    const main = code(read("app/js/main.js"));
    const start = main.slice(main.indexOf("async function startApp"));
    assert.match(
        start,
        /catch[\s\S]*?console\.warn[\s\S]*?catch \(e\)/,
        "a failed first-run check must be caught, and must warn"
    );
    assert.match(
        start,
        /if \(!firstRun\) \{[\s\S]*?await router\.start\(\);[\s\S]*?return true;/,
        "the app must start normally when the flow does not run"
    );
});

test("every exit from the flow writes the flag exactly once", () => {
    // Skip, finish and attach-a-key are three different buttons in three different
    // screens, and any of them navigating without writing the flag brings the
    // whole flow back on the next launch. One guard in one place is what makes
    // that impossible rather than merely intended.
    const flow = read("app/js/ui/components/onboarding.js");
    assert.match(flow, /if \(left\) return;/, "leave() must be safe to call twice");
    assert.match(flow, /const leave = async \(\{[\s\S]*?\} = \{\}\) =>/, "one exit, shared by every step");
    assert.equal(
        [...flow.matchAll(/markOnboardingSeen\(\)/g)].length,
        1,
        "the flag must be written in exactly one place"
    );
    // router.start() is what actually lets the user in, so it belongs to the same
    // guard as the flag — not to a step.
    assert.equal(
        [...flow.matchAll(/router\.start\(\)/g)].length,
        1,
        "the router must be started in exactly one place"
    );
});

test("finishing remembers, and skipping does not", () => {
    // The whole of the skip policy, in one place: `remember` defaults to true, so
    // every normal exit — finishing the brief, attaching a key — writes the flag,
    // and only the skip passes `false` and leaves the database untouched. A skip
    // is a way to look at the app now, not a decision to leave the key behind, so
    // the question comes back next time and the warning says so out loud.
    const flow = code(read("app/js/ui/components/onboarding.js"));
    assert.match(
        flow,
        /const leave = async \(\{ remember = true \} = \{\}\)/,
        "remembering must be the default, so a new exit cannot forget it"
    );
    assert.match(flow, /if \(remember\) \{[\s\S]*?markOnboardingSeen\(\)/, "the flag is behind the flag");
    assert.match(
        flow,
        /await leave\(\{ remember: false \}\)/,
        "the skip must pass remember: false, and nothing else may"
    );
    assert.equal(
        [...flow.matchAll(/leave\(\{/g)].length,
        1,
        "only the skip may pass an option to leave()"
    );
    // And no exit may write the flag by some other route — a raw call to the
    // marker outside leave() is exactly how the two policies drift apart.
    assert.equal(
        [...flow.matchAll(/markOnboardingSeen/g)].length,
        2,
        "one import, one call: the marker is reached only through leave()"
    );
});

test("the skip is behind a warning, and the warning is not dismissible by a tap", () => {
    // The consequence of having no key is that the data has no second copy and no
    // encryption, which is quiet enough that a glance will not catch it — so the
    // dialog states the facts and asks for a word to be typed. A bare confirm
    // dialog would be dismissed by the same reflex that opened it.
    const flow = code(read("app/js/ui/components/onboarding.js"));
    const warn = flow.slice(
        flow.indexOf("async function warnAboutSkipping"),
        flow.indexOf("function showWelcome")
    );

    // Every one of the four consequences is present, not just a general caution.
    for (const key of [
        "onboarding.skipWarnNone",
        "onboarding.skipWarnOne",
        "onboarding.skipWarnNoSync",
        "onboarding.skipWarnLoss",
        "onboarding.skipNotRemembered"
    ]) {
        assert.ok(warn.includes(key), `the warning must state ${key}`);
    }

    // Typed confirmation, and the check is case-insensitive: a phone keyboard
    // that capitalises the first letter would otherwise reject "OK" for its own
    // behaviour, which reads as the warning playing a trick.
    assert.match(flow, /const CONFIRM_WORD = "ok"/, "the word must not be translated");
    assert.match(warn, /input\.value\.trim\(\)\.toLowerCase\(\) !== CONFIRM_WORD/);
    assert.match(warn, /onboarding\.skipConfirmWrong/, "a wrong word must say so, with the dialog open");
    // The dialog stays open on a wrong word — it does not close and reopen.
    assert.doesNotMatch(warn, /close\([^)]*\);\s*\n\s*}\s*\n\s*submit:/, "submit must not close on failure");

    // A dismissal is not a skip: Escape, the backdrop and Cancel all leave the
    // flow exactly where it was.
    assert.match(warn, /if \(answer === dialog\.CANCELLED \|\| !answer\) return;/);
});

test("the warning fires from the skip on both screens that offer one", () => {
    // Two buttons, two screens, one function. If either of them ever called
    // leave() directly the warning would stop being shown for it, and that is
    // exactly the kind of change no test notices until somebody loses data.
    //
    // Scoped to the two skip buttons by their label rather than to every leave()
    // in the file: the brief's "start using Tadkhir" is a REMEMBERED exit and
    // must still be a plain leave().
    const flow = code(read("app/js/ui/components/onboarding.js"));
    const skipButtons = [...flow.matchAll(/onboarding\.(?:welcomeSkip|accessSkip)"[\s\S]{0,120}?onClick: \(\) => (\w+)\(\)/g)];
    assert.equal(skipButtons.length, 2, "both skip buttons must be found");
    for (const [, handler] of skipButtons) {
        assert.equal(handler, "warnAboutSkipping", `a skip button calls ${handler} instead of the warning`);
    }
    assert.equal(
        [...flow.matchAll(/warnAboutSkipping\(\)/g)].length,
        3,
        "the definition plus the two call sites: welcome and access"
    );
});

test("the flow hides the app chrome, and cannot leave it hidden", () => {
    // The navigation is empty while the flow is up — the router has not started,
    // so there is no current page for it to mark — and an empty navigation beside
    // a welcome screen reads as a broken app. A class on <body> is the only way to
    // reach the header and the add button, which are siblings of #app. The add
    // button is hidden for a second reason: it offers to record something, and the
    // screen still asking its questions has not been answered yet.
    const flow = code(read("app/js/ui/components/onboarding.js"));
    assert.match(flow, /classList\.add\(\s*"is-onboarding"\s*\)/);
    assert.match(flow, /classList\.remove\(\s*"is-onboarding"\s*\)/);
    // A closed tab, a discarded tab and a crash in one step all end without
    // calling leave(), so the class also has to come off on the way out.
    assert.match(
        flow,
        /addEventListener\(\s*"pagehide"/,
        "the chrome class must be dropped when the page goes away"
    );

    const base = read("app/css/base.css");
    assert.match(base, /body\.is-onboarding \.site-header/, "the header must be hidden while the flow is up");
    assert.match(base, /body\.is-onboarding \.fab-root/, "and the add button");
});

test("after a key is created the flow only goes forward", () => {
    // A Back from the "your key is ready" or the brief screen would lead to a
    // device that already has a key being offered a second one. Creating a second
    // key generates a new master key over the old one, which silently
    // invalidates the key file the previous screen just asked the user to save —
    // and that file is the only other way to open their data.
    const flow = code(read("app/js/ui/components/onboarding.js"));
    const created = flow.slice(
        flow.indexOf("function showCreated"),
        flow.indexOf("async function downloadKeyFile")
    );
    const brief = flow.slice(
        flow.indexOf("function showBrief"),
        flow.indexOf("window.addEventListener(\"pagehide\"")
    );
    assert.doesNotMatch(created, /back\(/, "the key-ready screen must not offer a way back");
    assert.doesNotMatch(brief, /back\(/, "and neither must the brief");

    // Before that point, going back is the point: the flow is a set of questions
    // and a person who realises they answered one wrong needs to be able to.
    const access = flow.slice(flow.indexOf("function showAccess"), flow.indexOf("function showCreate"));
    const create = flow.slice(flow.indexOf("function showCreate"), flow.indexOf("function showCreated"));
    assert.match(access, /back\(showWelcome\)/, "the access screen goes back to the welcome");
    assert.match(create, /back\(showAccess\)/, "and the create screen back to the access screen");
    // The import screen too: attaching a key that turns out to be the wrong one
    // is a mistake worth being able to walk back from, and it has created nothing.
    const importStep = flow.slice(flow.indexOf("function showImport"), flow.indexOf("function showBrief"));
    assert.match(importStep, /back\(showAccess\)/, "and the import screen back as well");
});

test("a device with a key is never offered a second one", () => {
    // The service would do it: authService.createSpace generates a fresh master
    // key and stores it over the old one. So the guard is the flow, and the only
    // route to createKey() is a screen reachable from the access screen, which is
    // itself unreachable once a key exists.
    const main = code(read("app/js/main.js"));
    const flow = code(read("app/js/ui/components/onboarding.js"));
    assert.equal(
        [...code(read("app/js/services/sync-service.js")).matchAll(/async createKey\(/g)].length,
        1,
        "there is one implementation of key creation"
    );
    // And the export path shares it, so creating a key from Settings and creating
    // one from the flow are the same act rather than two.
    const service = code(read("app/js/services/sync-service.js"));
    const createKey = service.slice(service.indexOf("async createKey("), service.indexOf("async exportSyncFile("));
    const exportNew = service.slice(service.indexOf("async exportSyncFile("), service.indexOf("finishExport("));
    assert.match(exportNew, /await this\.createKey\(\{/, "exportSyncFile must delegate to createKey");
    assert.doesNotMatch(createKey, /exportSyncFile/, "and createKey must not go through the file path");
    assert.match(flow, /syncService\.createKey\(\{/);
    assert.doesNotMatch(main, /createKey\(/, "and nothing else creates one");
});

test("every string the flow can show exists in both languages", () => {
    // The flow is the only place a brand new user reads the app, and a missing
    // key renders as the key itself — `onboarding.welcomeStart` on a welcome
    // screen. check-i18n.mjs already enforces the literal call sites; this
    // asserts the group is actually wired up, which it cannot know.
    const flow = read("app/js/ui/components/onboarding.js");
    assert.match(flow, /t\("onboarding\./, "the flow must read its copy from the strings");
    const strings = read("app/js/i18n/strings.js");
    const enStart = strings.indexOf("onboarding: {");
    const arStart = strings.indexOf("onboarding: {", enStart + 1);
    assert.ok(enStart > 0 && arStart > enStart, "both locales must carry an onboarding group");
});
