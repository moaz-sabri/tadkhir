import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { routineService } from "../../services/routine-service.js";
import { routineForm } from "../components/routine-form.js";
import { routineRow, counterRatio } from "../components/routine-row.js";
import { toast } from "../components/toast.js";
import { dialog } from "../components/dialog.js";
import { haptics } from "../../app/haptics.js";
import { formatDate, formatShort } from "../../domain/time.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    listRow,
    badge,
    emptyState,
    action,
    backTo,
    toolbar,
    stat,
    statPanel,
    notFoundView
} from "../components/ui.js";

const BASE = "/routines";

// The list, and the one place a routine is created from inside the app.
//
// Two sections: what is wanted today, and everything else. The split is not a
// filter on "overdue" — nothing here is ever late — it is the same split the home
// screen draws, for the same reason: a list that opens on yesterday's leftovers
// is a list that reads like a debt. A daily routine and a routine whose weekday is
// today are wanted today; the rest are simply not, and they are still here to be
// edited or deleted.
export const routinesPage = {
    title: () => t("routine.title"),

    async mount(root) {
        const todayBox = h("div", { class: "list" });
        const otherBox = h("div", { class: "list" });
        const otherSection = pageSection({
            title: t("routine.allList"),
            icon: "repeat",
            body: otherBox,
            hidden: true
        });

        root.append(page(
            pageHead({
                title: t("routine.title"),
                icon: "repeat",
                actions: action({ label: t("routine.new"), icon: "plus", tone: "primary", href: `${BASE}/new` })
            }),
            h("p", { class: "muted" }, t("routine.hint")),
            pageSection({ title: t("routine.todayList"), icon: "clock", body: todayBox }),
            otherSection
        ));

        const render = async () => {
            const [all, today] = await Promise.all([routineService.list(), routineService.today()]);
            const wanted = new Map(today.map(v => [v.routine.id, v]));
            const rest = all.filter(r => !wanted.has(r.id));

            todayBox.replaceChildren(today.length === 0
                ? emptyState(t("routine.todayEmpty"), {
                    icon: "repeat",
                    action: action({
                        label: t("routine.new"),
                        icon: "plus",
                        tone: "primary",
                        href: `${BASE}/new`
                    })
                })
                : list(...today.map(view => routineRow(view, {
                    onStart: id => start(id, () => router.navigate("/session")),
                    onBump: (id, delta) => bump(id, delta, render)
                }))));

            otherBox.replaceChildren(list(...rest.map(r => listRow({
                href: `${BASE}/${r.id}`,
                icon: r.kind === "counter" ? "target" : "clock",
                title: r.title,
                subtitle: r.frequency === "weekly"
                    ? t("routine.everyWeekday", { day: t(`weekday.${r.weekday}`) })
                    : t("routine.everyDay"),
                meta: [
                    r.kind === "counter"
                        ? badge(t("routine.targetShort", { count: r.target }), { icon: "target" })
                        : r.durationMs
                            ? badge(formatShort(r.durationMs), { icon: "clock" })
                            : null
                ],
                tag: r.active === false ? badge(t("routine.paused")) : null
            }))));

            otherSection.hidden = rest.length === 0;
            root.append(otherSection);
        };

        const bump = async (id, delta, after) => {
            try {
                await routineService.bump(id, delta);
                haptics.do("ack");
                await after();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        const start = async (id, after) => {
            try {
                await routineService.start(id);
                await after();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        await render();
    }
};

// Starting a timed routine from anywhere: the app's own timer, then the session
// screen it already has. Written once here because the list screen and the home
// screen both need it and the answer is the same in both — a routine is not a
// place you go, it is something you start.
export async function startRoutine(id) {
    await routineService.start(id);
    router.navigate("/session");
}

export const newRoutine = {
    title: () => t("routine.new"),

    async mount(root) {
        root.append(page(
            pageHead({ title: t("routine.new"), icon: "plus", leading: backTo(BASE) }),
            routineForm(null, async input => {
                try {
                    await routineService.create(input);
                    router.navigate(BASE);
                } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
            })
        ));
    }
};

// One routine: the same form filled in, plus the things that only make sense about
// a single rule — what it recorded, and the two ways to stop having it.
export const routineDetail = {
    title: () => t("routine.edit"),

    async mount(root, params) {
        let routine;
        try {
            routine = await routineService.get(params.id);
        } catch {
            routine = null;
        }
        if (!routine) {
            notFoundView(root);
            return;
        }

        const days = await routineService.history(routine.id);
        // A routine's own recorded days, newest first, and each one a real date:
        // this is the only place in the feature where a past day appears, and it
        // appears as something the user did rather than as something they owed.
        // A day that has no row is not in the list — there is nothing to say
        // about it, and a row of zeroes would be a claim it was missed.
        const recorded = [...days]
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .map(day => listRow({
                icon: "check",
                title: formatDate(day.updatedAt),
                meta: [badge(counterRatio(day.count, routine.target), { icon: "target" })]
            }));

        const total = days.reduce((a, d) => a + (d.count ?? 0), 0);

        root.append(page(
            pageHead({
                title: t("routine.edit"),
                icon: routine.kind === "counter" ? "target" : "clock",
                leading: backTo(BASE),
                actions: routine.active === false
                    ? action({
                        label: t("routine.resume"),
                        icon: "play",
                        onClick: async () => {
                            try {
                                await routineService.update(routine.id, { active: true });
                                router.refresh();
                            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                        }
                    })
                    : null
            }),
            pageSection({ body: routineForm(routine, async input => {
                try {
                    // An edit keeps the rule's own state: `active` is switched on
                    // this screen's header, and a save that silently turned a
                    // paused routine back on would be a surprise in the opposite
                    // direction from the same surprise.
                    await routineService.update(routine.id, { ...input, active: routine.active });
                    toast.show("routine.saved");
                    router.navigate(BASE);
                } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
            }) }),
            pageSection({
                title: t("routine.runNow"),
                icon: "play",
                body: routine.kind === "timed"
                    ? action({
                        label: t("routine.start"),
                        icon: "play",
                        tone: "primary",
                        block: true,
                        onClick: () => startRoutine(routine.id)
                    })
                    : h("p", { class: "muted small" }, t("routine.counterHint"))
            }),
            // Only a counter has days of its own: a timed routine's history IS its
            // sessions, which the reports already count and this screen has no
            // business summarising a second way.
            routine.kind === "counter"
                ? pageSection({
                    title: t("routine.recorded"),
                    icon: "chart",
                    body: days.length === 0
                        ? h("p", { class: "muted small" }, t("routine.recordedNone"))
                        : statPanel(
                            stat({ label: t("routine.recordedDays"), value: days.length, icon: "calendar" }),
                            stat({ label: t("routine.recordedTotal"), value: total, icon: "target" })
                        ),
                })
                : null,
            recorded.length ? pageSection({ title: t("routine.recordedDaysList"), icon: "history", body: list(...recorded) }) : null,
            toolbar(
                routine.active === false
                    ? action({
                        label: t("routine.pause"),
                        icon: "pause",
                        onClick: async () => {
                            try {
                                await routineService.update(routine.id, { active: false });
                                router.navigate(BASE);
                            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                        }
                    })
                    : null,
                action({
                    label: t("common.delete"),
                    icon: "trash",
                    tone: "danger",
                    onClick: async () => {
                        if (!await dialog.confirm("routine.deleteConfirm")) return;
                        try {
                            await routineService.remove(routine.id);
                            router.navigate(BASE);
                        } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                })
            )
        ));
    }
};
