// Guards on the shared design system.
//
// The kit in app/js/ui/ and the stylesheet in app/css/ are only worth having if
// nothing quietly grows a second copy of something. These four tests are the
// cheap, mechanical version of that: they read the source and fail on the
// specific ways this app duplicated itself before — an icon drawn twice, a
// breakpoint invented at a call site, a raw glyph from outside the registry, and
// a page that writes its own markup instead of the kit's.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { ICONS, NAV_ICON_NAMES } from "../app/js/ui/icons.js";
import { DESTINATIONS, NAV_LAYERS, NAV_SECTIONS, MORE_PATH } from "../app/js/ui/components/nav.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

// Comments are prose about the design, and several of them quote the very things
// the scans below are looking for ("it used to be a literal ✕"). Strip them so a
// note about the old code cannot fail a test about the new code.
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// Every .js file under app/js, so a new file is covered without editing this.
const jsFiles = [];
(function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js")) jsFiles.push(p);
    }
})("app/js");

const cssFiles = ["app/css/tokens.css", "app/css/base.css", "app/css/layout.css", "app/css/components.css"];

// ---------------------------------------------------------------- icons -----

test("every icon name the app asks for exists in the registry", () => {
    // `uiIcon("…")` and `icon: "…"` are the only two ways a name reaches the
    // screen. A typo in either would otherwise throw at first render.
    const asked = new Set();
    for (const file of jsFiles) {
        const src = code(read(file));
        for (const m of src.matchAll(/uiIcon\(\s*["']([a-zA-Z0-9_]+)["']/g)) asked.add(m[1]);
        for (const m of src.matchAll(/\bicon:\s*["']([a-zA-Z0-9_]+)["']/g)) asked.add(m[1]);
    }
    const unknown = [...asked].filter(n => !(n in ICONS));
    assert.deepEqual(unknown, [], `not in ICONS: ${unknown.join(", ")}`);
    // Sanity: the scan found something, so an empty result cannot pass by accident.
    assert.ok(asked.size > 30, `only found ${asked.size} icon names — the scan is broken`);
});

test("no two icons in the registry are the same drawing", () => {
    // The duplication this replaced: the income arrow existed in icons.js and
    // again in finance-fields.js under a different name, and the clock and the
    // bookmark existed twice more as inline path data at a call site.
    const seen = new Map();
    const clashes = [];
    for (const [name, paths] of Object.entries(ICONS)) {
        const key = JSON.stringify(paths);
        if (seen.has(key)) clashes.push(`${name} === ${seen.get(key)}`);
        else seen.set(key, name);
    }
    assert.deepEqual(clashes, [], `duplicate drawings: ${clashes.join(", ")}`);
});

test("icon maps name registry entries, not path data", () => {
    // A map that hands the picker or a component raw paths works right up until
    // uiIcon() is handed one and throws at first render — which is how the
    // Finance type picker failed on its first open. Anything called *_ICONS is a
    // name map and nothing else.
    const offenders = [];
    for (const file of jsFiles) {
        // The registry itself is the one place paths are allowed to live.
        if (file === "app/js/ui/icons.js") continue;
        const src = code(read(file));
        for (const m of src.matchAll(/(?:const|let)\s+(\w*_ICONS)\s*=\s*\{([\s\S]*?)\n\}/g)) {
            for (const v of m[2].matchAll(/:\s*([^,\n]+)/g)) {
                const value = v[1].trim().replace(/^["']|["']$/g, "");
                if (!(value in ICONS)) offenders.push(`${relative(root, join(root, file))} → ${m[1]}.* = "${value}"`);
            }
        }
    }
    assert.deepEqual(offenders, [], `icon maps carrying something other than a name: ${offenders.join(", ")}`);
});

test("no SVG path data outside the registry", () => {
    // A path string is a drawing. Anything that looks like one outside
    // ui/icons.js is a private copy, which is exactly what must not happen.
    const DRAWING = /"M[\d.,\- ]+[a-zA-Z]/;
    const offenders = [];
    for (const file of jsFiles) {
        if (file === "app/js/ui/icons.js") continue;
        const src = code(read(file));
        if (DRAWING.test(src)) offenders.push(relative(root, join(root, file)));
    }
    assert.deepEqual(offenders, [], `raw path data in: ${offenders.join(", ")}`);
});

test("the navigation covers every destination and nothing extra", () => {
    // NAV_ICON_NAMES is keyed by route; main.js is the route table. They must be
    // the same set, or a destination has no glyph or a glyph has no page.
    //
    // The filter is the list of screens that are NOT destinations. A detail
    // screen under one — /tasks/new, /finance/debts/new — is excluded, and so is
    // /settings/install for the same reason: it is a screen inside Settings, and
    // giving it a row of its own would make a thing a person does once into
    // somewhere they live.
    //
    // /share and /quick are excluded for a different reason and it is the same
    // one: they are not screens anybody navigates to, they are ADDRESSES that
    // something else opens — the OS share sheet, a launcher long-press, a
    // bookmark, an iOS Shortcut. A row for either would be somewhere to go with
    // no reason to be there, and both are already reachable from Settings, which
    // is where a person looks for them.
    const main = read("app/js/main.js");
    const routes = [...main.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map(m => m[1]);
    const navPaths = routes.filter(p => !p.includes(":") && p !== "/404" && !p.startsWith("/finance/") && !p.startsWith("/later/") && !p.startsWith("/tasks/") && !p.startsWith("/sessions/") && !p.startsWith("/settings/") && !p.startsWith("/routines/") && p !== "/session" && p !== "/share" && p !== "/quick");
    assert.deepEqual(Object.keys(NAV_ICON_NAMES).sort(), navPaths.sort());
    for (const name of Object.values(NAV_ICON_NAMES)) {
        assert.ok(name in ICONS, `nav icon "${name}" is not in the registry`);
    }
});

// The glyph a destination gets is chosen from the same registry as every other
// icon, so this cannot be a private copy. The important thing here is the ORDER:
// nav.js and icons.js each hold it, and nothing forces them to agree, so the two
// can drift and a menu can then say a different screen matters more than the
// header's button does.
test("the destinations are ordered the same way in both lists", () => {
    // The order is not alphabetical and it is not the order the routes happen to be
    // registered in. It is the order of PRIORITY — the person, then today's work,
    // then the services, then the tools that organise them, then the settings —
    // and it is stated in full exactly once, here in nav.js's layers.
    assert.deepEqual([...DESTINATIONS, MORE_PATH], Object.keys(NAV_ICON_NAMES),
        "nav.js and NAV_ICON_NAMES must list the destinations in the same order");

    // The one list, flattened: the person first, then every layer in order. Nothing
    // may be dropped by being in a layer and not in the list, and nothing may be in
    // the list twice — a destination offered under two headings is one link with
    // no reason for either.
    const flattened = ["/", ...NAV_LAYERS.flatMap(layer => layer.paths)];
    assert.deepEqual([...DESTINATIONS], flattened, "DESTINATIONS is the person plus the layers, in order");
    assert.equal(new Set(DESTINATIONS).size, DESTINATIONS.length, "and no destination is listed twice");

    // The menu draws the same layers, with the person alone above them. So the
    // sheet in the header and the page at /more are reading one list, and the two
    // cannot hold different answers to "what exists".
    assert.deepEqual([...NAV_SECTIONS], [{ key: null, icon: "home", paths: ["/"] }, ...NAV_LAYERS]);
    const inMenu = NAV_SECTIONS.flatMap(section => section.paths);
    assert.deepEqual([...inMenu].sort(), [...DESTINATIONS].sort(),
        "the menu and the destination list cover the same screens");
    // And the menu is not a destination — it is the door into the list, which is
    // why it is last in the icon map and is not in the layers.
    assert.equal(DESTINATIONS.includes(MORE_PATH), false, "the menu is not one of its own entries");
});

// A screen that is not in the navigation must still be reachable from the screen
// that matters, or "not a destination" only means "hidden". /share and /quick are
// the cases now that there is a single menu rather than a bar with a More row:
// both are reached from Settings, which is where a person looks for them.
test("a destination kept out of the menu is still linked from the app", () => {
    const settings = code(read("app/js/ui/pages/settings.js"));
    assert.match(settings, /href: "\/settings\/install"/,
        "Settings must offer a way into the install page");
    assert.match(settings, /href: "\/quick"/,
        "Settings must offer a way into the quick actions page");
    const install = code(read("app/js/ui/pages/install.js"));
    // And each must be a real screen, with a way in and a way out of it.
    assert.match(install, /pageHead\(/);
    assert.match(install, /backTo\(/);
    const quick = code(read("app/js/ui/pages/quick.js"));
    assert.match(quick, /pageHead\(/);
});

// ---------------------------------------------------------- breakpoints -----

test("every @media uses a value from the scale documented in tokens.css", () => {
    // The scale is a comment in tokens.css, so the list of allowed values is read
    // out of it rather than duplicated here. A breakpoint typed anywhere else
    // fails this test until it is given a reason in that comment.
    const tokens = read("app/css/tokens.css");
    const documented = new Set();
    for (const m of tokens.matchAll(/(?:min|max)-(?:width|height)\s+(\d+)px/g)) {
        documented.add(m[1]);
    }
    assert.ok(documented.size >= 8, `only ${documented.size} values documented in tokens.css`);

    const used = [];
    for (const file of cssFiles) {
        const src = read(file);
        for (const m of src.matchAll(/@media[^{]*\{/g)) {
            for (const q of m[0].matchAll(/(?:min|max)-(?:width|height)\s*:\s*(\d+)px/g)) {
                used.push({ file, value: q[1] });
            }
        }
    }
    assert.ok(used.length > 8, `only found ${used.length} media features — the scan is broken`);

    const undocumented = used.filter(u => !documented.has(u.value));
    assert.deepEqual(
        undocumented.map(u => `${u.file} → ${u.value}px`),
        [],
        "breakpoints outside the documented scale"
    );
});

// ----------------------------------------------------------------- kit ------

test("no page assembles a row, a heading or an action bar by hand", () => {
    // The kit is only load-bearing if the pages actually use it. A page writing
    // `class: "list-row"` or `class: "title"` is bypassing the kit, and that is
    // how the three different page headers came about in the first place.
    const banned = [
        ["class: \"list-row\"", "a list row"],
        ["class: \"list-row ", "a list row"],
        ["class: \"title\"", "a page title"],
        ["class: \"section-header\"", "the retired section header"],
        ["class: \"share-target", "the retired share target"],
        ["class: \"row\"", "a loose flex row"],
        ["class: \"row\" ", "a loose flex row"]
    ];
    const offenders = [];
    for (const file of jsFiles) {
        // The kit is where these class names live, and the pages are what must
        // not write them. A component that needs one of them for a genuinely
        // different purpose is a discussion, not a silent pass.
        if (file.startsWith("app/js/ui/components/ui.js")) continue;
        const src = code(read(file));
        for (const [needle, what] of banned) {
            if (src.includes(needle)) offenders.push(`${relative(root, join(root, file))} → ${what}`);
        }
    }
    assert.deepEqual(offenders, [], `bypassed the kit: ${offenders.join(", ")}`);
});

test("no glyph from outside the icon registry is written into the DOM", () => {
    // The ✕ and ✓ characters that used to be hardcoded are the whole reason the
    // checklist and the remove control looked different from everything else.
    const offenders = [];
    for (const file of jsFiles) {
        const src = code(read(file));
        for (const m of src.matchAll(/"(\u2715|\u2713|\u2714|\u25CB|\u00D7|\u2022)"/g)) {
            offenders.push(`${relative(root, join(root, file))} → ${m[1]}`);
        }
    }
    assert.deepEqual(offenders, [], `hardcoded glyphs: ${offenders.join(", ")}`);
});

/* -------------------------------------------------------------------------- */
/* Inline styles and the CSP                                                  */
/* -------------------------------------------------------------------------- */

// This app ships `Content-Security-Policy: style-src 'self'`, so a `style`
// ATTRIBUTE is refused by the browser. `el.setAttribute("style", …)` still
// writes the attribute and still reports success, and the element comes out
// completely unstyled — the one failure mode in the whole UI layer that leaves
// no trace in a test and only one line in a console.
//
// The factory is fixed for it, but the fix has to stay fixed, and the check
// below is the only thing that would notice it being undone.
test("the element factory applies a style prop through the CSSOM, not the attribute", () => {
    const src = code(read("app/js/ui/dom.js"));

    assert.ok(
        !/setAttribute\(\s*["']style["']/.test(src),
        "dom.js must not set the style attribute: style-src 'self' refuses it and the element renders unstyled"
    );
    assert.match(
        src,
        /el\.style\.cssText\s*=/,
        "a string style prop must be applied as CSS text on the style object"
    );
});

// And the rest of the app must go through the factory rather than reaching for
// the attribute itself, which is the same refusal with more steps.
test("no module sets a style attribute directly", () => {
    const offenders = [];
    for (const file of jsFiles) {
        if (file.endsWith("app/js/ui/dom.js")) continue;
        const src = code(read(file));
        for (const m of src.matchAll(/\.setAttribute\(\s*["']style["']/g)) {
            offenders.push(`${relative(root, join(root, file))}`);
        }
        for (const m of src.matchAll(/\.style\.cssText\s*=/g)) {
            offenders.push(`${relative(root, join(root, file))} (cssText)`);
        }
    }
    assert.deepEqual(offenders, [], `inline style bypasses: ${offenders.join(", ")}`);
});

// A custom property is the one thing the app genuinely has to compute at
// runtime — a bar's height, the ring's sweep — and the stylesheet reads it with
// `var()`. If the rule that reads one is deleted, every element depending on it
// silently collapses to its default rather than erroring, so the pairing is
// worth asserting in both directions.
test("every custom property the components write is read by the stylesheet, and vice versa", () => {
    const css = read("app/css/components.css");
    const tokens = read("app/css/tokens.css");
    const read_ = new Set();
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) read_.add(m[1]);
    // Declared anywhere in the stylesheet: the token file is where the palette
    // lives, and a component that invents its own colour is the thing worth
    // catching, not one that uses a token.
    const declared = new Set(
        [...(css + tokens).matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])
    );

    // Written at runtime by the two display components.
    const display = code(read("app/js/ui/components/display.js"));
    const written = new Set([...display.matchAll(/["'`:]\s*(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));

    assert.ok(written.size > 0, "the scan is broken: it found no custom property being written");
    for (const prop of written) {
        assert.ok(read_.has(prop), `${prop} is written by display.js but no rule in components.css reads it`);
    }

    // And nothing in the component file reads a property nothing declares: that
    // is a rule that silently does nothing, which is how a design drifts into
    // having two names for one colour. A `var()` that carries its own fallback
    // is exempt — that is the runtime-computed case, and the fallback is the
    // declaration.
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([^)]*)\)/g)) {
        if (m[2].includes(",")) continue;
        assert.ok(
            declared.has(m[1]),
            `${m[1]} is read without a fallback by a rule in components.css but never declared anywhere`
        );
    }
});

// ------------------------------------------------------- attachment screens ---

// The recorder is the one screen in the app that ANSWERS a dialog with a value
// from inside the dialog's own body rather than from its footer button, and it
// got that wrong the first time.
//
// `dialog.close()` dismisses: it resolves the pending promise with CANCELLED and
// throws away anything it was given. A recording that finished and called it
// therefore produced nothing at all — thirty seconds recorded, note saved without
// it, and no error anywhere. The only way to answer is the `close` the body
// builder is handed, which is what every other dialog here does.
//
// This is a source assertion because there is no DOM in this suite, and because
// the failure mode is silent: the code reads correctly and does nothing.
test("a dialog that returns a value answers through the close it was given", () => {
    const src = code(read("app/js/ui/components/recorder.js"));
    // The body must take the callback…
    assert.match(src, /body:\s*close\s*=>/,
        "the dialog body must receive the close callback");
    // …and hand it to whatever draws the dialog, so the button can call it.
    assert.match(src, /buildBody\(\{[^}]*close\b/,
        "the close callback must reach the body builder");
    // …and the value must go out through it.
    assert.match(src, /close\(\{\s*blob/,
        "the recording must be handed back with close(), not with dialog.close()");
    assert.ok(!/dialog\.close\(/.test(src),
        "dialog.close() discards its argument; it is for dismissing, not answering");
    // The dismissal path still has to be handled, and by identity: CANCELLED is a
    // Symbol, and a falsy check on it would pass for a value that never came.
    assert.match(src, /=== dialog\.CANCELLED/,
        "a dismissed recording is null, not the CANCELLED sentinel");
});

// A recording left running is a phone that records into a closed stream. The
// dialog's own dismissal is the path that reaches it, and nothing else in the
// app would stop the recorder.
test("a dismissed recorder is stopped, and its timer is cleared", () => {
    const src = code(read("app/js/ui/components/recorder.js"));
    const capture = code(read("app/js/app/capture.js"));
    // The teardown has to be reachable from the caller's `finally`, which runs on
    // the dismissed path as well as the completed one.
    assert.match(src, /handle\.cancel\?\.\(\)/,
        "the recorder must be cancelled on every exit path, including a dismissal");
    // …and it has to cancel the recorder itself, not just the repaint interval.
    assert.match(src, /active\?\.cancel\(\)/,
        "the MediaRecorder must be stopped, not only its readout");
    // The cancel exists, and it clears the clock that would otherwise stay armed
    // for thirty minutes with nothing that could fire.
    assert.match(capture, /cancel\(\)\s*\{[\s\S]*?clearTimeout\(clock\)/,
        "cancel() must clear the duration timer");
});

// The level meter, on the path where a recording succeeds — and the one that was
// broken.
//
// A completed recording releases the meter TWICE: `onStop` releases it as the
// blob is handed to the dialog, and then the caller's `finally` cancels that same
// dialog on its way out. `AudioContext.close()` is asynchronous and rejects with
// InvalidStateError when the context is already closed, so the second close was a
// floating rejected promise — no `try` can catch that — and it fired the window's
// unhandled-rejection handler at the exact moment the recording landed. Twelve
// bars of meter, reported to the person recording as a lost voice memo.
test("the level meter is torn down once, and survives being asked twice", () => {
    const src = code(read("app/js/ui/components/recorder.js"));
    // The repaint loop and the context are separate lifetimes, because a "too
    // short" attempt ends one recording without ending the dialog: the second
    // attempt inherited a closed context and an unscheduled loop, which is twelve
    // frozen bars on the one screen where somebody is checking they are audible.
    assert.match(src, /const release = \(\) => \{[\s\S]*?meter\?\.stop\(\);[\s\S]*?\};/,
        "release() must stop the repaint loop");
    assert.match(src, /begin = \(\) => \{[\s\S]*?meter\?\.start\(\);/,
        "every attempt must start the meter, or a retry records in silence with a dead readout");
    assert.match(src, /stopEverything = \(\) => \{[\s\S]*?meter\?\.dispose\(\);/,
        "only the dialog's teardown may close the context; the attempts share it");
    // Idempotence, which is what the second call needs: after one dispose there
    // is no context left to close.
    assert.match(src, /dispose\(\)\s*\{[\s\S]*?const closing = audio;\s*audio = null;/,
        "dispose() must forget the context it closed, or a second call has something left to close");
    assert.match(src, /if \(!closing \|\| closing\.state === "closed"\) return;/,
        "dispose() with nothing to close must return instead of calling close() on a dead context");
    // And the rejection has to be handled where the promise is created. Every
    // caller is a teardown that has returned by the time it settles, so there is
    // nowhere further up for it to land.
    assert.match(src, /closing\.close\(\)\?\.catch\(/,
        "close() must have its rejection caught at the call site");
    // The shape that let it through in the first place.
    assert.doesNotMatch(src, /try \{\s*audio\?\.close\(\);\s*\} catch/,
        "a try around close() cannot catch its rejection, and must not be mistaken for a guard");
});

// The counts are on a list row, in two languages, and the translation layer
// substitutes parameters and does nothing else. "{count} photos" therefore
// rendered as "1 photos", and the fix is choosing the key from the count rather
// than a plural rule nothing here has.
test("a count picks its singular form, and neither form says file(s)", () => {
    const src = code(read("app/js/ui/components/attachments.js"));
    assert.match(src, /count === 1 \? `attachments\.one\$\{name\}` : `attachments\.count\$\{name\}`/,
        "a count of one must use the singular key");
    const strings = read("app/js/i18n/strings.js");
    for (const kind of ["Photo", "Audio", "Video", "Document"]) {
        // Defined in both languages, or one of them reads "1 photos".
        for (const key of [`one${kind}:`, `count${kind}:`]) {
            const hits = (strings.match(new RegExp(`\\n\\s*${key}`, "g")) || []).length;
            assert.equal(hits, 2, `attachments.${key} is not defined for both en and ar`);
        }
    }
    // "(s)" is the thing a parameter-substituting layer cannot do, and it was in
    // the share target's own label. Read through `code()` because this test's own
    // comment quotes one, and a note about the old wording must not fail a test
    // about the new wording.
    assert.ok(!/\{\w+\} file\(s\)/.test(code(strings)), "no label may lean on file(s) for its plural");
});

// The chooser used to `await` the file download before appending anything, so a
// five-megabyte clip on a phone leaving Wi-Fi was several seconds of a page that
// had rendered nothing. The text share is savable in that time, so it is offered
// in that time.
test("the share chooser renders the text share before fetching the files", () => {
    const src = code(read("app/js/ui/pages/share.js"));
    const append = src.indexOf("root.append(");
    const fetch = src.indexOf("readSharedShare(");
    assert.ok(append > 0 && fetch > 0, "the scan is broken");
    assert.ok(append < fetch,
        "the page must be on screen before the shared files are fetched");
    // …and the fifth target is added afterwards rather than rendered from the
    // start with a count it does not have yet.
    assert.match(src, /grid\.prepend\(/,
        "the file target is prepended once the files are known");
});
