const listeners = new Map();

export const bus = {
    on(type, fn) {
        const set = listeners.get(type) || new Set();
        set.add(fn);
        listeners.set(type, set);
        return () => set.delete(fn);
    },
    emit(type, data) {
        for (const fn of listeners.get(type) || []) {
            fn(data);
        }
    }
};