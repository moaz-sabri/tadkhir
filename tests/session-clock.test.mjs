// The wall clock on the session stage: the time of day and the day it is on,
// shown beside the elapsed figure.
//
// A session screen showed the counter and nothing else, and the counter cannot
// answer a question people actually ask of it. "How long has this been running?"
// and "what time is it?" are different questions, and during the late evening —
// when the sessions in this app tend to happen — they have different answers.
// Twenty minutes into a session is the same twenty minutes at 09:40 and at
// 23:50, and only one of those is the time it is.
//
// There are two ways this feature could be shipped badly, and both of them look
// right in a screenshot:
//
//   a clock that stops when the session is paused, which freezes the one figure
//   on the screen that is supposed to be true regardless of the session's state
//   — and pausing is when somebody looks at a clock to decide whether to start
//   again; and
//   a clock on a per-second timer that rewrites the DOM sixty times a minute to
//   show a value that changes once, which is a battery cost with nothing to buy
//   with it.
//
// The tests below are about those two, and about where on the stage the line
// goes, because the third thing that could be shipped badly is putting it in the
// head — where it competes with the number the page exists for.

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

const display = code(read("app/js/ui/components/display.js"));
const panel = code(read("app/js/ui/components/session-panel.js"));
const css = read("app/css/components.css");

/* -------------------------------------------------------------------------- */
/* Where it is                                                                  */
/* -------------------------------------------------------------------------- */

test("the clock is a caption to the time, not a fourth line in the head", () => {
    // The head already answers two questions — what this is, and in what state —
    // and it is where the eye starts. The clock is the caption to the number:
    // this much time, counted to now, on this day. That is the order a person
    // reads a timecard in, and it is why this belongs under the counter and not
    // beside the title.
    const stage = display.slice(display.indexOf("const stage = h(\"div\""), display.indexOf("setLen(4)"));
    assert.match(stage, /h\("div",\s*\{ class: "stage-head" \},\s*titleEl,\s*statusEl\)/,
        "the head is still the title and the status, and nothing else");
    assert.match(stage, /progress \? ring : counter,\s*\n\s*nowEl\s*\n/, "the clock follows the counter");
    assert.doesNotMatch(stage, /class: "stage-head"[^)]*nowEl/, "and is not in the head");
});

test("the stage carries the clock whether or not there is a ring", () => {
    // A ring is drawn only for a task-backed session, and the free-session branch
    // puts the bare counter there instead. A clock that lived inside the ring
    // would be shown for a third of sessions and silently missing for the rest.
    assert.match(display, /progress \? ring : counter,\s*\n\s*nowEl/);
    const hole = display.slice(
        display.indexOf("class: \"stage-ring-hole\""),
        display.indexOf("const nowTimeEl")
    );
    assert.doesNotMatch(hole, /now/, "the clock must not be inside the ring's hole");
});

test("every class the clock line uses has a rule of its own", () => {
    // The same rule as every other class in the design system: a class with no
    // rule is not a style, it is a hope. And the two halves are styled apart,
    // because the whole design of the line is that the time is read and the date
    // is not.
    for (const cls of [".stage-now", ".stage-now-time", ".stage-now-date", ".stage-now-sep"]) {
        assert.ok(css.includes(`${cls} {`), `no rule for ${cls}`);
    }
    const block = css.slice(css.indexOf(".stage-now {"), css.indexOf(".stage-counter {"));
    assert.match(block, /\.stage-now-time \{[\s\S]*?font-variant-numeric: tabular-nums/,
        "a live clock needs tabular digits or it shifts sideways as they turn over");
    assert.match(block, /\.stage-now \{[\s\S]*?color: var\(--fg-mute\)/,
        "and the date is the quieter of the two");
});

/* -------------------------------------------------------------------------- */
/* What it says, and what it does not say                                       */
/* -------------------------------------------------------------------------- */

test("the stage formats the clock itself, and both halves of it", () => {
    // The panel has no way to render "now" and no reason to know the stage is
    // going to; the counter is formatted the same way, in the same place.
    assert.match(display, /import \{[^}]*formatTime[^}]*\} from "\.\.\/\.\.\/domain\/time\.js"/);
    assert.match(display, /import \{[^}]*formatDateLong[^}]*\} from "\.\.\/\.\.\/domain\/time\.js"/);
    assert.match(display, /setNow\(ts\) \{[\s\S]*?formatTime\(ts\)[\s\S]*?formatDateLong\(ts\)/);
});

test("a per-second tick does not rewrite a clock that has not moved", () => {
    // The wall clock changes once a minute. The panel ticks once a second, so
    // without this guard the same two strings are written sixty times a minute
    // for nothing — and a screen that is never off is a screen that is never off
    // when it is put down.
    assert.match(display, /let lastNow = "";[\s\S]*?if \(key === lastNow\) return;/,
        "a repeated minute must not reach the DOM");
    assert.match(display, /lastNow = key;[\s\S]*?nowTimeEl\.textContent[\s\S]*?nowDateEl\.textContent/,
        "and the write is what the guard is in front of");
});

test("the clock is not announced, and its punctuation is not read out", () => {
    // Two different mistakes, both invisible in a screenshot. A wall clock is
    // not a `role="timer"` — that is the elapsed figure, and a screen reader
    // watching two of them change is a screen reader that cannot be interrupted.
    // And the divider between the two values is punctuation, not a word: a
    // reader should hear the time and then the date, not a middot.
    const nowBlock = display.slice(display.indexOf("const nowTimeEl"), display.indexOf("const stage = h(\"div\""));
    assert.doesNotMatch(nowBlock, /role:\s*"timer"/, "a wall clock is not a timer");
    assert.match(nowBlock, /class: "stage-now-sep",\s*"aria-hidden": "true"/,
        "the separator is hidden from anything reading the two values aloud");
    assert.doesNotMatch(nowBlock, /aria-live/, "and neither of them is a live region");
});

/* -------------------------------------------------------------------------- */
/* The one thing it must not do: stop                                          */
/* -------------------------------------------------------------------------- */

test("the clock runs while the session is paused", () => {
    // The failure this guards is the obvious one, and it is the one a passing
    // test suite would not catch: wiring the clock into the existing tick, which
    // deliberately stops the moment the session does. A paused session's ELAPSED
    // figure is frozen and has nothing to redraw — that is why the tick stops.
    // A clock has no such excuse, and pausing is exactly when somebody looks at
    // a clock to decide whether to start again.
    const clock = panel.slice(panel.indexOf("const clockTimer"), panel.indexOf("const progress = h(\"div\""));
    assert.match(clock, /setInterval\(/, "the clock has a timer of its own");
    assert.doesNotMatch(clock, /cur\.status/, "and it is not gated on the session's state");
    // It follows the same visibility rule as the chip's timer, so a page in a
    // background tab is not re-rendered sixty times a minute for nobody.
    assert.match(clock, /if \(document\.hidden\) return;/);
});

test("the panel writes the clock once up front, not one second later", () => {
    // Built, and on the way back to the tab: the figure is right the moment the
    // screen appears rather than after the first tick, which on a paused session
    // whose tick has stopped would be never.
    assert.match(panel, /function updateLive\([\s\S]*?stage\.setNow\(Date\.now\(\)\)/);
});

test("the clock is stopped with the panel", () => {
    // A panel is built on every visit to /session and torn down on every
    // departure. A one-second timer that outlives the element it draws into is
    // a timer that keeps a page alive after the person left it, and it
    // accumulates one per visit.
    const stop = panel.slice(panel.indexOf("stop() {"));
    assert.match(stop, /clearInterval\(clockTimer\)/);
    // And the tick's own teardown is untouched: the clock was added beside it,
    // not in place of it.
    assert.match(stop, /clearTimeout\(timer\)/);
});
