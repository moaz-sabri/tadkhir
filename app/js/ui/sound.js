import { store } from "../app/store.js";

// Short OS-style alert tone via Web Audio. No audio assets needed.
//
// Two rules, and the second one is the reason this file exists at all:
//
//   1. Best effort, always. A device with no Web Audio, a context the browser
//      refuses to start because no gesture has happened yet, an autoplay policy
//      — none of them may touch the timer. That was already true here and stays
//      true.
//
//   2. Only when the user wants it. A tone nobody asked for is an interruption,
//      and a timer that beeps at you from a pocket at 09:00 is a timer you turn
//      off. The preference is read from the store on every call rather than
//      cached, so turning it off in Settings takes effect on the very next
//      alert rather than after a reload.
//
// There is no sound for starting, pausing or finishing: those get a vibration,
// and a vibration is the channel that belongs to a tap the user just made. The
// tone is for the one thing that happens while they are not looking.
let ctx = null;

export function soundEnabled() {
    return store.getState().settings?.sound !== false;
}

export function beep() {
    try {
        if (!soundEnabled()) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = ctx || new AC();
        if (ctx.state === "suspended") ctx.resume();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.55);
    } catch (e) {
        // Sound is best-effort; never let it break the timer.
    }
}
