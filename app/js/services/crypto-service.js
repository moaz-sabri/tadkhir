import { withTx } from "../data/db.js";
import { metaRepo } from "../data/meta.repo.js";

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 600000;
const MASTER_KEY_NAME = "task-timer-master-key";
const ENCRYPTED_KEY_NAME = "task-timer-encrypted-key";
const KEK_SALT_NAME = "task-timer-kek-salt";
const OWNER_VERIFIER_NAME = "task-timer-owner-verifier";

export const CRYPTO_VERSION = 1;

async function getCrypto() {
    if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new Error("crypto_unavailable");
    }
    return crypto.subtle;
}

async function deriveKEK(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await (await getCrypto()).importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );
    return await (await getCrypto()).deriveKey(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        keyMaterial,
        { name: ALGORITHM, length: KEY_LENGTH },
        false,
        ["encrypt", "decrypt"]
    );
}

export async function generateMasterKey() {
    return await (await getCrypto()).generateKey(
        { name: ALGORITHM, length: KEY_LENGTH },
        true,
        ["encrypt", "decrypt"]
    );
}

function uint8ToBase64(uint8) {
    let binary = "";
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    return btoa(binary);
}

function base64ToUint8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export async function encryptMasterKey(masterKey, password) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const kek = await deriveKEK(password, salt);
    const exported = await (await getCrypto()).exportKey("raw", masterKey);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await (await getCrypto()).encrypt(
        { name: ALGORITHM, iv },
        kek,
        exported
    );
    const payload = new Uint8Array([...salt, ...iv, ...new Uint8Array(encrypted)]);
    return { v: CRYPTO_VERSION, d: uint8ToBase64(payload) };
}

export async function decryptMasterKey(encryptedPayload, password) {
    const raw = base64ToUint8(encryptedPayload.d);
    const salt = raw.slice(0, SALT_LENGTH);
    const iv = raw.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ct = raw.slice(SALT_LENGTH + IV_LENGTH);
    const kek = await deriveKEK(password, salt);
    const decrypted = await (await getCrypto()).decrypt(
        { name: ALGORITHM, iv },
        kek,
        ct
    );
    return await (await getCrypto()).importKey(
        "raw",
        decrypted,
        { name: ALGORITHM, length: KEY_LENGTH },
        true,
        ["encrypt", "decrypt"]
    );
}

export async function encryptData(masterKey, data) {
    const json = JSON.stringify(data);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(json);
    const ciphertext = await (await getCrypto()).encrypt(
        { name: ALGORITHM, iv },
        masterKey,
        encoded
    );
    const payload = new Uint8Array([...iv, ...new Uint8Array(ciphertext)]);
    return uint8ToBase64(payload);
}

export async function decryptData(masterKey, b64) {
    if (!b64 || typeof b64 !== "string") return null;
    try {
        const raw = base64ToUint8(b64);
        const iv = raw.slice(0, IV_LENGTH);
        const ct = raw.slice(IV_LENGTH);
        const decrypted = await (await getCrypto()).decrypt(
            { name: ALGORITHM, iv },
            masterKey,
            ct
        );
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

export async function storeEncryptedKey(encryptedPayload) {
    await withTx(["meta"], "readwrite", r => metaRepo(r.meta).set(ENCRYPTED_KEY_NAME, encryptedPayload));
}

export async function getEncryptedKey() {
    const rec = await withTx(["meta"], "readonly", r => metaRepo(r.meta).get(ENCRYPTED_KEY_NAME));
    return rec ? rec.value : null;
}

export async function storeKEKSalt(saltB64) {
    await withTx(["meta"], "readwrite", r => metaRepo(r.meta).set(KEK_SALT_NAME, saltB64));
}

export async function getKEKSalt() {
    const rec = await withTx(["meta"], "readonly", r => metaRepo(r.meta).get(KEK_SALT_NAME));
    return rec ? rec.value : null;
}

/* --------------------------- Owner secret code --------------------------- */
//
// Every account is owned by ONE person via a fixed secret number (owner code)
// that is set once — on the first export or import — and never changes. The
// code is never stored in the clear: we keep a PBKDF2 verifier locally and
// embed the same verifier in exported backups and secret files so that other
// devices of the same owner can confirm the number, while anyone without it
// gets an "owner mismatch" and cannot use the file (no sharing across people).

function isValidOwnerVerifier(v) {
    return !!(
        v &&
        typeof v === "object" &&
        (v.v === 1 || v.v == null) &&
        typeof v.s === "string" && v.s !== "" &&
        typeof v.h === "string" && v.h !== ""
    );
}

async function deriveOwnerHash(ownerCode, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await (await getCrypto()).importKey(
        "raw",
        enc.encode(ownerCode),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await (await getCrypto()).deriveBits(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        keyMaterial,
        256
    );
    return uint8ToBase64(new Uint8Array(bits));
}

/** Create a verifier ({v,s,h}) for a new owner secret code. */
export async function createOwnerVerifier(ownerCode) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const h = await deriveOwnerHash(String(ownerCode), salt);
    return { v: 1, s: uint8ToBase64(salt), h };
}

/** Check an owner secret code against a stored verifier. Never stores the code. */
export async function verifyOwnerCode(ownerCode, verifier) {
    if (!ownerCode || !isValidOwnerVerifier(verifier)) return false;
    try {
        const salt = base64ToUint8(verifier.s);
        const h = await deriveOwnerHash(String(ownerCode), salt);
        return h === verifier.h;
    } catch {
        return false;
    }
}

export async function getOwnerVerifier() {
    const rec = await withTx(["meta"], "readonly", r => metaRepo(r.meta).get(OWNER_VERIFIER_NAME));
    return rec && isValidOwnerVerifier(rec.value) ? rec.value : null;
}

export async function storeOwnerVerifier(verifier) {
    if (!isValidOwnerVerifier(verifier)) throw new Error("invalid_owner_verifier");
    await withTx(["meta"], "readwrite", r => metaRepo(r.meta).set(OWNER_VERIFIER_NAME, verifier));
}

export async function hasEncryptionKeys() {
    const encKey = await getEncryptedKey();
    return !!(encKey && encKey.d);
}

export async function clearEncryptionKeys() {
    await withTx(["meta"], "readwrite", r => {
        metaRepo(r.meta).delete(ENCRYPTED_KEY_NAME);
        metaRepo(r.meta).delete(KEK_SALT_NAME);
    });
}

export async function encryptAndStoreMasterKey(masterKey, password) {
    const encrypted = await encryptMasterKey(masterKey, password);
    await storeEncryptedKey(encrypted);
    return encrypted;
}

export async function loadMasterKey(password) {
    const enc = await getEncryptedKey();
    if (!enc || !enc.d) throw new Error("no_encrypted_key");
    return await decryptMasterKey(enc, password);
}

export async function encryptRecord(masterKey, record) {
    return await encryptData(masterKey, record);
}

export async function decryptRecord(masterKey, b64) {
    return await decryptData(masterKey, b64);
}

export { MASTER_KEY_NAME, ENCRYPTED_KEY_NAME, KEK_SALT_NAME, OWNER_VERIFIER_NAME };
