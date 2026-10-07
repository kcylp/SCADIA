import { createScheduledScripts, ScheduledScripts } from './scheduled-scripts';
import { Script, ScriptMode } from '../_models/script';

/**
 * The two routes that schedule a project's CLIENT scripts (/home and /view) used to spell out the
 * "start now if loaded, re-start on every load" pipe twice, and the two spellings drifted - that
 * drift is defect P0-3 (the office clock ran, the big screen was frozen). The pipe now lives in the
 * factory, so these tests pin it in one place, without an Angular TestBed: the factory only needs
 * getScripts() and onLoadHmi, both of which a two-line fake can provide.
 */
class FakeProject {
    scripts: Script[] = null;
    handlers: Array<() => void> = [];
    subscriptions = 0;
    unsubscriptions = 0;

    // A getter, like the real ProjectService use site: the factory must not read it before start.
    onLoadHmi = () => ({
        subscribe: (handler: () => void) => {
            this.subscriptions++;
            this.handlers.push(handler);
            return {
                unsubscribe: () => {
                    this.unsubscriptions++;
                    this.handlers = this.handlers.filter(h => h !== handler);
                }
            };
        }
    });

    getScripts(): Script[] {
        return this.scripts;
    }

    /** Simulate a project arriving (or being replaced by the editor). */
    load(scripts: Script[]): void {
        this.scripts = scripts;
        this.handlers.slice().forEach(handler => handler());
    }
}

function clientScript(id: string, interval: number): Script {
    return <Script>{ id: id, mode: ScriptMode.CLIENT, scheduling: <any>{ interval: interval } };
}

function otherScripts(): Script[] {
    return [
        clientScript('every-second', 1),
        clientScript('every-minute', 60),
        <Script>{ id: 'server-side', mode: ScriptMode.SERVER, scheduling: <any>{ interval: 1 } },
        <Script>{ id: 'not-scheduled', mode: ScriptMode.CLIENT, scheduling: <any>{ interval: 0 } },
        <Script>{ id: 'no-scheduling', mode: ScriptMode.CLIENT }
    ];
}

describe('createScheduledScripts', () => {
    let project: FakeProject;
    let evaluated: Script[];
    let scheduled: ScheduledScripts;

    beforeEach(() => {
        project = new FakeProject();
        evaluated = [];
        scheduled = createScheduledScripts(
            project,
            { evalScript: (script: Script) => evaluated.push(script) }
        );
    });

    afterEach(() => {
        scheduled.stop();
    });

    it('schedules only CLIENT scripts that carry a positive interval', () => {
        project.scripts = otherScripts();
        expect(scheduled.start()).toBe(2);
        expect(scheduled.count()).toBe(2);
    });

    it('says so instead of scheduling when the project has not loaded', () => {
        const messages: string[] = [];
        scheduled = createScheduledScripts(
            project,
            { evalScript: () => { /* not reached */ } },
            (message: string) => messages.push(message)
        );
        expect(scheduled.start()).toBe(0);
        expect(scheduled.count()).toBe(0);
        expect(messages.length).toBe(1);
    });

    it('does not stack timers when start() is called twice', () => {
        project.scripts = otherScripts();
        scheduled.start();
        scheduled.start();
        expect(scheduled.count()).toBe(2);
    });

    // The next two are the P0-3 shape: the project can be in memory already (navigation between
    // routes with no reload) or it can arrive afterwards. Both entries must cover both cases.
    it('startAndFollowHmi starts immediately when the project is already loaded', () => {
        project.scripts = otherScripts();
        expect(scheduled.startAndFollowHmi()).toBe(2);
        expect(scheduled.count()).toBe(2);
    });

    it('startAndFollowHmi schedules a project that arrives later', () => {
        expect(scheduled.startAndFollowHmi()).toBe(0);
        expect(scheduled.count()).toBe(0);

        project.load(otherScripts());
        expect(scheduled.count()).toBe(2);
    });

    it('startAndFollowHmi subscribes once, however many times it is called', () => {
        scheduled.startAndFollowHmi();
        scheduled.startAndFollowHmi();
        expect(project.subscriptions).toBe(1);

        project.load(otherScripts());
        // Rebuilt, not doubled: a script that publishes a tag must not publish it twice as often.
        expect(scheduled.count()).toBe(2);
    });

    it('stop() clears the timers and stops following the project', () => {
        project.scripts = otherScripts();
        scheduled.startAndFollowHmi();
        expect(scheduled.count()).toBe(2);

        scheduled.stop();
        expect(scheduled.count()).toBe(0);
        expect(project.unsubscriptions).toBe(1);

        project.load(otherScripts());
        expect(scheduled.count()).toBe(0);
    });

    it('stop() is safe without ever having started', () => {
        expect(() => scheduled.stop()).not.toThrow();
        expect(scheduled.count()).toBe(0);
    });

    it('works without an onLoadHmi at all', () => {
        const bare = createScheduledScripts(
            { getScripts: () => otherScripts(), onLoadHmi: () => undefined },
            { evalScript: () => { /* nothing to record */ } }
        );
        expect(bare.startAndFollowHmi()).toBe(2);
        bare.stop();
    });
});
