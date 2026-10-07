import { Intervals } from './intervals';
import { Script, ScriptMode } from '../_models/script';

/**
 * What this factory needs from the project service.
 *
 * Written structurally rather than as ProjectService so the rules below can be tested without an
 * Angular TestBed - see scheduled-scripts.spec.ts.
 */
export interface ScheduledScriptsProject {
    getScripts(): Script[];
    /**
     * The project-load signal - "a project arrived, or the editor replaced the running one".
     * Optional: a caller that genuinely has no such signal still gets start().
     *
     * A getter, not the observable itself, and for the same reason getScripts is a method: both
     * call sites build this object in a FIELD INITIALIZER, and at that moment `this.projectService`
     * does not exist yet - the injected services are assigned by the constructor. Reading it
     * eagerly is TS2729 ("used before its initialization"), which the client test run caught.
     */
    onLoadHmi?(): { subscribe(handler: () => void): { unsubscribe(): void } } | undefined;
}

/** The running timer set, plus the entry points a route uses. */
export interface ScheduledScripts {
    start(): number;
    startAndFollowHmi(): number;
    stop(): void;
    count(): number;
}

/**
 * The scheduled CLIENT-side scripts of a project, as a running timer set.
 *
 * Why this is a factory and not two copies of seven lines:
 *
 * The scheduling used to exist in exactly one place - `initScheduledScripts()` in
 * home.component.ts - and the /view route (the big screen) never got an equivalent. The
 * consequence was the defect this file closes (P0-3): on /home the clock ran, on /view the same
 * project's scheduled scripts never fired, so the big screen looked frozen while the office
 * screen worked. A shared factory removes the possibility of the two entries drifting again:
 * there is one place that reads `mode === CLIENT && scheduling.interval > 0`.
 *
 * Why it also owns startAndFollowHmi() (batch A-3):
 *
 * The factory fixed the *rule* but not the *pipe*: each route still wrote its own
 * "start now if the project is loaded, and re-start whenever it arrives" - three lines in
 * home.component.ts, four in scadia-view.component.ts, the same shape twice. Two spellings of one
 * rule is exactly the drift this file exists to prevent, so the pipe lives here too. What stays
 * at the call site is only the part that is genuinely about the caller: scadia-view's `child`
 * guard, because whether this instance owns the page is not something the factory can know.
 *
 * Deliberately NOT a service. It holds no state that is shared between routes: each route owns
 * its own set of timers, and a singleton would make one route's teardown cancel the other's
 * scripts.
 *
 * @param projectService anything with getScripts(), and optionally onLoadHmi
 * @param scriptService  anything with evalScript(script)  - the caller, so a script runs with
 *                       the rights and the bindings of the component that scheduled it
 * @param log            optional sink for a project that cannot be scheduled yet
 */
export function createScheduledScripts(
    projectService: ScheduledScriptsProject,
    scriptService: { evalScript(script: Script): void },
    log?: (message: string) => void
): ScheduledScripts {
    const intervals = new Intervals();
    let follow: { unsubscribe(): void } = null;

    const scheduled: ScheduledScripts = {
        /**
         * (Re)start the timers from the project's current script list.
         * @returns how many scripts were scheduled, so a caller can log or assert on it
         */
        start(): number {
            intervals.clearIntervals();
            const scripts = projectService.getScripts();
            if (!scripts) {
                // getScripts() answers null before the project has loaded. Saying so out loud is
                // the whole point: the previous silent version is what made /home-only scheduling
                // invisible for so long.
                if (log) { log('scheduled scripts: the project has not loaded yet, nothing scheduled'); }
                return 0;
            }
            let scheduledCount = 0;
            scripts.forEach((script: Script) => {
                if (script && script.mode === ScriptMode.CLIENT && script.scheduling?.interval > 0) {
                    intervals.addInterval(
                        script.scheduling.interval * 1000,
                        scriptService.evalScript,
                        script,
                        scriptService
                    );
                    scheduledCount++;
                }
            });
            return scheduledCount;
        },

        /**
         * Start now - the project may already be in memory, which is the case when the user
         * navigates from one route to another without a reload - and re-start on every later
         * project load.
         *
         * Calling it twice is safe: the follow subscription is created once, and start() rebuilds
         * the timers rather than adding to them. stop() unsubscribes as well, so a route that
         * forgets cannot leave a live chain behind.
         */
        startAndFollowHmi(): number {
            const loads = projectService.onLoadHmi ? projectService.onLoadHmi() : null;
            if (!follow && loads) {
                // A project that arrives later (or is replaced by the editor) has to reschedule:
                // the timers are rebuilt from the script list, so a stale interval would keep
                // running the previous version of a script.
                follow = loads.subscribe(() => { scheduled.start(); });
            }
            return scheduled.start();
        },

        /** Stop every timer. Safe to call twice, and safe to call without ever starting. */
        stop(): void {
            intervals.clearIntervals();
            if (follow) {
                follow.unsubscribe();
                follow = null;
            }
        },

        /** How many timers are live - for the route histories and for tests. */
        count(): number {
            return intervals.intervals.length;
        }
    };

    return scheduled;
}
