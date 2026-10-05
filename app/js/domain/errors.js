// The app's error types.
//
// Every one of them carries a `code`, and every code has an `error.<code>`
// string in both language tables. That contract is what lets every catch site
// in the UI do the same one thing — `toast.show(\`error.${e.code}\`)` — instead
// of each one inventing a fallback. An error without a code falls back to
// `e.message`, which for a transition error is the *action name*: pressing
// Pause on an already-paused session produced a toast reading "error.pause".

export class ValidationError extends Error {
    constructor(field, code) {
        super(code);
        this.name = "ValidationError";
        this.field = field;
        this.code = code;
    }
}

export class InvalidTransitionError extends Error {
    constructor(from, action) {
        // The message keeps the detail for the console; the code is the one the
        // user sees, so it says what happened rather than what was attempted.
        super(`${action} is not allowed from ${from}`);
        this.name = "InvalidTransitionError";
        this.from = from;
        this.action = action;
        this.code = "invalid_transition";
    }
}

export class ActiveSessionExistsError extends Error {
    constructor(sessionId = null) {
        super("active_session_exists");
        this.name = "ActiveSessionExistsError";
        this.sessionId = sessionId;
        this.code = "active_session_exists";
    }
}

export class NotFoundError extends Error {
    constructor(entity, id) {
        super("not_found");
        this.name = "NotFoundError";
        this.entity = entity;
        this.id = id;
        this.code = "not_found";
    }
}

export class TaskBusyError extends Error {
    constructor(taskId) {
        super("task_busy");
        this.name = "TaskBusyError";
        this.taskId = taskId;
        this.code = "task_busy";
    }
}

export class ImportError extends Error {
    constructor(code, detail = null) {
        super(code);
        this.name = "ImportError";
        this.code = code;
        this.detail = detail;
    }
}

// A write that awaited something outside its own transaction, so the
// transaction committed before the write finished. It is a bug in the caller,
// not bad input, and it is deliberately loud: the alternative is reporting
// success for records that were never written.
export class TransactionInactiveError extends Error {
    constructor() {
        super("transaction_inactive");
        this.name = "TransactionInactiveError";
        this.code = "transaction_inactive";
    }
}
