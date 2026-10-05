import { withTx } from "../data/db.js";
import { tasksRepo } from "../data/tasks.repo.js";
import { sessionsRepo } from "../data/sessions.repo.js";
import { eventsRepo } from "../data/events.repo.js";
import { metaRepo } from "../data/meta.repo.js";
import { outboxRepo } from "../data/outbox.repo.js";
import { transactionsRepo } from "../data/transactions.repo.js";
import { recurringRepo } from "../data/recurring.repo.js";
import { debtsRepo } from "../data/debts.repo.js";
import { debtPaymentsRepo } from "../data/debt-payments.repo.js";
import { categoriesRepo } from "../data/categories.repo.js";
import { peopleRepo } from "../data/people.repo.js";
import { laterRepo } from "../data/later.repo.js";
import { SYNCED_STORES, recordFor } from "../data/stores.js";
import {
    SYNC_META_KEY,
    SYNC_CONFIG_KEY,
    SYNC_PUSH_BATCH,
    SYNC_PULL_LOOP_MAX,
    SYNC_INTERVAL_MS,
    SYNC_REQUEST_TIMEOUT_MS,
    EVENT_SYNC_DEBOUNCE_MS
} from "../config.js";
import { bus } from "../app/bus.js";
import { broadcastChange, onRemoteChange } from "../app/sync.js";
import { requestSignal } from "../app/net.js";
import { buildSyncFile, serializeSyncFile, parseSyncFile, syncFileName } from "./sync-file.js";
import * as cryptoService from "./crypto-service.js";
import { authService } from "./auth-service.js";

const API_BASE = "/api";

// The repos, one per synced store, looked up by STORE name. The record types
// themselves — the vocabulary shared with the server, the migrations, the
// backup and every service — live in data/stores.js, and so does the type to
// store map this used to keep beside them.
//
// Four core records (task, session, event, meta) are handled by name below
// because each has behaviour of its own: sessions keep their running slot out
// of sync and pull their journal with them, events cascade, and meta is a
// single settings document rather than a keyed record. Everything after them is
// one shape: an LWW document in a store, keyed by id, with tombstones.

let syncing = false;
let syncLoopTimer = null;
let backoffTimer = null;
let backoffDelay = 5000;
const MAX_BACKOFF = 300000;
let eventSyncTimer = null;
let setupDone = false;

function makeError(code) {
    const e = new Error(code);
    e.code = code;
    return e;
}

function clearBackoff() {
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    backoffDelay = 5000;
}

function scheduleBackoffSync() {
    clearBackoff();
    backoffTimer = setTimeout(() => {
        backoffDelay = Math.min(backoffDelay * 2, MAX_BACKOFF);
        if (typeof navigator !== "undefined" && navigator.onLine !== false) {
            syncNowInternal();
        }
    }, backoffDelay);
}

async function readMeta(key, fallback) {
    return withTx(["meta"], "readonly", r => metaRepo(r.meta).get(key))
        .then(v => v?.value ?? fallback);
}

async function writeMeta(key, value) {
    return withTx(["meta"], "readwrite", r => metaRepo(r.meta).set(key, value));
}

async function readSyncMeta() {
    const base = { clientId: null, cursor: 0, status: "not_configured", lastSyncAt: null, lastError: null, authRequired: false };
    const stored = await readMeta(SYNC_META_KEY, null);
    return { ...base, ...(stored || {}) };
}

function getDeviceId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomId(len = 8) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const arr = typeof crypto !== "undefined" && crypto.getRandomValues
        ? crypto.getRandomValues(new Uint8Array(len))
        : Array.from({ length: len }, () => Math.floor(Math.random() * 256));
    let out = "";
    for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
    return out;
}

function generateSpaceCode() {
    return `space-${randomId(8)}`;
}

async function ensureDeviceId() {
    const cfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
    if (typeof cfg.deviceId !== "string" || !cfg.deviceId) {
        cfg.deviceId = getDeviceId();
        await writeMeta(SYNC_CONFIG_KEY, cfg);
    }
    return cfg.deviceId;
}

function emitChanged() {
    bus.emit("data-changed");
    broadcastChange();
}

function startSyncLoop() {
    if (syncLoopTimer) return;
    syncLoopTimer = setInterval(() => {
        if (typeof navigator !== "undefined" && navigator.onLine !== false && !syncing) {
            syncNowInternal();
        }
    }, SYNC_INTERVAL_MS);
}

function stopSyncLoop() {
    if (syncLoopTimer) { clearInterval(syncLoopTimer); syncLoopTimer = null; }
}

function scheduleEventSync() {
    if (eventSyncTimer) clearTimeout(eventSyncTimer);
    eventSyncTimer = setTimeout(() => {
        if (typeof navigator !== "undefined" && navigator.onLine !== false && !syncing) {
            syncNowInternal();
        }
    }, EVENT_SYNC_DEBOUNCE_MS);
}

// `detail` is an optional { sent, pulled } counter pair, filled in as the run
// goes. It exists for the one caller that has to say something afterwards — the
// refresh button in Settings — because "sync" with no numbers is a word the
// user cannot check anything against, and a person who pressed the button to be
// TOLD the answer is not served by the word "done". The loop that calls this on
// its own passes nothing and pays nothing.
async function syncNowInternal(detail = null) {
    if (syncing) return { ok: false, code: "busy" };
    syncing = true;
    try {
        const cfg = await ensureConfigLocal();
        if (!cfg || !cfg.code) {
            await setStatus({ status: "not_configured", lastError: null });
            stopSyncLoop();
            return { ok: false, code: "not_configured" };
        }
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            await setStatus({ status: "offline" });
            stopSyncLoop();
            return { ok: false, code: "offline" };
        }

        await setStatus({ status: "syncing", lastError: null, authRequired: false });

        let retained = 0;
        try {
            retained = await pushPending(detail);
            await pullAndApply(detail);
        } catch (e) {
            const code = e?.code || "sync_failed";
            if (code === "unauthorized" || code === "invalid_credentials") {
                const reauthed = await trySessionReauth();
                if (reauthed) {
                    // The first attempt got part of the way before the server
                    // refused it, so its counts are of a run that did not happen.
                    // Start the numbers over rather than reporting the failed
                    // attempt's work as this one's.
                    if (detail) { detail.sent = 0; detail.pulled = 0; }
                    retained = await pushPending(detail);
                    await pullAndApply(detail);
                } else {
                    await setStatus({ status: "unauthorized", lastError: code, authRequired: true });
                    stopSyncLoop();
                    return { ok: false, code };
                }
            } else {
                throw e;
            }
        }
        // A partial delivery is not a successful sync. The retained changes are
        // still queued (that part is deliberate) but the run is reported as the
        // error it is, so the Settings page stops claiming everything is fine.
        if (retained > 0) {
            await setStatus({ status: "error", lastError: "push_invalid", authRequired: false });
            startSyncLoop();
            return { ok: false, code: "push_invalid", invalid: retained };
        }
        await setStatus({ status: "idle", lastSyncAt: Date.now(), authRequired: false });
        clearBackoff();
        startSyncLoop();
        return { ok: true };
    } catch (e) {
        const code = e?.code || "sync_failed";
        const status = code === "unauthorized" || code === "invalid_credentials"
            ? "unauthorized"
            : (code === "network" || code === "offline") ? "offline"
            : "error";
        await setStatus({ status, lastError: code, authRequired: status === "unauthorized" });
        if (status !== "unauthorized") {
            scheduleBackoffSync();
        } else {
            stopSyncLoop();
        }
        return { ok: false, code };
    } finally {
        syncing = false;
    }
}

async function trySessionReauth() {
    const cfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
    if (!cfg?.code) return false;
    const masterKey = authService.getMasterKey();
    if (!masterKey) return false;
    try {
        const res = await fetchJson("auth/rotate", { code: cfg.code, deviceId: cfg.deviceId });
        if (res?.ok) return true;
    } catch { /* ignore */ }
    return false;
}

async function fetchJson(path, body, method = "POST") {
    let res;
    try {
        res = await fetch(`${API_BASE}/${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: body === undefined ? undefined : JSON.stringify(body),
            // Without this a hung request suspends the whole sync run forever —
            // see the note on SYNC_REQUEST_TIMEOUT_MS. An abort arrives here as
            // a rejection, so it becomes the same `network` code as a real
            // failure and the existing backoff takes over.
            signal: requestSignal(SYNC_REQUEST_TIMEOUT_MS)
        });
    } catch {
        throw makeError("network");
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const code = data && typeof data === "object" && data.error
        ? (data.error.code || null)
        : null;
    if (res.status === 401 || res.status === 403) throw makeError(code || "unauthorized");
    if (res.status === 429) throw makeError(code || "rate_limited");
    if (res.status === 413) throw makeError("payload_too_large");
    if (res.status === 409) throw makeError(code || "conflict");
    if (!res.ok) throw makeError(code || "server_error");
    if (!data || typeof data !== "object" || data.ok !== true) throw makeError("malformed");
    return data;
}

async function encryptRecord(data) {
    const mk = authService.getMasterKey();
    if (!mk) throw makeError("no_master_key");
    return await cryptoService.encryptData(mk, data);
}

async function decryptRecord(b64) {
    const mk = authService.getMasterKey();
    if (!mk) return null;
    return await cryptoService.decryptData(mk, b64);
}

async function pushPending(detail = null) {
    const mk = authService.getMasterKey();
    if (!mk) throw makeError("no_master_key");
    const entries = await withTx(["outbox"], "readonly", r => outboxRepo(r.outbox).getAll());
    // Changes the server refused to store at all (a malformed one, or a
    // timestamp outside the accepted clock window) stay in the outbox by
    // design, so they keep retrying. Counted here so a sync that could not
    // deliver everything reports it: they used to be indistinguishable from a
    // clean run, so a device with a badly wrong clock showed "synced just
    // now" forever and nothing ever surfaced the cause.
    let retained = 0;
    for (let i = 0; i < entries.length; i += SYNC_PUSH_BATCH) {
        const batch = entries.slice(i, i + SYNC_PUSH_BATCH);
        let pushed = [];
        for (const e of batch) {
            // Encrypted payloads are carried in an object envelope ({ c }):
            // the server is a dumb store that only accepts object payloads
            // (string ciphertext was silently rejected as invalid before).
            let recordData = undefined;
            if (e.op === "upsert") {
                const payload = e.type === "session" ? stripActiveSlot(e.data) : e.data;
                if (payload && typeof payload === "object") {
                    recordData = { c: await encryptRecord(payload) };
                }
            }
            pushed.push({
                type: e.type,
                id: e.id,
                op: e.op,
                data: recordData,
                updatedAt: e.updatedAt
            });
        }
        const res = await fetchJson("sync/push", { changes: pushed });
        // The server counts malformed/clock-skewed changes as invalid but still
        // answers 200. Those entries must stay in the outbox and retry (the
        // server's own contract), so only drop the batch when every change was
        // accepted or legitimately rejected as older (LWW).
        if (res.invalid > 0) { retained += res.invalid; continue; }
        // Counted where the entries LEAVE the outbox, not where they were sent:
        // a change the server kept is the only kind that is actually on the other
        // devices now, and this is the line that says how many that is.
        if (detail) detail.sent += batch.length;
        await withTx(["outbox"], "readwrite", r => {
            const o = outboxRepo(r.outbox);
            for (const e of batch) o.delete(e.key);
        });
    }
    return retained;
}

function stripActiveSlot(data) {
    if (!data || typeof data !== "object") return data;
    const { activeSlot, ...rest } = data;
    return rest;
}

async function pullAndApply(detail = null) {
    let state = await readSyncMeta();
    let cursor = Number.isInteger(state.cursor) && state.cursor >= 0 ? state.cursor : 0;

    for (let guard = 0; guard < SYNC_PULL_LOOP_MAX; guard++) {
        const res = await fetchJson("sync/pull", { cursor });
        const changes = Array.isArray(res.changes) ? res.changes : [];
        if (changes.length > 0) await applyChanges(changes);
        // Every change the server had, counted as it arrived — including the ones
        // applyChanges then dropped as older than what this device already had,
        // which were still fetched and are still part of what the run did.
        if (detail) detail.pulled += changes.length;
        const next = res.nextCursor;
        cursor = Number.isInteger(next) && next >= 0 ? next : cursor;
        await writeMeta(SYNC_META_KEY, { ...(await readSyncMeta()), cursor });
        if (res.more !== true || changes.length === 0) break;
    }
}

async function applyChanges(changes) {
    const mk = authService.getMasterKey();
    if (!mk) throw makeError("no_master_key");

    const pending = await withTx(["outbox"], "readonly", r => outboxRepo(r.outbox).getAll());
    const pendingByKey = new Map(pending.map(e => [e.key, e]));

    // Incoming records are carried as an encrypted object envelope
    // ({ c: "<ciphertext base64>" }). Decrypt them up-front, outside the
    // IndexedDB transaction, so a slow WebCrypto call can never deactivate it.
    const decryptedByKey = new Map();
    for (const ch of changes) {
        if (!ch || typeof ch !== "object") continue;
        const key = `${ch.type}:${ch.id}`;
        let cipher = null;
        if (typeof ch.data === "string") {
            cipher = ch.data; // legacy raw-ciphertext form
        } else if (ch.data && typeof ch.data === "object" && typeof ch.data.c === "string") {
            cipher = ch.data.c;
        }
        if (cipher) {
            const plain = await decryptRecord(cipher);
            if (plain && typeof plain === "object") decryptedByKey.set(key, plain);
        }
    }

    await withTx(
        ["tasks", "sessions", "events", "meta", "transactions", "recurring", "debts", "debtPayments", "categories", "people", "later", "pages", "pageItems", "routines", "routineLogs"],
        "readwrite",
        async r => {
            const tr = tasksRepo(r.tasks);
            const sr = sessionsRepo(r.sessions);
            const er = eventsRepo(r.events);
            const mr = metaRepo(r.meta);
            const dpr = debtPaymentsRepo(r.debtPayments);
            // The page cascade, read from the registry rather than bound by hand:
            // a page's items live in a different store from the page, and naming
            // that pairing here is exactly what the registry exists to prevent.
            const pir = recordFor("pageItem").repo(r.pageItems);
            // And the same for a routine's days, which are stored apart from the
            // rule for the same reason a page's items are.
            const rlr = recordFor("routineLog").repo(r.routineLogs);

            for (const ch of changes) {
                if (!ch || typeof ch !== "object") continue;
                const type = ch.type;
                const id = ch.id;
                if (typeof type !== "string" || typeof id !== "string") continue;
                const key = `${type}:${id}`;
                const pend = pendingByKey.get(key);
                const at = Number.isFinite(ch.updatedAt) ? ch.updatedAt : 0;
                const incoming = decryptedByKey.get(key);

                if (type === "task") {
                    const local = await tr.get(id);
                    if (pend && pend.updatedAt >= at) continue;
                    if (local && !pend && at < (local.updatedAt || 0)) continue;
                    if (ch.op === "delete") await tr.delete(id);
                    else if (incoming) await tr.put(incoming);
                    continue;
                }

                if (type === "session") {
                    // Running sessions never leave the device that started them
                    // (session-service only syncs completed/cancelled records). A
                    // running record here is an echo or stale data — never apply it,
                    // or it would wipe the locally-running session's active slot.
                    if (incoming && incoming.status === "running") continue;
                    const local = await sr.get(id);
                    if (pend && pend.updatedAt >= at) continue;
                    if (local && !pend && at < (local.updatedAt || 0)) continue;
                    if (ch.op === "delete") {
                        await er.deleteBySession(id);
                        await sr.delete(id);
                        continue;
                    }
                    if (incoming) {
                        const s = { ...incoming };
                        delete s.activeSlot;
                        await sr.put(s);
                    }
                    continue;
                }

                if (type === "event") {
                    if (pend && pend.op === "delete") continue;
                    if (ch.op === "delete") await er.delete(id);
                    else if (incoming) await er.put(incoming);
                    continue;
                }

                // Finance and Later records are plain last-write-wins documents
                // carrying their own updatedAt, so they share the task rule: a
                // pending local edit always wins, and an older remote copy never
                // overwrites a newer local one. The key is unique per record, so
                // re-applying the same change is idempotent — that is what keeps
                // a retried push or pull from duplicating a payment.
                if (SYNCED_STORES[type]) {
                    // The record type names the store; the registry knows which
                    // repo reads it. Nothing here can pair a type with the wrong
                    // store, which is what a hand-written table of the two
                    // allowed.
                    const record = recordFor(type);
                    const repo = record.repo(r[record.store]);
                    const local = await repo.get(id);
                    if (pend && pend.updatedAt >= at) continue;
                    if (local && !pend && at < (local.updatedAt || 0)) continue;
                    if (ch.op === "delete") {
                        // A debt carries its payments with it: a deleted debt
                        // must never leave orphaned payments behind, or the
                        // remaining amount would silently change on this device.
                        if (type === "debt") await dpr.deleteByDebt(id);
                        // A page carries its items, for the same reason and with
                        // the same consequence: an item whose page is gone is
                        // unreachable, and its position would go on taking part
                        // in every reorder of a page that no longer exists.
                        if (type === "page") await pir.deleteByPage(id);
                        // A routine carries its days with it, for the same reason
                        // and with the same consequence: a tally whose rule is gone
                        // is a number no screen can place, and it would keep syncing
                        // forever as a record nothing can render.
                        if (type === "routine") await rlr.deleteByRoutine(id);
                        await repo.delete(id);
                        continue;
                    }
                    if (incoming) await repo.put(incoming);
                    continue;
                }

                if (type === "meta" && id === "settings") {
                    const val = incoming && typeof incoming === "object" ? (incoming.value ?? incoming) : {};
                    await mr.set("settings", ch.op === "delete" ? {} : val);
                }
            }
        }
    );

    emitChanged();
}

async function setStatus(partial) {
    const s = await readSyncMeta();
    await writeMeta(SYNC_META_KEY, { ...s, ...partial });
}

async function ensureConfigLocal() {
    const cfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
    if (!cfg.deviceId) {
        cfg.deviceId = getDeviceId();
        await writeMeta(SYNC_CONFIG_KEY, cfg);
    }
    return cfg;
}

export const syncService = {
    async getConfig() {
        const cfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
        return cfg;
    },

    async saveConfig({ deviceName, code } = {}) {
        const cfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
        const deviceId = cfg.deviceId || await ensureDeviceId();
        await writeMeta(SYNC_CONFIG_KEY, {
            deviceId,
            deviceName: String(deviceName || "").trim() || null,
            code: code !== undefined && code !== null ? String(code).trim() : (cfg.code || null)
        });
        await setStatus({ status: "idle", authRequired: false });
        return { ok: true };
    },

    async clearConfig() {
        await writeMeta(SYNC_CONFIG_KEY, null);
        await authService.logout();
        await setStatus({ status: "not_configured", authRequired: false, lastError: null, lastSyncAt: null });
    },

    async ensureConfig() { return ensureConfigLocal(); },
    async status() { return readSyncMeta(); },
    async pendingCount() { return withTx(["outbox"], "readonly", r => outboxRepo(r.outbox).getAll()).then(a => a.length); },

    async createSpace({ code, password }) {
        const cfg = await this.ensureConfig();
        if (!cfg) return { ok: false, code: "not_configured" };
        try {
            const cryptoResult = await authService.createSpace({ code, password });
            if (!cryptoResult.ok) return cryptoResult;
            const res = await fetchJson("auth/create", {
                code,
                password,
                device: { id: cfg.deviceId, label: cfg.deviceName || undefined }
            });
            await this.saveConfig({ code });
            await setStatus({ status: "idle", authRequired: false, lastSyncAt: Date.now() });
            authService.scheduleSessionRotation(() => this.rotateSession());
            startSyncLoop();
            return { ok: true, deviceCount: res?.deviceCount ?? null, expiresAt: res?.expiresAt ?? null };
        } catch (e) {
            await cryptoService.clearEncryptionKeys();
            const code = e?.code || "sync_failed";
            await setStatus({ status: "error", lastError: code });
            return { ok: false, code };
        }
    },

    async openSpace({ code, password }) {
        const cfg = await this.ensureConfig();
        if (!cfg) return { ok: false, code: "not_configured" };
        try {
            const encryptedKey = await cryptoService.getEncryptedKey();
            const res = await authService.openSpace({ code, password, getEncryptedKey: () => encryptedKey });
            if (!res.ok) return res;
            const serverRes = await this.connectSpaceToServer(code, password, cfg);
            if (!serverRes.ok) {
                await setStatus({ status: "unauthorized", lastError: serverRes.code, authRequired: true });
                return { ok: false, code: serverRes.code };
            }
            await this.saveConfig({ code });
            await setStatus({ status: "idle", authRequired: false, lastSyncAt: Date.now() });
            authService.scheduleSessionRotation(() => this.rotateSession());
            startSyncLoop();
            return { ok: true, deviceCount: serverRes?.res?.deviceCount ?? null, expiresAt: serverRes?.res?.expiresAt ?? null };
        } catch (e) {
            const code = e?.code || "sync_failed";
            await setStatus({ status: "error", lastError: code });
            return { ok: false, code };
        }
    },

    // Establish a server session for a space. Tries auth/open (existing space);
    // if the space isn't on this server yet, bootstraps it via auth/create so an
    // imported/exported secret key can connect from a fresh device.
    async connectSpaceToServer(code, password, cfg) {
        const device = { id: cfg.deviceId, label: cfg.deviceName || undefined };
        try {
            const res = await fetchJson("auth/open", { code, password, device });
            return { ok: true, res };
        } catch (openErr) {
            const openCode = openErr?.code || "server_error";
            if (openCode !== "invalid_credentials" && openCode !== "unauthorized") {
                return { ok: false, code: openCode };
            }
            try {
                const created = await fetchJson("auth/create", { code, password, device });
                return { ok: true, res: created };
            } catch (createErr) {
                const createCode = createErr?.code || "server_error";
                if (createCode === "space_exists") return { ok: false, code: openCode };
                return { ok: false, code: createCode };
            }
        }
    },

    async rotateSession() {
        const cfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
        if (!cfg?.code) return { ok: false, code: "not_configured" };
        const res = await authService.rotateSession(cfg.code, cfg.deviceId);
        if (!res.ok) {
            // Marked, not papered over: this used to fall through and paint the
            // status "idle" over a session the server had already rejected, so
            // an expired session looked like a healthy one until the next push.
            if (res.code === "unauthorized" || res.code === "rate_limited") {
                await setStatus({ status: "unauthorized", lastError: res.code, authRequired: true });
            }
            return res;
        }
        await setStatus({ status: "idle", lastSyncAt: Date.now() });
        return res;
    },

    // A full run, asked for rather than scheduled: everything queued on this
    // device goes up, then everything the server holds comes down, and the two
    // counts come back with the result. It is the same code path the loop and the
    // debounce use — there is no second implementation of "sync" for a button to
    // drift away from.
    async syncNow() {
        const detail = { sent: 0, pulled: 0 };
        const res = await syncNowInternal(detail);
        return { ...res, sent: detail.sent, pulled: detail.pulled };
    },

    async setup() {
        if (typeof window === "undefined") return;
        // Idempotent, and it has to be: setup() adds four listeners and a timer,
        // and calling it twice would leave a second interval running behind the
        // first one's back — two runs racing on the same `syncing` flag, and half
        // the triggers doing nothing because the other one got there first.
        if (setupDone) return;
        setupDone = true;

        const cfg = await this.ensureConfig();
        if (!cfg) return;

        const triggerSync = () => {
            if (navigator.onLine !== false && !syncing) this.syncNow();
        };

        window.addEventListener("online", triggerSync);
        window.addEventListener("visibilitychange", () => { if (!document.hidden) triggerSync(); });
        window.addEventListener("focus", triggerSync);
        window.setTimeout(() => { if (navigator.onLine !== false) triggerSync(); }, 2500);

        // Losing the network is the one event that should stop the loop at once
        // rather than at the end of the current interval. Without it, a device
        // that goes into a tunnel keeps attempting a push every 30 seconds for as
        // long as it is out, each one failing, each one lengthening the backoff
        // for when it comes back — and the status shown to the user stays
        // "idle" until a run actually happens to start and notice.
        window.addEventListener("offline", () => {
            stopSyncLoop();
            clearBackoff();
            setStatus({ status: "offline" }).catch(() => {});
        });

        // A write in another tab is a write this tab's outbox knows nothing
        // about. It was already refreshing the store through the bus; this is
        // what makes it PUSH instead of waiting for the next poll. Debounced
        // through the same timer as a local write, so a burst of tabs produces one
        // request rather than one per tab.
        onRemoteChange(() => {
            if (typeof navigator === "undefined" || navigator.onLine !== false) scheduleEventSync();
        });

        if (cfg.code) {
            authService.scheduleSessionRotation(() => this.rotateSession());
        }
        startSyncLoop();
    },

    async enqueue(type, id, op, data = null, at = null) {
        return this.enqueueMany([{ type, id, op, data, at }]);
    },

    /**
     * Queue a batch of changes in ONE outbox transaction.
     *
     * enqueue() opens a transaction per record, which is right for the common
     * case of a single write and ruinous for the batch cases: restoring a
     * backup looped over ten lists and opened a transaction per record, so a
     * full account cost thousands of them, and deleting a debt with 400
     * payments opened 401. Every write path that touches more than one record
     * now comes through here.
     *
     * Entries: { type, id, op, data, at }. `at` defaults to now, exactly as the
     * single-record form does.
     */
    async enqueueMany(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return;
        const stamped = entries.map(e => ({
            key: `${e.type}:${e.id}`,
            type: e.type,
            id: e.id,
            op: e.op,
            data: e.data ?? null,
            updatedAt: e.at ?? Date.now(),
            enqueuedAt: Date.now()
        }));
        await withTx(["outbox"], "readwrite", async r => {
            const o = outboxRepo(r.outbox);
            for (const record of stamped) await o.put(record);
        });
        scheduleEventSync();
    },

    async clearOutbox() {
        await withTx(["outbox"], "readwrite", r => outboxRepo(r.outbox).clear());
    },

    async logout() {
        try { await fetchJson("auth/logout", {}); } catch { /* ignore */ }
        stopSyncLoop();
        clearBackoff();
        if (eventSyncTimer) { clearTimeout(eventSyncTimer); eventSyncTimer = null; }
        await authService.logout();
        const cfg = await this.getConfig();
        await setStatus({ status: cfg?.code ? "unauthorized" : "not_configured", authRequired: Boolean(cfg?.code), lastError: null });
    },

    // Sets up a brand new key on this device: a space code, an encrypted master
    // key under the given password, an owner number, and the server session that
    // makes the space reachable from another device later.
    //
    // This used to be the body of the `isNew` branch inside exportSyncFile(), and
    // it is here now because first-run setup needs the key WITHOUT a file: the
    // onboarding asks for a password and an owner number, and a user who has
    // never synced anything has no use for a download dialog on their first
    // screen. Sharing one implementation rather than two copies is the point —
    // creating a key from Settings and creating a key from onboarding have to be
    // the same act, down to which failure clears the keys again.
    async createKey({ password, ownerCode }) {
        let cfg = await this.getConfig();
        if (!cfg.code) {
            const newCode = generateSpaceCode();
            await writeMeta(SYNC_CONFIG_KEY, { ...cfg, deviceId: await ensureDeviceId(), code: newCode });
            cfg = await this.getConfig();
        }
        const created = await authService.createSpace({ code: cfg.code, password });
        if (!created.ok) return created;
        const connect = await this.connectSpaceToServer(cfg.code, password, cfg);
        // An offline or unreachable server is not a failure here: the key is
        // already created and stored, sync will pick the space up on its own
        // schedule, and refusing to finish setup because the network was down
        // would lose a password the user had just chosen.
        if (!connect.ok && connect.code !== "network" && connect.code !== "offline") {
            await cryptoService.clearEncryptionKeys();
            return { ok: false, code: connect.code };
        }
        await setStatus({ status: "idle", authRequired: true, lastSyncAt: null });
        authService.scheduleSessionRotation(() => this.rotateSession());
        startSyncLoop();
        const owner = await authService.resolveOwner(ownerCode);
        if (!owner.ok) return owner;
        return { ok: true, code: cfg.code, encryptedKey: created.encryptedKey, owner: owner.verifier };
    },

    async exportSyncFile(opts = null) {
        const encryptedKey = await cryptoService.getEncryptedKey();
        const isNew = !encryptedKey || !encryptedKey.d;
        const hasOwner = !!(await authService.getOwnerVerifier());

        if (!opts || !opts.password) {
            return { ok: true, json: null, requiresPassword: true, isNew, hasOwner, fileName: syncFileName() };
        }
        const { password, ownerCode } = opts;

        if (isNew) {
            const created = await this.createKey({ password, ownerCode });
            if (!created.ok) return created;
            return this.finishExport(created.code, created.encryptedKey, created.owner);
        }

        const verified = await authService.verifyPassword(password);
        if (!verified) return { ok: false, code: "invalid_credentials" };

        const cfg = await this.getConfig();
        if (!cfg.code) return { ok: false, code: "not_configured" };
        const owner = await authService.resolveOwner(ownerCode);
        if (!owner.ok) return owner;
        return this.finishExport(cfg.code, encryptedKey, owner.verifier);
    },

    finishExport(code, encryptedKey, owner) {
        const payload = buildSyncFile({ code, encryptedPayload: encryptedKey, owner });
        const json = serializeSyncFile(payload);
        if (!payload || json === null) return { ok: false, code: "sync_invalid" };
        return { ok: true, json, fileName: syncFileName() };
    },

    async importSyncFile(text, passwordOrOpts) {
        const opts = typeof passwordOrOpts === "object" ? passwordOrOpts : { password: passwordOrOpts };
        let password = opts.password;
        if (!password && opts.getPassword) {
            const parsed = parseSyncFile(text);
            if (!parsed.ok) return parsed;
            password = await opts.getPassword(parsed.data.code);
        }
        const parsed = parseSyncFile(text);
        if (!parsed.ok) return parsed;
        const { code, encryptedPayload } = parsed.data;
        const fileOwner = parsed.data.owner || null;

        if (!password) return { ok: false, code: "password_required" };

        // Owner secret code: a fixed per-account number (set once). When the
        // file (or this device) carries a verifier we must match it — otherwise
        // the file belongs to someone else and cannot be used here.
        const ownerVerifier = fileOwner || (await authService.getOwnerVerifier()) || null;
        let ownerCode = opts.ownerCode;
        if (ownerCode == null && typeof opts.getOwnerCode === "function") ownerCode = await opts.getOwnerCode();

        // Verified here, persisted later. Everything below this point can still
        // fail on the password, and a device that pinned itself to a file it
        // could not decrypt can never be un-pinned through the UI: every later
        // export and import then verifies against the wrong owner and is
        // refused. A mistyped password was enough to get there.
        let pendingOwnerVerifier = null;
        if (ownerVerifier) {
            if (!ownerCode) return { ok: false, code: typeof opts.getOwnerCode === "function" ? "cancelled" : "owner_code_required" };
            const ok = await authService.verifyOwnerCode(ownerCode, ownerVerifier);
            if (!ok) return { ok: false, code: "owner_mismatch" };
            if (!(await authService.getOwnerVerifier())) pendingOwnerVerifier = ownerVerifier;
        } else if (typeof opts.getOwnerCode === "function") {
            // Legacy file without owner info: the first import sets it once.
            // The owner secret number is required here too — cancel = abort.
            if (!ownerCode) return { ok: false, code: "cancelled" };
            pendingOwnerVerifier = await cryptoService.createOwnerVerifier(ownerCode);
        }

        const existingCfg = await readMeta(SYNC_CONFIG_KEY, null) || {};
        const existingEncKey = await cryptoService.getEncryptedKey();

        if (existingEncKey && existingEncKey.d && existingCfg.code) {
            const sameKey = existingEncKey.d === encryptedPayload.d;
            if (!sameKey && existingCfg.code !== code) {
                // Answering this prompt wipes the device's sync setup, so make
                // sure the file can actually be opened BEFORE asking: the
                // Settings flow used to clear the config and the key for a file
                // it then failed to decrypt, leaving the device configured for
                // nothing and with no way back but re-importing by hand.
                try { await cryptoService.decryptMasterKey(encryptedPayload, password); }
                catch { return { ok: false, code: "decryption_failed" }; }
                return {
                    ok: true,
                    requiresAction: "cross_space",
                    fileCode: code,
                    currentCode: existingCfg.code
                };
            }
        }

        const local = await authService.openSpace({ code, password, getEncryptedKey: () => encryptedPayload });
        if (!local.ok) return local;
        // The password opened the key: only now does this device belong to the
        // file's owner.
        if (pendingOwnerVerifier) await authService.storeOwnerVerifier(pendingOwnerVerifier);

        const cfg = await this.ensureConfig();
        const connect = await this.connectSpaceToServer(code, password, cfg);
        if (!connect.ok) {
            await setStatus({ status: "unauthorized", lastError: connect.code, authRequired: true });
            return { ok: false, code: connect.code };
        }

        await this.saveConfig({ code });
        await setStatus({ status: "idle", authRequired: false, lastSyncAt: Date.now() });
        authService.scheduleSessionRotation(() => this.rotateSession());
        startSyncLoop();
        await this.syncNow();
        return { ok: true, merged: true };
    }
};
