import test from "node:test";
import assert from "node:assert/strict";
import {
    readShareParams,
    hasContent,
    hasToken,
    sharePrefill
} from "../app/js/app/share-payload.js";

// The manifest's share target posts to /api/share/intake, which parks what was
// shared and redirects to /share?t=<token>; a browser without the file share
// target still sends the three text parameters directly. These are the pure
// helpers that turn either shape into something a form can use. The
// sessionStorage half (stash/take/peek) needs a browser and is not covered here;
// what matters for a test is that the parsing rule is the one the share sheet's
// actual payloads produce.

test("readShareParams pulls the share parameters out of a query string", () => {
    const p = readShareParams("?title=Deep%20work&text=read%20this&url=https%3A%2F%2Fexample.com%2Fa");
    assert.deepEqual(p, {
        title: "Deep work",
        text: "read this",
        url: "https://example.com/a",
        token: ""
    });
});

test("readShareParams reads the intake token a parked share is named by", () => {
    // The token is the whole of a shared FILE, since a file cannot travel in a
    // URL. It is read here and validated in hasToken, so nothing downstream ever
    // puts an arbitrary query parameter into a request URL.
    const token = "a".repeat(32);
    assert.equal(readShareParams(`?t=${token}`).token, token);
    assert.equal(readShareParams("?t=%20").token, "");
    assert.equal(hasToken(readShareParams(`?t=${token}`)), true);
    assert.equal(hasToken(readShareParams(`?t=${"a".repeat(31)}`)), false,
        "31 hex characters is not a token");
    assert.equal(hasToken(readShareParams("?t=" + "A".repeat(32))), false,
        "uppercase is not what the server issues");
    assert.equal(hasToken(readShareParams(`?t=${"g".repeat(32)}`)), false,
        "a token is hexadecimal, not arbitrary text");
    assert.equal(hasToken({ token: "../../etc/passwd" }), false);
    assert.equal(hasToken(null), false);
    // A share whose only content is a parked file is still a share.
    assert.equal(hasContent({ title: "", text: "", url: "", token }), true);
});

test("readShareParams trims and treats missing parameters as empty", () => {
    const p = readShareParams("?title=%20%20&text=only%20this");
    assert.deepEqual(p, { title: "", text: "only this", url: "", token: "" });
    assert.deepEqual(readShareParams(""), { title: "", text: "", url: "", token: "" });
});

test("hasContent rejects an empty share", () => {
    // An empty share is not a record, not a session title and not a note, so
    // there is nothing to offer and nothing worth storing.
    assert.equal(hasContent(null), false);
    assert.equal(hasContent({ title: "", text: "", url: "", token: "" }), false);
    assert.equal(hasContent({ title: "x", text: "", url: "" }), true);
    assert.equal(hasContent({ title: "", text: "x", url: "" }), true);
    assert.equal(hasContent({ title: "", text: "", url: "https://x.dev" }), true);
});

test("sharePrefill prefers the page title over text that is only a link", () => {
    // Very common shape: the share sheet puts the link in `text` and repeats the
    // page name in `title`. Filling the form with the raw link would be useless.
    const p = { title: "Deep work", text: "https://example.com/a", url: "https://example.com/a" };
    assert.equal(sharePrefill(p), "Deep work");
});

test("sharePrefill uses the shared text when there is no title", () => {
    const p = { title: "", text: "buy milk on the way home", url: "" };
    assert.equal(sharePrefill(p), "buy milk on the way home");
});

test("sharePrefill falls back to the url when the text carries nothing else", () => {
    const p = { title: "", text: "https://example.com/a", url: "https://example.com/a" };
    assert.equal(sharePrefill(p), "https://example.com/a");
});

test("sharePrefill caps at the field's own limit", () => {
    const p = { title: "x".repeat(500), text: "", url: "" };
    assert.equal(sharePrefill(p, 120).length, 120);
    assert.equal(sharePrefill(p).length, 120);
});

test("sharePrefill of nothing is an empty string, not undefined", () => {
    // The form treats an empty prefill as "leave the field for the user to fill",
    // and `null` would show up as the word "null" in an input.
    assert.equal(sharePrefill(null), "");
    assert.equal(sharePrefill({ title: "", text: "", url: "" }), "");
});
