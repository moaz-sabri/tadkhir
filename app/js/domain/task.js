export function rankTasks(tasks) {
    return tasks
        .filter(t => !t.archived)
        .slice()
        .sort((a, b) =>
            Number(b.pinned) - Number(a.pinned)
            || b.usageCount - a.usageCount
            || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
            || b.createdAt - a.createdAt
        );
}