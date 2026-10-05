// The active-session bar: what it has to be able to do from any screen, and the
// two ways it is allowed to be wrong.
//
// It used to be a card with a link and nothing else, so the only way to pause a
// session was to open another screen and find the button there — on the one
// screen where the session is already the whole page. The bar now carries the
// control, which is the whole point of it, and the tests below are about the two
// things that can go wrong when a floating element grows a button:
//
//   it can be a link with a control inside it, which is invalid markup and makes
//   one tap mean two things;
//   and it can be a second source of truth about the session, which is how a bar
//   and a session screen end up disagreeing about whether the clock is running.

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

const chip = code(read("app/js/ui/components/session-chip.js"));
const strip = code(read("app/js/ui/components/session-strip.js"));
const panel = code(read("app/js/ui/components/session-panel.js"));
const css = read("app/css/components.css");

/* -------------------------------------------------------------------------- */
/* One link, one button, and neither inside the other                          */
/* -------------------------------------------------------------------------- */

test("the control is a sibling of the link, not a child of it", () => {
    // This is the markup decision the whole component is built around. The card
    // is a plain element; the link and the button are two children of it.
    assert.match(chip, /h\("div",\s*\{\s*\n?\s*class: "session-chip"/, "the card is a div, not an anchor");
    assert.match(chip, /class: "chip-open"[\s\S]*?href: "\/session"/, "the link opens the session screen");
    assert.match(chip, /class: "chip-actions"/, "the control has its own container");
    // `class: "chip-open"` opens an h() call; the control is built by action() and
    // appended beside it, so no button can be nested in the anchor.
    assert.doesNotMatch(chip, /h\("a"[\s\S]{0,400}action\(\{/, "no action() inside the anchor");
});

test("the control carries a name in the attributes, not only in the word", () => {
    // The word is dropped on a narrow screen to make room for the counter, so the
    // accessible name has to live in the attributes — which is where a screen
    // reader looks for it either way.
    assert.match(chip, /setAttribute\(\s*"aria-label"/, "the button must be named by attribute");
    assert.match(chip, /toggleBtn\.title = word/, "and by tooltip, for a pointer");
    assert.match(css, /\.chip-toggle \.chip-toggle-text\s*\{\s*display: none/, "the word is dropped on a narrow screen");
});

test("the control is rebuilt in place, so it does not lose focus", () => {
    // A fresh node per state change drops keyboard focus the moment a keyboard
    // user pressed the button, which is the one person guaranteed to notice.
    assert.match(chip, /toggleBtn\.replaceChildren\(/, "the button is mutated, not recreated");
    assert.doesNotMatch(chip, /actions\.replaceChildren\(/, "the container is never rebuilt");
    assert.equal(chip.match(/h\("button"/g), null, "the bar builds no button by hand");
});

/* -------------------------------------------------------------------------- */
/* One source of truth                                                          */
/* -------------------------------------------------------------------------- */

test("the bar pauses and resumes through the same service calls as the session screen", () => {
    // Not a second implementation of pausing. The same two calls, so the two
    // screens cannot drift apart.
    assert.match(chip, /sessionService\.pause\(\)/);
    assert.match(chip, /sessionService\.resume\(\)/);
    for (const call of ["sessionService.pause()", "sessionService.resume()"]) {
        assert.ok(
            panel.includes(call),
            `the session screen must make the same call: ${call}`
        );
    }
});

test("the bar redraws from the store, and applies nothing by hand", () => {
    // The service call ends in the same store notification every other pause does.
    // If the bar also wrote the new status into its own DOM it would have a second
    // answer to "is this running", and a rejected write would leave it wrong with
    // nothing to correct it — the button saying Resume while the clock runs on.
    assert.match(chip, /function live\(\)[\s\S]*?store\.getState\(\)\.active/, "the bar reads the active session from the store");
    const toggle = chip.slice(chip.indexOf("async function toggle()"), chip.indexOf("function writeTitle"));
    assert.doesNotMatch(toggle, /lastStatus\s*=/, "the handler must not write the state it is waiting on");
    assert.doesNotMatch(toggle, /setToggle\(/, "and must not redraw the control by hand");
    // It only redraws because render() observed a change, which is the same path
    // a change arriving from another tab or from sync takes.
    assert.match(chip, /if \(cur\.status !== lastStatus\)[\s\S]*?setToggle\(cur\.status\)/, "the control follows what it observes");
});

test("a second tap while the first is still landing is refused", () => {
    // A pause that lands after a resume leaves the bar reporting a state the
    // session is not in, and the store refresh would then correct it — after the
    // user has already seen the wrong one.
    assert.match(chip, /if \(busy\) return;/, "the handler must refuse a re-entry");
    assert.match(chip, /toggleBtn\.disabled = true;/, "and say so on the control");
    assert.match(chip, /toggleBtn\.disabled = false;/, "and give the control back");
});

test("a failed pause answers the same way every other failure in the app does", () => {
    assert.match(chip, /catch \(e\)[\s\S]*?toast\.show\(`error\./, "failures go through toast.show");
});

/* -------------------------------------------------------------------------- */
/* The bar, and the space it takes                                              */
/* -------------------------------------------------------------------------- */

test("the bar is absent from the session screen, which is the session", () => {
    // A second copy of the same information at the bottom of the full-screen timer
    // is noise, and it is the one screen where the information is already the page.
    assert.match(strip, /onSessionPage = path === "\/session"/);
    assert.match(strip, /if \(onSessionPage \|\| !liveActive\) return hide\(\);/);
});

test("the bar publishes its measured height so a toast cannot land on it", () => {
    // Three things are fixed to the bottom of the viewport and stack: the add
    // button, the active-session bar, and a toast. Measuring the bar beats a
    // constant because its height depends on its own content and on the viewport,
    // and the toast clears BOTH the button and the bar in one expression rather
    // than each guessing the other's size.
    assert.match(read("app/css/tokens.css"), /--bar-h: 0px;/, "the token must exist, defaulting to no bar");
    assert.match(strip, /setProperty\("--bar-h"/);
    assert.match(strip, /ResizeObserver/, "and must follow the bar as it changes");
    assert.match(strip, /removeProperty\("--bar-h"\)/, "and be cleared when the bar goes away");
    assert.match(css, /\.toast \{[\s\S]*?bottom: calc\(var\(--fab-h\) \+ var\(--bar-h\)/);
});

test("the add button clears the session bar, and the page clears the add button", () => {
    // The same arithmetic as the toast's, for the same reason, and the failure it
    // prevents is the one this restructure could have introduced: with the bottom
    // destination bar gone there is nothing between the two, so a button at a fixed
    // offset and a bar at another would overlap the moment a session started.
    const layout = read("app/css/layout.css");
    const tokens = read("app/css/tokens.css");
    assert.match(tokens, /--fab-h: 52px;/, "the button's height is a token, not a number written twice");
    assert.match(layout, /\.fab-root \{[\s\S]*?bottom: calc\(var\(--sab\)[^}]*var\(--bar-h\)/,
        "the button rides above the session bar");
    assert.match(layout, /main \{[\s\S]*?padding: [^;]*var\(--fab-h\) \+ var\(--bar-h\)/,
        "and the page reserves room for both");
});

test("the bar is a bar on a narrow screen and a card on a wide one", () => {
    // A control that has to be hunted for is a control that does not get used, and
    // this one carries the pause button.
    const narrow = css.slice(css.indexOf("@media (max-width: 1023px)"), css.indexOf("@media (max-width: 1023px)") + 1400);
    assert.match(narrow, /\.session-chip \{[\s\S]*?inset-inline: calc\(var\(--sa-start\) \+ 12px\)/, "docked across the width");
    assert.match(narrow, /grid-template-columns: minmax\(0, 1fr\) auto/, "reading area beside the control");
    // The base rule is the floating card on a wide screen.
    const base = css.slice(css.indexOf("/* ---- Session chip ---- */"), css.indexOf("/* ---- Onboarding ---- */"));
    assert.match(base, /top: 50%;\s*transform: translateY\(-50%\)/, "vertically centred on a wide screen");
    assert.match(base, /width: min\(\d+px/, "and narrow enough not to cover the page");
});

/* -------------------------------------------------------------------------- */
/* The session screen                                                           */
/* -------------------------------------------------------------------------- */

test("the controls sit directly after the stage, not at the end of the page", () => {
    // The order in the returned element is the order they are read. This was the
    // change that made the screen work: the time and the button that stops it were
    // a full screen apart, and on a phone the button was below the fold.
    //
    // The order is now expressed as two COLUMNS rather than as one stack, so the
    // stage is the first grid item and everything else lives in the second. Both
    // readings have to hold: the stage still comes first, and the controls are
    // still not the last thing on the page.
    //
    // The controls are inside the STAGE'S column, which is the sticky one, so that
    // the buttons that stop the clock stay on screen with the clock itself on a wide
    // screen where the two are side by side — and so that they come before the
    // checklist in the reading order rather than after it.
    const element = panel.slice(
        panel.indexOf("element: h(\"section\""),
        panel.indexOf("stop() {")
    );
    const stageCol = element.indexOf("class: \"session-stage\"");
    const workCol = element.indexOf("class: \"session-work\"");
    const stage = element.indexOf("stage.element");
    const controls = element.indexOf("buttons");
    const details = element.indexOf("card(");
    const note = element.indexOf("noteSection");
    assert.ok(stageCol >= 0 && stage > stageCol, "the stage is the first column");
    assert.ok(stage < controls, "and the controls follow it");
    assert.ok(controls < workCol, "both of them inside the stage's own column");
    assert.ok(controls < details, "and before the work, which is the second column");
    assert.ok(details < note, "then the work");
    // The note is last, which is what "the controls are no longer the last thing"
    // means in practice: they used to be, under a checklist and a note box.
    assert.match(element.trimEnd(), /noteSection\s*\)\s*\)\s*,?\s*$/, "the note closes the work column");
    assert.equal(element.match(/\n\s+buttons[,\)]/g).length, 1, "the controls appear exactly once");
});

test("the page is frameless, so the session screen is the app's measure", () => {
    // A card around a clock is a box a number has to be read through, and it was
    // also the only screen whose content stopped short of the frame every other
    // screen fills. The frame is gone at BOTH ends of the scale: below the wide
    // breakpoint it could not be there at all (the checklist scrolls under a sticky
    // stage, and a frame's padding would leave a sliver of every row showing down
    // each side of the timer), and from 1024px up there is nothing under the stage
    // to hide, so there is nothing left for a surface to do.
    const panel_ = css.slice(css.indexOf(".session-panel {"), css.indexOf("/* The stage's own column"));
    assert.match(panel_, /background: none;/, "no surface of its own, on any screen");
    assert.match(panel_, /border: 0;/);
    assert.match(panel_, /box-shadow: none;/);
    assert.doesNotMatch(panel_, /width: min\(\d+px/, "and no second measure: it is the page's own");
    const wide = css.slice(css.indexOf("@media (min-width: 1024px)"), css.indexOf("@media (min-width: 1024px)") + 1400);
    assert.doesNotMatch(wide, /\.session-panel \{[\s\S]*?border-radius:/,
        "and the wide band does not put the frame back");
});

test("the controls stay in the box that sticks with the stage", () => {
    // The reason they moved into the stage's column: on a wide screen the two are
    // side by side, and a row of buttons at the top of the far column reads as part
    // of the checklist rather than as part of the clock. Inside the sticky column
    // they also cannot scroll away from the number they stop.
    const stageCol = css.slice(css.indexOf(".session-stage {"), css.indexOf("/* The checklist and the note"));
    assert.match(stageCol, /position: sticky;/);
    assert.match(stageCol, /background: var\(--bg\);/, "and it hides what scrolls under it");
    assert.match(panel, /h\("div", \{ class: "session-stage" \},\s*\n\s*stage\.element,\s*\n\s*buttons\)/,
        "the stage column holds the stage and the controls, in that order");
});

test("the stage does not move when the checklist does", () => {
    // The complaint this answers is literal: ticking a subtask focuses its
    // checkbox, the browser scrolls it into view, and the timer — the one thing
    // this page exists to show — leaves the screen. Two things have to be true and
    // neither is visible from the other:
    //
    //   the stage is a grid item of its own, because sticky positions a box inside
    //   its containing block, and a stage nested straight into the panel would
    //   travel with the panel; and
    //   that column is sticky, with an offset that clears the header.
    assert.match(panel, /class: "session-stage"/, "the stage is wrapped in a column of its own");
    const column = css.slice(css.indexOf(".session-stage {"), css.indexOf("/* The controls, the checklist"));
    assert.match(column, /position: sticky;/, "and that column sticks");
    assert.match(column, /top: var\(--header-h\);/, "directly under the sticky header");
    assert.match(column, /background: var\(--bg\);/, "opaque, because the checklist scrolls under it");
    // And there is room for two columns from the wide breakpoint up, which is what
    // puts the work BESIDE the timer rather than under it.
    assert.match(css, /@media \(min-width: 1024px\)[\s\S]*?\.session-panel \{[\s\S]*?grid-template-columns: minmax\(0, 6fr\) minmax\(0, 5fr\)/,
        "the work sits beside the stage when there is width for both");
    // Nowhere near enough height for both at once: at 360px the stage is most of
    // the screen, so that band scrolls as one page rather than sticking two thirds
    // of it to the top.
    assert.match(css, /@media \(orientation: landscape\) and \(max-height: 560px\)[^}]*\.session-stage \{[\s\S]*?position: static;/,
        "and on a phone in landscape the page scrolls as one thing");
});

test("the controls are a grid, so a wrap can never reorder them", () => {
    // `flex-wrap` moved the destructive button to the first line on a narrow
    // screen, which is how a cancel ended up under a thumb. A grid has no such
    // behaviour, which is the only reason the block is not a `.toolbar`.
    assert.match(panel, /class: "session-controls"/);
    assert.match(css, /\.session-controls \{\s*\n\s*display: grid;/);
    assert.doesNotMatch(panel, /class: "toolbar session-controls"/, "and it is not a toolbar");
});

test("the stage is bounded by the height, so the controls stay above the fold", () => {
    // `--box` is the ring's share of the viewport, which is what decides the
    // counter's size. The two block sizes on `.stage` only bound the case where
    // the ring is small and the page is not.
    const stage = css.slice(css.indexOf(".stage {"), css.indexOf(".stage[data-flash]"));
    assert.match(stage, /--box: min\([^)]*vh[^)]*\)/, "the ring is sized against the viewport height");
    assert.match(stage, /max-block-size:/, "and the stage has a ceiling");
});
