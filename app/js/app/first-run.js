import { withTx } from "../data/db.js";
import { metaRepo } from "../data/meta.repo.js";

// Whether the first-run flow still has to happen on this device.
//
// The flag lives in `meta` under its OWN key, not inside `settings`, and that is
// the whole design decision. `settings` is synced wholesale between devices, so a
// flag stored there would mean: finish onboarding on the phone, and the tablet
// that has never seen the app silently skips it too. Whether you have been
// introduced to the app is a fact about the device, not about the account.
//
// A separate meta key also needs no migration. `meta` is a keyPath store, so a
// record that was never written simply reads as `undefined` — which is the
// correct answer for a fresh install and for every install made before this
// feature existed, both of which have never seen the flow.
const SEEN_KEY = "onboardingSeen";

export async function hasSeenOnboarding() {
    const value = await withTx(["meta"], "readonly", async r => {
        return (await metaRepo(r.meta).get(SEEN_KEY))?.value ?? null;
    });
    return value === true;
}

export async function markOnboardingSeen() {
    await withTx(["meta"], "readwrite", async r => metaRepo(r.meta).set(SEEN_KEY, true));
}

// Whether to show the flow at all.
//
// Deliberately a conjunction of three things, and each of the three closes a
// hole the other two leave open:
//
//   the flag    — so it is shown once, and a skip is respected forever
//   no key      — a device that already has a private key was set up, whether
//                 by a previous version of this app, by importing a backup on
//                 another device, or by hand in Settings
//   no tasks    — a device with records in it is in use, and a first-run flow
//                 over somebody's existing data reads as an interruption
//
// Getting this wrong in the permissive direction is the expensive mistake: a
// user with a year of sessions is shown a welcome screen on every launch, and
// has no way to argue with it. Restrictive only costs a new user one extra trip
// through Settings, which is where every one of these choices lives anyway.
export async function shouldRunOnboarding({ hasKeys, taskCount }) {
    if (await hasSeenOnboarding()) return false;
    if (hasKeys) return false;
    if (taskCount > 0) return false;
    return true;
}
