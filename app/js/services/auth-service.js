import * as cryptoService from "./crypto-service.js";
import { SESSION_ROOTATION_MS, SYNC_REQUEST_TIMEOUT_MS } from "../config.js";
import { requestSignal } from "../app/net.js";

let masterKey = null;
let sessionRotationTimer = null;
let lastSessionRotation = null;

// How soon to try again after a rotation that failed for a transient reason.
const ROTATION_RETRY_MS = 5 * 60 * 1000;
// The failures that mean "the server session is gone or unreachable" rather
// than "this device is not set up". See scheduleSessionRotation.
const TRANSIENT_ROTATION_FAILURES = new Set([
    "unauthorized", "rate_limited", "network", "server_error", "rotation_failed"
]);

export const authService = {
    async createSpace({ code, password }) {
        const mk = await cryptoService.generateMasterKey();
        const encryptedPayload = await cryptoService.encryptAndStoreMasterKey(mk, password);
        masterKey = mk;
        lastSessionRotation = Date.now();
        return { ok: true, encryptedKey: encryptedPayload };
    },

    async openSpace({ code, password, getEncryptedKey }) {
        let encPayload;
        if (getEncryptedKey) {
            encPayload = await getEncryptedKey();
        }
        if (!encPayload || !encPayload.d) {
            encPayload = await cryptoService.getEncryptedKey();
        }
        if (!encPayload || !encPayload.d) {
            return { ok: false, code: "no_encrypted_key" };
        }
        try {
            masterKey = await cryptoService.decryptMasterKey(encPayload, password);
        } catch {
            return { ok: false, code: "decryption_failed" };
        }
        await cryptoService.storeEncryptedKey(encPayload);
        lastSessionRotation = Date.now();
        return { ok: true };
    },

    async rotateSession(code, deviceId) {
        if (!masterKey) return { ok: false, code: "no_master_key" };
        const res = await fetchJson("auth/rotate", { code, deviceId });
        // The old fetchJson answered {ok:false, code:"network"} for EVERY
        // failure — a 401 from an expired session, a 500, a dead connection —
        // and rotateSession reported ok:true regardless. So a dead session was
        // indistinguishable from a fresh one: scheduleSessionRotation saw
        // success and re-armed itself for another 24h, and the caller painted
        // the status "idle" over an expired session. Nothing told the user
        // their session had gone until the next push or pull 401'd.
        if (!res || res.ok !== true) {
            return { ok: false, code: res?.code || "rotation_failed" };
        }
        lastSessionRotation = Date.now();
        return { ok: true, expiresAt: res.expiresAt ?? null };
    },

    scheduleSessionRotation(onRotation) {
        if (sessionRotationTimer) clearTimeout(sessionRotationTimer);
        const elapsed = Date.now() - (lastSessionRotation || 0);
        const remaining = Math.max(0, SESSION_ROOTATION_MS - elapsed);

        const tick = () => {
            sessionRotationTimer = setTimeout(async () => {
                const result = await onRotation();
                if (result?.ok) {
                    authService.scheduleSessionRotation(onRotation);
                    return;
                }
                // A rotation can fail for a reason that is not the owner's
                // fault and not worth signing out over: the server session
                // expired, the network was down, or the IP is rate limited. The
                // master key is still on disk and the encrypted key can still
                // re-open it, so retrying soon lets a device that was merely
                // offline heal itself, and a device whose session really did
                // expire keeps its key and shows the reconnect prompt. Only a
                // failure that means "this device is not set up" signs out.
                if (TRANSIENT_ROTATION_FAILURES.has(result?.code)) {
                    sessionRotationTimer = setTimeout(tick, ROTATION_RETRY_MS);
                    return;
                }
                authService.logout();
            }, remaining);
        };
        tick();
    },

    async verifyPassword(password) {
        const cfg = await cryptoService.getEncryptedKey();
        if (!cfg) return false;
        try {
            await cryptoService.decryptMasterKey(cfg, password);
            return true;
        } catch {
            return false;
        }
    },

    async recoverWithPassword(password) {
        const enc = await cryptoService.getEncryptedKey();
        if (!enc || !enc.d) return null;
        try {
            return await cryptoService.decryptMasterKey(enc, password);
        } catch {
            return null;
        }
    },

    /**
     * The fixed owner secret code. It is set once (first export/import) and
     * never changes; afterwards an export/import only succeeds when the same
     * number is provided again — that is what binds the account to one owner
     * and stops the file from being shared with other people.
     */
    getOwnerVerifier() {
        return cryptoService.getOwnerVerifier();
    },

    storeOwnerVerifier(verifier) {
        return cryptoService.storeOwnerVerifier(verifier);
    },

    verifyOwnerCode(ownerCode, verifier) {
        return cryptoService.verifyOwnerCode(ownerCode, verifier);
    },

    /**
     * Verify the fixed owner secret code, or register it when this device has
     * none yet (set once on the first export/import — afterwards the account
     * is bound to it and it never changes). Returns {ok:true, verifier} or
     * {ok:false, code}.
     */
    async resolveOwner(ownerCode) {
        const local = await cryptoService.getOwnerVerifier();
        if (local) {
            const ok = await cryptoService.verifyOwnerCode(ownerCode, local);
            return ok ? { ok: true, verifier: local } : { ok: false, code: "owner_mismatch" };
        }
        if (!ownerCode) return { ok: false, code: "owner_code_required" };
        const verifier = await cryptoService.createOwnerVerifier(ownerCode);
        await cryptoService.storeOwnerVerifier(verifier);
        return { ok: true, verifier };
    },

    getMasterKey() { return masterKey; },
    isAuthenticated() { return masterKey !== null; },

    async logout() {
        masterKey = null;
        if (sessionRotationTimer) {
            clearTimeout(sessionRotationTimer);
            sessionRotationTimer = null;
        }
        lastSessionRotation = null;
    }
};

// Auth's own transport. Unlike the sync service's, this one has to keep the
// server's error code instead of collapsing every failure into "network": the
// caller (rotateSession) decides whether the session is still alive from what
// comes back, and a swallowed 401 reads exactly like a successful rotation.
async function fetchJson(path, body) {
    let res;
    try {
        res = await fetch(`/api/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(body),
            // Same reason as the sync service's, and the same helper: a request
            // that never settles would hold the session rotation — which runs on a
            // 24-hour timer — open indefinitely. An abort lands in the catch
            // below and becomes `network`, which is one of the codes
            // TRANSIENT_ROTATION_FAILURES retries rather than signing out over.
            signal: requestSignal(SYNC_REQUEST_TIMEOUT_MS)
        });
    } catch {
        return { ok: false, code: "network" };
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!data || typeof data !== "object") {
        return { ok: false, code: res.ok ? "malformed" : "server_error" };
    }
    if (data.ok === true) return data;
    return {
        ok: false,
        code: data.error?.code
            || (res.status === 401 || res.status === 403 ? "unauthorized"
                : res.status === 429 ? "rate_limited"
                    : "server_error")
    };
}
