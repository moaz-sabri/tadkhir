import test from "node:test";
import assert from "node:assert/strict";
import {
    SYNC_FILE_APP,
    SYNC_FILE_VERSION,
    buildSyncFile,
    serializeSyncFile,
    parseSyncFile,
    isOwnerVerifier,
} from "../app/js/services/sync-file.js";

const EK = "AAAAbW9ja2VkLWVuY3J5cHRlZC1rZXk=";
const OWNER = { v: 1, s: "c2FsdC0xMjM0NTY3ODkwMTIzNDU2", h: "aGFzaC1vZi1vd25lci1jb2RlLTMyYnl0ZXM" };

test("buildSyncFile carries version 4, code, ek and optional owner", () => {
    const p = buildSyncFile({ code: "space-a1b2c3", encryptedPayload: { v: 1, d: EK } });
    assert.ok(p);
    assert.equal(p.version, SYNC_FILE_VERSION);
    assert.equal(p.version, 4);
    assert.equal(p.code, "space-a1b2c3");
    assert.equal(p.ek, EK);
    assert.equal(p.owner, undefined);

    const withOwner = buildSyncFile({ code: "space-a1b2c3", encryptedPayload: { v: 1, d: EK }, owner: OWNER });
    assert.ok(withOwner);
    assert.deepEqual(withOwner.owner, OWNER);
});

test("buildSyncFile rejects invalid codes or missing key", () => {
    assert.equal(buildSyncFile({ code: "", encryptedPayload: { d: EK } }), null);
    assert.equal(buildSyncFile({ code: "ab", encryptedPayload: { d: EK } }), null);
    assert.equal(buildSyncFile({ code: "space-ok", encryptedPayload: null }), null);
    assert.equal(buildSyncFile({ code: "space-ok", encryptedPayload: {} }), null);
});

test("serialize + parse round-trips code, ek and owner", () => {
    const payload = buildSyncFile({ code: "space-round-1", encryptedPayload: { v: 1, d: EK }, owner: OWNER });
    const json = serializeSyncFile(payload);
    const res = parseSyncFile(json);
    assert.equal(res.ok, true);
    assert.equal(res.data.code, "space-round-1");
    assert.equal(res.data.encryptedPayload.d, EK);
    assert.deepEqual(res.data.owner, OWNER);
});

test("parseSyncFile accepts legacy v3 files without owner", () => {
    const legacy = JSON.stringify({
        app: SYNC_FILE_APP,
        version: 3,
        code: "space-legacy",
        createdAt: "2026-01-01T00:00:00.000Z",
        ek: EK
    });
    const res = parseSyncFile(legacy);
    assert.equal(res.ok, true);
    assert.equal(res.data.code, "space-legacy");
    assert.equal(res.data.owner, null);
});

test("parseSyncFile rejects files from newer versions", () => {
    const future = JSON.stringify({
        app: SYNC_FILE_APP,
        version: SYNC_FILE_VERSION + 1,
        code: "space-future",
        ek: EK
    });
    const res = parseSyncFile(future);
    assert.equal(res.ok, false);
    assert.equal(res.code, "sync_too_new");
});

test("parseSyncFile rejects malformed input and bad owner shapes", () => {
    assert.equal(parseSyncFile("not json").ok, false);
    assert.equal(parseSyncFile(JSON.stringify({ app: "other" })).ok, false);
    assert.equal(parseSyncFile(JSON.stringify({ app: SYNC_FILE_APP, code: "x", ek: EK })).ok, false);

    const badOwner = JSON.stringify({
        app: SYNC_FILE_APP,
        version: 4,
        code: "space-bad",
        ek: EK,
        owner: { v: 1, s: "", h: "x" }
    });
    const res = parseSyncFile(badOwner);
    assert.equal(res.ok, true);
    assert.equal(res.data.owner, null);
});

test("isOwnerVerifier validates the verifier shape", () => {
    assert.equal(isOwnerVerifier(OWNER), true);
    assert.equal(isOwnerVerifier({ v: 1, s: "s", h: "h" }), true);
    assert.equal(isOwnerVerifier(null), false);
    assert.equal(isOwnerVerifier({}), false);
    assert.equal(isOwnerVerifier({ v: 1, s: "", h: "h" }), false);
    assert.equal(isOwnerVerifier({ v: 9, s: "s", h: "h" }), false);
});