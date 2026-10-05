// Sync-file (secret key) format — fully encrypted.
//
// The sync file contains:
//   - the space code (identifier) — fixed for the lifetime of the account
//   - the encrypted master key (encrypted with password-derived key via crypto-service)
//   - the owner secret-code verifier (PBKDF2), when the account has one
// The file is unreadable without the password. It is fully encrypted,
// never stores the password in any form.
//
// Importing it requires the password to decrypt the master key, plus the
// owner secret code (when the file carries one) to prove ownership — a file
// belongs to one owner and cannot be used by someone who lacks the code.
// The password is never stored in the sync file or anywhere on disk.

import { CRYPTO_VERSION } from "./crypto-service.js";

export const SYNC_FILE_APP = "task-timer";
export const SYNC_FILE_VERSION = 4;
export const SYNC_FILE_MIME = "application/octet-stream";
export const SYNC_FILE_EXT = ".sync.enc";

export function syncFileName() {
    return `task-timer-${new Date().toISOString().slice(0, 10)}${SYNC_FILE_EXT}`;
}

const CODE_RE = /^[A-Za-z0-9_-]{3,64}$/;

// Owner secret-code verifier embedded in the file: { v:1, s:saltB64, h:hashB64 }.
// It identifies the file's owner without ever storing the secret number.
export function isOwnerVerifier(v) {
    return !!(
        v &&
        typeof v === "object" &&
        (v.v === 1 || v.v == null) &&
        typeof v.s === "string" && v.s !== "" &&
        typeof v.h === "string" && v.h !== ""
    );
}

/**
 * Build a sync-file payload from code + encrypted master-key payload.
 * The encryptedPayload is the output from cryptoService.encryptMasterKey().
 * Returns null when the code is invalid.
 */
export function buildSyncFile({ code, encryptedPayload, owner }) {
    const c = String(code || "");
    if (!CODE_RE.test(c)) return null;
    if (!encryptedPayload || !encryptedPayload.d) return null;
    return {
        app: SYNC_FILE_APP,
        version: SYNC_FILE_VERSION,
        code: c,
        createdAt: new Date().toISOString(),
        ek: encryptedPayload.d,
        ...(isOwnerVerifier(owner) ? { owner } : {})
    };
}

/** Serialize a sync file to its JSON string. Returns null on invalid input. */
export function serializeSyncFile(payload) {
    if (!payload || typeof payload !== "object") return null;
    return JSON.stringify(payload, null, 2);
}

/**
 * Parse + validate a sync file.
 * Returns {ok:true, data:{code, encryptedPayload}} or {ok:false, code}.
 * The encryptedPayload is the raw encrypted master-key blob — NOT decrypted here.
 * Decryption happens in cryptoService.decryptMasterKey().
 */
export function parseSyncFile(text) {
    let obj;
    try {
        obj = JSON.parse(text);
    } catch {
        return { ok: false, code: "sync_invalid" };
    }
    if (!obj || typeof obj !== "object" || obj.app !== SYNC_FILE_APP) {
        return { ok: false, code: "sync_invalid" };
    }
    if (obj.version != null && obj.version > SYNC_FILE_VERSION) {
        return { ok: false, code: "sync_too_new" };
    }
    if (!CODE_RE.test(String(obj.code || ""))) {
        return { ok: false, code: "sync_invalid" };
    }
    if (!obj.ek || typeof obj.ek !== "string") {
        return { ok: false, code: "sync_invalid" };
    }
    return {
        ok: true,
        data: {
            code: String(obj.code),
            encryptedPayload: { v: obj.version || CRYPTO_VERSION, d: obj.ek },
            owner: isOwnerVerifier(obj.owner) ? obj.owner : null
        }
    };
}
