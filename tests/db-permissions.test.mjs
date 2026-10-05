import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The database file and its directory are the last thing between an account and
// anyone who can read the volume. The code already asks for 0700 on the
// directory, but only on the path that CREATES it, so a directory that already
// exists — which is every Docker deployment, because the Dockerfile and the
// named volume both make it first — kept whatever umask gave it. The file
// itself was never chmod'd at all, and SQLite creates it 0644.
//
// Observed in the running container before this change:
//   drwxr-xr-x 2 tt tt  /app/api/var
//   -rw-r--r-- 1 tt tt  /app/api/var/sync.sqlite
//
// It is a narrow fix — the container is the real boundary, and root can read
// the file either way — but it makes the code do what it already says it does,
// and it costs two lines.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

test("the database directory is created 0700 and the file is chmod'd 0600", () => {
    const db = read("api/db.php");
    assert.match(db, /mkdir\(\$dir,\s*0700/,
        "the directory is created 0700, not with the umask default");
    // The file is tightened after it exists, because CREATE only governs the
    // first creation and a bind-mounted or pre-made file never passes through it.
    assert.match(db, /chmod\(\$cfg\['db_path'\],\s*0600\)|chmod\([^,]+,\s*0600\)/,
        "the SQLite file is chmod'd 0600 once it exists");
    // Best-effort: a filesystem that refuses (some bind mounts, some CI volumes)
    // must not stop the app from starting.
    assert.match(db, /@chmod/,
        "the chmod must be best-effort, so a read-only or exotic mount is not fatal");
});

test("the Dockerfile does not pre-create the data directory as 0755", () => {
    const dockerfile = read("Dockerfile");
    // If the directory is created here, db.php's mkdir(0700) never runs, and the
    // volume inherits whatever this produced.
    const mk = /mkdir[^\n]*\/app\/api\/var[^\n]*/.exec(dockerfile);
    assert.ok(!mk || /chmod\s+700/.test(mk[0]),
        "a pre-created data directory must be chmod 700 in the same instruction");
});

test("the data directory is not inside the build context", () => {
    // api/var/ holds the live database. Shipping it into an image would bake one
    // account's records and password hashes into a layer anyone with the image
    // can read.
    assert.ok(read(".dockerignore").includes("api/var"),
        ".dockerignore must exclude api/var");
    // The php stage does `COPY api ./api`, which would include api/var — so the
    // exclusion in .dockerignore is what actually prevents it.
    assert.match(read("Dockerfile"), /COPY api \.\/api/,
        "the php stage copies the api directory, so .dockerignore is load-bearing");
});
