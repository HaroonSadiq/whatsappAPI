import { EventEmitter } from 'events';

/** Singleton bus — orchestrator emits, ws/handler relays to sockets */
export const appEvents = new EventEmitter();
appEvents.setMaxListeners(30);
