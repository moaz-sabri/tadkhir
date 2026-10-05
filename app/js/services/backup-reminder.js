import { store } from "../app/store.js";
import { toast } from "../ui/components/toast.js";
import { BACKUP_REMINDER_DAYS } from "../config.js";

// Nudges for a backup once a month, but only once there is something to lose.
//
// It lives here rather than in main.js because both the home page and the boot
// sequence want it, and home.js importing it back out of main.js made the two
// modules a cycle: main.js imports home.js for its route, and home.js imported
// main.js for this. A cycle works until a bundler reorders it.
//
// A device that has never taken a backup and has no tasks has nothing to lose,
// so it is left alone — otherwise the very first launch greets every new user
// with a warning about data they do not have.
export function checkBackupReminder() {
    const { tasks, settings } = store.getState();
    if (tasks.length === 0 && settings.lastBackup == null) return;
    const last = settings.lastBackup;
    if (last == null || Date.now() - last > BACKUP_REMINDER_DAYS * 86400000) {
        toast.show("home.backupReminder");
    }
}
