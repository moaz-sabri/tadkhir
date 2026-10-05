// Verifies that every i18n key referenced with a literal t("...") actually
// exists in BOTH the en and ar tables. t() returns the key itself on a miss,
// so a missing key is a visible bug, not a silent fallback.
//
// Run: node tools/check-i18n.mjs
import { strings } from "../app/js/i18n/strings.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const lookup = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const files = [];
const walk = dir => {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".js")) files.push(p);
    }
};
walk(join(root, "app/js"));

// A key reaches the user through t("..."), but also through dialog.confirm /
// dialog.choose / toast.show, which take the key untranslated. All four are
// literal-key call sites, so all four are checked; the `error.` table is
// excluded from the orphan report because it is referenced by building the
// key at runtime (toast.show(`error.${e.code}`)).
const CALL_SITES = /(?:^|[^\w.])(?:t|dialog\.confirm|dialog\.choose|dialog\.prompt|toast\.show)\(\s*["']([a-zA-Z0-9_.]+)["']/g;

const missing = new Map();
const used = new Set();
for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL_SITES)) {
        const key = m[1];
        used.add(key);
        const absent = {
            en: lookup(strings.en, key) === undefined,
            ar: lookup(strings.ar, key) === undefined
        };
        if (absent.en || absent.ar) {
            if (!missing.has(key)) missing.set(key, { ...absent, where: [] });
            missing.get(key).where.push(relative(root, file));
        }
    }
}

if (missing.size === 0) {
    console.log(`OK: every literal key exists in both en and ar (${files.length} files scanned)`);
} else {
    console.log(`MISSING KEYS (${missing.size}):`);
    for (const [key, v] of missing) {
        console.log(`  ${key}  [en:${v.en ? "MISSING" : "ok"} ar:${v.ar ? "MISSING" : "ok"}]  ${v.where[0]}`);
    }
    process.exitCode = 1;
}

// Keys defined in both locales but never referenced by a literal call site.
// Template-literal keys (t(`finance.${x}`)) are invisible here, so this is a
// hint to review, not a hard failure.
const orphans = [];
const walkKeys = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object") walkKeys(v, key);
        else if (!used.has(key) && !key.startsWith("error.")) orphans.push(key);
    }
};
walkKeys(strings.en, "");
if (orphans.length) {
    console.log(`\nkeys with no literal call site (${orphans.length}):`);
    console.log(`  ${orphans.join("\n  ")}`);
}
