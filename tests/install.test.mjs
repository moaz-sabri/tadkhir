// The install page, and the platform guessing behind it.
//
// Two things are being pinned here. The first is that the page covers every way
// there is, because `beforeinstallprompt` reaches exactly one of the four and a
// page written for the other three would tell a third of its readers to do
// something their browser cannot do. The second is that the guessing never
// decides anything: it only reorders a page that already contains every answer,
// so a wrong guess costs a reader a glance and never a step.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

// Comments are prose about the design, and several of them quote the very things
// these scans look for. Stripped so a note about the old code cannot fail a test
// about the new code.
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const page = read("app/js/ui/pages/install.js");
const pageCode = code(page);
const platform = read("app/js/app/platform.js");
const swRegister = read("app/js/app/sw-register.js");
const main = read("app/js/main.js");

/* -------------------------------------------------------------------------- */
/* Every platform, not one                                                     */
/* -------------------------------------------------------------------------- */

test("all four install routes are on the page", () => {
    // Chromium (desktop and Android), iOS, and desktop Firefox. A page that
    // covered only the one with an API would be a page that fails for the
    // majority of its readers.
    //
    // The steps are read through one template (`install.${id}Steps`) rather than
    // four literals, so what is asserted here is the four ids and that one
    // template — a fourth platform added to PLATFORMS without a string behind it
    // would render the key itself, which check-i18n.mjs is what would catch.
    for (const id of ["android", "ios", "desktop", "firefox"]) {
        assert.ok(pageCode.includes(`id: "${id}"`), `the ${id} block is missing`);
    }
    assert.match(pageCode, /t\(`install\.\$\{id\}Steps`\)/, "one template reads the steps");
});

test("the reader's own platform is marked, and only one is", () => {
    // A tag beside each name rather than a line above it, so it is found by
    // scanning four titles. And exactly one, because a page that marked two has
    // stopped answering the question it asked.
    assert.match(pageCode, /isYours \? h\("span", \{ class: "badge" \}/);
    assert.match(pageCode, /p\.id === yours/, "the marker follows the detection");
    assert.match(pageCode, /\.\.\.PLATFORMS\.filter\(p => p\.id === yours\),\s*\n\s*\.\.\.PLATFORMS\.filter\(p => p\.id !== yours\)/,
        "the detected one is moved to the front, not the only one shown");
});

test("a guessing error only costs a glance, never a step", () => {
    // The property that makes a heuristic safe to ship on this page: nothing is
    // filtered out. If every block is always rendered, then a wrong detection
    // reorders the page and nothing else.
    const body = pageCode.slice(pageCode.indexOf("pageSection({"), pageCode.indexOf("body: h(\"div\", { class: \"install-steps\""));
    assert.doesNotMatch(body, /\bfilter\([^)]*PLATFORMS[^)]*\)\s*:\s*null/, "no platform may be dropped");
    assert.match(pageCode, /\.\.\.ordered\.map\(/, "every ordered block is rendered");
});

test("iOS carries the one warning, because it is the one with no button", () => {
    // Only iOS has something the reader cannot work out from the steps: there is
    // no install button anywhere on it, and no way for a page to add one. A
    // warning on the other three would be noise about a menu item they can see.
    const blocks = [...pageCode.matchAll(/\{ id: "(\w+)", icon: "\w+", note: (null|"[\w.]+") \}/g)];
    assert.equal(blocks.length, 4, "every platform declares a note or its absence");
    const withNote = blocks.filter(b => b[2] !== "null").map(b => b[1]);
    assert.deepEqual(withNote, ["ios"], "only iOS has a note");
});

/* -------------------------------------------------------------------------- */
/* The button, which may only exist where it works                             */
/* -------------------------------------------------------------------------- */

test("the install button is drawn only where the browser has offered one", () => {
    // The same rule the Settings row already followed, applied to a page whose
    // whole subject is the rule. A dead button beside working instructions is
    // worse than no button: it says the device cannot do what the steps say.
    const control = pageCode.slice(
        pageCode.indexOf("const installControl"),
        pageCode.indexOf("root.append(page(")
    );
    assert.match(control, /installed\s*\n\s*\? card\(/, "installed comes first");
    assert.match(control, /: canInstall\(\)\s*\n\s*\? card\(/, "then the offer");
    assert.match(control, /:\s*null;?$/m, "and nothing at all when there is neither");
    assert.match(control, /promptInstall\(\)/, "the button uses the held event");
});

test("already installed is said plainly, and offers nothing to click", () => {
    // The one state where an install button would be a lie: it is already done.
    assert.match(pageCode, /const installed = isInstalled\(\)/);
    assert.match(pageCode, /installed\s*\n\s*\? card\(/, "installed takes precedence over the offer");
});

test("the install offer is caught at module scope, not during boot", () => {
    // The event fires once per document, and early — after load, while the app is
    // still booting. registerServiceWorker() runs at the END of boot, so a
    // listener attached there misses the event on any document that got there
    // first, and the control is present on one page and missing from the next.
    // It was observed doing exactly that.
    const body = code(swRegister);
    const fnStart = body.indexOf("export function registerServiceWorker()");
    const fnEnd = body.indexOf("async function promptInstall");
    const boot = body.slice(fnStart, fnEnd);
    assert.doesNotMatch(boot, /beforeinstallprompt/, "the listener must not be inside registerServiceWorker()");
    assert.match(body, /^window\.addEventListener\("beforeinstallprompt"/m, "it must be attached at module scope");
    // The service worker registration itself stays where it was: that is about the
    // worker's lifecycle, not about the event. The second argument is the update
    // check being told to bypass the HTTP cache, so it is matched separately —
    // a registration with options still has to be the registration this asserts.
    assert.match(boot, /navigator\.serviceWorker\.register\("\/sw\.js"/);
});

/* -------------------------------------------------------------------------- */
/* The detection itself                                                         */
/* -------------------------------------------------------------------------- */

test("the iPad is not mistaken for a Mac", () => {
    // iPadOS 13+ reports platform "MacIntel" and a user agent containing
    // "Macintosh". Without the touch-point check every iPad is told to install
    // Chrome on a computer, which it cannot do.
    assert.match(platform, /iPadOSAsMac\s*=\s*\/Macintosh\/\.test\(ua\)\s*&&\s*\(navigator\.maxTouchPoints \|\| 0\) > 1/);
    // And the check has to come BEFORE the desktop branch, or it is never reached.
    const body = code(platform);
    const iosAt = body.indexOf("iPadOSAsMac");
    const macAt = body.search(/\/Windows\|Macintosh\|Linux\|CrOS\//);
    assert.ok(iosAt > -1 && macAt > iosAt, "iOS must be decided before the desktop branch");
});

test("Android is decided before Firefox and before the fallback", () => {
    // Chrome on Android contains both "Android" and "Chrome"; Firefox on Android
    // contains both "Android" and "Firefox". The order is what makes the answer
    // right, so it is asserted rather than described.
    //
    // Read from the RAW file: `/Firefox\//` ends in two slashes, and the comment
    // stripper used elsewhere in this suite would cut the line in half there.
    assert.ok(platform.indexOf("/Android/") < platform.indexOf("/Firefox\\//"), "Android before Firefox");
    assert.ok(platform.indexOf("/Firefox\\//") < platform.lastIndexOf('return "desktop"'), "Firefox before the fallback");
});

test("a platform is always returned, and it is one the page has a block for", () => {
    // The page indexes into its blocks by this string, so a value with no block
    // would silently mark nothing.
    assert.match(platform, /if \(typeof navigator === "undefined"\) return "desktop"/, "no navigator, no crash");
    const ids = [...code(page).matchAll(/id: "(\w+)", icon:/g)].map(m => m[1]);
    const returned = [...platform.matchAll(/return "(\w+)"/g)].map(m => m[1]);
    for (const id of ids) {
        assert.ok(returned.includes(id), `detectedPlatform can return "${id}" with no block for it`);
    }
});

/* -------------------------------------------------------------------------- */
/* Where the page lives                                                         */
/* -------------------------------------------------------------------------- */

test("the page is a real route, and not a destination", () => {
    assert.match(main, /path: "\/settings\/install"/, "the route must exist");
    assert.match(main, /import \{ installPage \}/);
    // Not in the navigation, and not as a tab: ui.test.mjs enforces that the nav
    // covers exactly the non-detail routes, and /settings/ is excluded for the
    // same reason /tasks/ is — it is a screen inside a destination.
    assert.doesNotMatch(read("app/js/ui/components/nav.js"), /\/settings\/install/);
    assert.doesNotMatch(main, /NAV_ICON|nav_/, "no icon is invented for it");
});

test("Settings links to it, and the row works without a page reload", () => {
    const settings = read("app/js/ui/pages/settings.js");
    assert.match(settings, /href: "\/settings\/install"/, "the row must be a link");
    assert.match(code(settings), /listRow\(\{/, "and it must be a kit row, not hand-built markup");
    // data-link, which is what makes it a client navigation — and that matters,
    // because a real page load discards the held install event.
    assert.match(pageCode, /backTo\("\/settings"\)/, "and the page can go back");
});

test("every string the install page reads exists in both languages", () => {
    // check-i18n.mjs covers the literal call sites; this asserts the group is
    // wired up at all, which it cannot know, and that the templated keys — which
    // the scan cannot see either, because they are built at runtime — have a
    // string behind them in BOTH languages.
    const strings = read("app/js/i18n/strings.js");
    const enAt = strings.indexOf("install: {");
    const arAt = strings.indexOf("install: {", enAt + 1);
    assert.ok(enAt > 0 && arAt > enAt, "both locales must carry an install group");

    const enGroup = strings.slice(enAt, arAt);
    const arGroup = strings.slice(arAt, strings.indexOf("error: {", arAt));

    // The templated keys, spelled out. A platform added to PLATFORMS without one
    // of these behind it renders the key itself, and nothing else catches that.
    for (const id of ["android", "ios", "desktop", "firefox"]) {
        for (const suffix of ["", "Steps"]) {
            const key = `${id}${suffix}:`;
            assert.ok(enGroup.includes(key), `en is missing install.${key}`);
            assert.ok(arGroup.includes(key), `ar is missing install.${key}`);
        }
    }
    assert.ok(enGroup.includes("iosNote:") && arGroup.includes("iosNote:"), "both locales need the iOS note");
    for (const key of ["title:", "lead:", "benefitsTitle:", "stepsTitle:", "yours:", "installNow:", "installed:", "installedHint:"]) {
        assert.ok(enGroup.includes(key) && arGroup.includes(key), `both locales need install.${key}`);
    }
    // And the literal keys the page reads with t("install.x").
    const literals = [...new Set([...pageCode.matchAll(/t\("(install\.[\w.]+)"\)/g)].map(m => m[1].split(".")[1]))];
    assert.ok(literals.length >= 5, `the scan found only ${literals.length} literal keys`);
    for (const key of literals) {
        assert.ok(enGroup.includes(`${key}:`), `en is missing install.${key}`);
        assert.ok(arGroup.includes(`${key}:`), `ar is missing install.${key}`);
    }
});
