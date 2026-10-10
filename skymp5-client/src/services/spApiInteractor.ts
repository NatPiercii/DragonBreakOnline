import { EventEmitterFactory } from "./events/events";
import { ClientListener, ClientListenerConstructor, CombinedController } from "./services/clientListener";
import * as sp from "skyrimPlatform";
import { LATE_LABEL, perfDiagEnabled, updateTiming } from "./services/perfDiag";

export class SpApiInteractor {
    static setup(listeners: ClientListener[]) {
        listeners.forEach(listener => SpApiInteractor.registerListenerForLookup(listener.constructor, listener));
        updateTiming.setLabel(LATE_LABEL);
    }

    static getControllerInstance(): CombinedController {
        if (SpApiInteractor.controller) {
            return SpApiInteractor.controller;
        }
        SpApiInteractor.controller = {
            // TODO: handle errors in event handlers. will output to game console by default
            on: perfDiagEnabled(sp.settings["skymp5-client"] as Record<string, unknown>) ? SpApiInteractor.timedOn : sp.on,
            once: sp.once,
            emitter: EventEmitterFactory.makeEventEmitter(),
            lookupListener<T extends ClientListener>(constructor: ClientListenerConstructor<T>): T {
                const listener = SpApiInteractor.listenersForLookupByName.get(constructor);
                if (listener === undefined) {
                    throw new Error(`listener not found for name '${constructor.name}'`);
                }
                if (!(listener instanceof constructor)) {
                    throw new Error(`listener class mismatch for name '${constructor.name}'`);
                }
                return listener;
            },
        }
        return SpApiInteractor.controller;
    }

    // Every update handler goes through one timing wrapper (perfDiag.ts); other events pass straight through
    private static timedOn = ((eventName: string, callback: (...args: any[]) => any) =>
        (sp.on as any)(eventName, eventName === "update" ? updateTiming.wrap(callback) : callback)) as typeof sp.on;

    private static registerListenerForLookup(constructor: Function, listener: ClientListener): void {
        if (SpApiInteractor.listenersForLookupByName.has(constructor)) {
            throw new Error(`listener re-registration for name '${constructor}'`);
        }
        SpApiInteractor.listenersForLookupByName.set(constructor, listener);
    }

    private static listenersForLookupByName = new Map<Function, ClientListener>();

    private static controller?: CombinedController;
}
