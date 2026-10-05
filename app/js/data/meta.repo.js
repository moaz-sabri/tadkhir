import { req } from "./db.js";

export const metaRepo = s => ({
    get: key => req(s.get(key)),
    set: (key, value) => req(s.put({ key, value })),
    // `delete` is what cryptoService.clearEncryptionKeys() needs to drop a
    // single key. It was missing, so that call threw a TypeError on every
    // invocation — including from inside a catch block, which turned the real
    // failure ("space already exists") into a bare crash, and from the Settings
    // cross-space flow, which wiped the sync config and then died before it
    // could re-open the replacement space.
    delete: key => req(s.delete(key)),
    clear: () => req(s.clear())
});