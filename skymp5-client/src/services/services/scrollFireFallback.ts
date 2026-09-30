// Pairs the platform's scroll casts with SKSE's actionSpellFire so each scroll cast is relayed once (magicSyncService)
// No imports, so tests/scrollfire-harness.js runs it in node

// FormType.ScrollItem (skyrim-platform typings)
export const SCROLL_FORM_TYPE = 23;

// A platform cast seen just before its fire still pairs with it
export const SCROLL_PAIR_MS = 250;
// A fire whose scroll is still held waits this long for the platform's cast or for the scroll to be used up
export const SCROLL_WAIT_MS = 500;
// After a fallback relay the scroll is gone, so further fires and one late platform cast of it are the same cast
export const SCROLL_SUPPRESS_MS = 1000;

export type ScrollFireDecision = "relay" | "wait" | "ignore";

interface ScrollCastState<T> {
    pending?: { since: number, fire: T };
    platformAt?: number;
    fallbackAt?: number;
    platformSuppressed?: boolean;
}

export class ScrollFireTracker<T> {
    constructor(private readonly now: () => number = () => Date.now()) { }

    // The platform reported a scroll cast; false means the fallback already relayed it
    onPlatformCast(casterLocalId: number, scrollId: number): boolean {
        const now = this.now();
        this.prune(now);
        const key = this.key(casterLocalId, scrollId);
        const state = this.states.get(key) ?? {};
        this.states.set(key, state);
        if (state.fallbackAt !== undefined && !state.platformSuppressed) {
            state.platformSuppressed = true;
            return false;
        }
        if (state.pending) {
            state.pending = undefined;
            this.dropIfIdle(key, state);
            return true;
        }
        state.platformAt = now;
        return true;
    }

    // actionSpellFire for a scroll; "relay" means send it now, "wait" keeps it until the scroll is used up
    onFire(casterLocalId: number, scrollId: number, scrollGone: boolean, fire: T): ScrollFireDecision {
        const now = this.now();
        this.prune(now);
        const key = this.key(casterLocalId, scrollId);
        const state = this.states.get(key) ?? {};
        this.states.set(key, state);
        if (state.fallbackAt !== undefined) {
            return "ignore";
        }
        if (state.platformAt !== undefined) {
            state.platformAt = undefined;
            this.dropIfIdle(key, state);
            return "ignore";
        }
        if (scrollGone) {
            this.markRelayed(state, now);
            return "relay";
        }
        state.pending = { since: now, fire };
        return "wait";
    }

    // Waiting fires whose scroll is used up now, each returned once
    takeDue(isScrollGone: (casterLocalId: number, scrollId: number) => boolean): T[] {
        const now = this.now();
        this.prune(now);
        const due: T[] = [];
        this.states.forEach((state, key) => {
            if (!state.pending) {
                return;
            }
            const [casterLocalId, scrollId] = key.split(":").map(Number);
            if (isScrollGone(casterLocalId, scrollId)) {
                due.push(state.pending.fire);
                this.markRelayed(state, now);
            }
        });
        return due;
    }

    size(): number {
        return this.states.size;
    }

    private markRelayed(state: ScrollCastState<T>, now: number) {
        state.pending = undefined;
        state.platformAt = undefined;
        state.fallbackAt = now;
        state.platformSuppressed = false;
    }

    private prune(now: number) {
        this.states.forEach((state, key) => {
            if (state.pending && now - state.pending.since > SCROLL_WAIT_MS) {
                state.pending = undefined;
            }
            if (state.platformAt !== undefined && now - state.platformAt > SCROLL_PAIR_MS) {
                state.platformAt = undefined;
            }
            if (state.fallbackAt !== undefined && now - state.fallbackAt > SCROLL_SUPPRESS_MS) {
                state.fallbackAt = undefined;
                state.platformSuppressed = undefined;
            }
            this.dropIfIdle(key, state);
        });
    }

    private dropIfIdle(key: string, state: ScrollCastState<T>) {
        if (!state.pending && state.platformAt === undefined && state.fallbackAt === undefined) {
            this.states.delete(key);
        }
    }

    private key(casterLocalId: number, scrollId: number): string {
        return `${casterLocalId >>> 0}:${scrollId >>> 0}`;
    }

    private readonly states = new Map<string, ScrollCastState<T>>();
}
