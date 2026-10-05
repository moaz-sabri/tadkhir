import { strings } from "./strings.js";

let lang = "en";

export function directionFor(x) {
    return x === "ar" ? "rtl" : "ltr";
}

export function initLanguage(preferred) {
    lang = preferred && strings[preferred]
        ? preferred
        : (navigator.language?.toLowerCase().startsWith("ar") ? "ar" : "en");
    applyLanguage();
}

export function setLanguage(x) {
    if (!strings[x]) return;
    lang = x;
    applyLanguage();
}

export function getLanguage() {
    return lang;
}

function applyLanguage() {
    document.documentElement.lang = lang;
    document.documentElement.dir = directionFor(lang);
}

export function t(key, params = {}) {
    let v = key.split(".").reduce((o, k) => o?.[k], strings[lang]);
    if (typeof v !== "string") return key;
    return v.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? "");
}