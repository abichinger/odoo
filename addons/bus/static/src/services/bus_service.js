import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";
import { Deferred } from "@web/core/utils/concurrency";
import { registry } from "@web/core/registry";
import { session } from "@web/session";
import { isIosApp } from "@web/core/browser/feature_detection";
import { EventBus } from "@odoo/owl";
import { user } from "@web/core/user";

// List of worker events that should not be broadcasted.
const INTERNAL_EVENTS = new Set(["initialized", "outdated", "notification"]);

/**
 * Enum representing the websocket states
 * For simplicity the state values match {@link WebSocket.readyState}
 * WebSocket.CLOSING is ignored because the worker does not trigger a related event for it.
 */
const busStates = Object.freeze({
    CONNECTING: WebSocket.CONNECTING,
    CONNECTED: WebSocket.OPEN,
    DISCONNECTED: WebSocket.CLOSED,
});
/**
 * Possible state values of the WebSocket connection. It can have the values of {@link busStates}, 
 * @typedef {busStates[keyof busStates]} BusState 
 */

/**
 * Communicate with a SharedWorker in order to provide a single websocket
 * connection shared across multiple tabs.
 *
 *  @emits connect
 *  @emits disconnect
 *  @emits reconnect
 *  @emits reconnecting
 *  @emits statechange
 */
export const busService = {
    dependencies: ["bus.parameters", "localization", "multi_tab", "notification"],

    start(env, { multi_tab: multiTab, notification, "bus.parameters": params }) {
        const bus = new EventBus();
        const notificationBus = new EventBus();
        const subscribeFnToWrapper = new Map();
        let worker;
        let isActive = false;
        let isInitialized = false;
        let isUsingSharedWorker = browser.SharedWorker && !isIosApp();
        const startedAt = luxon.DateTime.now().set({ milliseconds: 0 });
        const connectionInitializedDeferred = new Deferred();
        let state;

        /**
         * Send a message to the worker.
         *
         * @param {WorkerAction} action Action to be
         * executed by the worker.
         * @param {Object|undefined} data Data required for the action to be
         * executed.
         */
        function send(action, data) {
            if (!worker) {
                return;
            }
            const message = { action, data };
            if (isUsingSharedWorker) {
                worker.port.postMessage(message);
            } else {
                worker.postMessage(message);
            }
        }

        /**
         * Handle messages received from the shared worker and fires an
         * event according to the message type.
         *
         * @param {MessageEvent} messageEv
         * @param {{type: WorkerEvent, data: any}[]}  messageEv.data
         */
        function handleMessage(messageEv) {
            const { type, data } = messageEv.data;
            switch (type) {
                case "notification": {
                    const notifications = data.map(({ id, message }) => ({ id, ...message }));
                    multiTab.setSharedValue("last_notification_id", notifications.at(-1).id);
                    for (const { id, type, payload } of notifications) {
                        notificationBus.trigger(type, { id, payload });
                        busService._onMessage(id, type, payload);
                    }
                    break;
                }
                case "initialized": {
                    isInitialized = true;
                    connectionInitializedDeferred.resolve();
                    // initialize state by requesting WebSocket.readyState from worker
                    send("readyState");
                    break;
                }
                case "outdated": {
                    multiTab.unregister();
                    notification.add(
                        _t(
                            "Save your work and refresh to get the latest updates and avoid potential issues."
                        ),
                        {
                            title: _t("The page is out of date"),
                            type: "warning",
                            sticky: true,
                            buttons: [
                                {
                                    name: _t("Refresh"),
                                    primary: true,
                                    onClick: () => {
                                        browser.location.reload();
                                    },
                                },
                            ],
                        }
                    );
                    break;
                }
            }
            if (!INTERNAL_EVENTS.has(type)) {
                bus.trigger(type, data);
            }
        }

        /**
         * Initialize the connection to the worker by sending it usefull
         * initial informations (last notification id, debug mode,
         * ...).
         */
        function initializeWorkerConnection() {
            // User_id has different values according to its origin:
            //     - user service : number or false (key: userId)
            //     - guest page: array containing null or number
            //     - public pages: undefined
            // Let's format it in order to ease its usage:
            //     - number if user is logged, false otherwise, keep
            //       undefined to indicate session_info is not available.
            let uid = Array.isArray(session.user_id) ? session.user_id[0] : user.userId;
            if (!uid && uid !== undefined) {
                uid = false;
            }
            send("initialize_connection", {
                websocketURL: `${params.serverURL.replace("http", "ws")}/websocket?version=${
                    session.websocket_worker_version
                }`,
                db: session.db,
                debug: odoo.debug,
                lastNotificationId: multiTab.getSharedValue("last_notification_id", 0),
                uid,
                startTs: startedAt.valueOf(),
            });
        }

        /**
         * Start the "bus_service" worker.
         */
        function startWorker() {
            let workerURL = `${params.serverURL}/bus/websocket_worker_bundle?v=${session.websocket_worker_version}`;
            if (params.serverURL !== window.origin) {
                // Bus service is loaded from a different origin than the bundle
                // URL. The Worker expects an URL from this origin, give it a base64
                // URL that will then load the bundle via "importScripts" which
                // allows cross origin.
                const source = `importScripts("${workerURL}");`;
                workerURL = "data:application/javascript;base64," + window.btoa(source);
            }
            const workerClass = isUsingSharedWorker ? browser.SharedWorker : browser.Worker;
            worker = new workerClass(workerURL, {
                name: isUsingSharedWorker
                    ? "odoo:websocket_shared_worker"
                    : "odoo:websocket_worker",
            });
            worker.addEventListener("error", (e) => {
                if (!isInitialized && workerClass === browser.SharedWorker) {
                    console.warn(
                        'Error while loading "bus_service" SharedWorker, fallback on Worker.'
                    );
                    isUsingSharedWorker = false;
                    startWorker();
                } else if (!isInitialized) {
                    isInitialized = true;
                    connectionInitializedDeferred.resolve();
                    console.warn("Bus service failed to initialized.");
                }
            });
            if (isUsingSharedWorker) {
                worker.port.start();
                worker.port.addEventListener("message", handleMessage);
            } else {
                worker.addEventListener("message", handleMessage);
            }
            initializeWorkerConnection();
        }
        browser.addEventListener("pagehide", ({ persisted }) => {
            if (!persisted) {
                // Page is gonna be unloaded, disconnect this client
                // from the worker.
                send("leave");
            }
        });
        browser.addEventListener("online", () => {
            if (isActive) {
                send("start");
            }
        });
        browser.addEventListener("offline", () => send("stop"));

        /**
         * Updates the state variable and
         * triggers a "statechange" event on the bus
         * 
         * @emits statechange
         * @param {BusState} newState 
         */
        function updateState(newState) {
            state = newState;
            bus.trigger("statechange", newState);
        }
        bus.addEventListener("connect", updateState.bind(null, busStates.CONNECTED));
        bus.addEventListener("reconnect", updateState.bind(null, busStates.CONNECTED));
        bus.addEventListener("reconnecting", updateState.bind(null, busStates.CONNECTING));
        bus.addEventListener("disconnect", updateState.bind(null, busStates.DISCONNECTED));
        
        bus.addEventListener("readyState", ({ detail: readyState}) => {
            if (readyState == WebSocket.CLOSING) {
                return; // state should settle soon
            }
            updateState(readyState);
        });

        return {
            addEventListener: bus.addEventListener.bind(bus),
            addChannel: async (channel) => {
                if (!worker) {
                    startWorker();
                    await connectionInitializedDeferred;
                }
                send("add_channel", channel);
                send("start");
                isActive = true;
            },
            deleteChannel: (channel) => send("delete_channel", channel),
            forceUpdateChannels: () => send("force_update_channels"),
            trigger: bus.trigger.bind(bus),
            removeEventListener: bus.removeEventListener.bind(bus),
            send: (eventName, data) => send("send", { event_name: eventName, data }),
            start: async () => {
                if (!worker) {
                    startWorker();
                    await connectionInitializedDeferred;
                }
                send("start");
                isActive = true;
            },
            stop: () => {
                send("leave");
                isActive = false;
            },
            get isActive() {
                return isActive;
            },
            /**
             * Subscribe to a single notification type.
             *
             * @param {string} notificationType
             * @param {function} callback
             */
            subscribe(notificationType, callback) {
                const wrapper = ({ detail }) => {
                    const { id, payload } = detail;
                    callback(payload, { id });
                };
                subscribeFnToWrapper.set(callback, wrapper);
                notificationBus.addEventListener(notificationType, wrapper);
            },
            /**
             * Unsubscribe from a single notification type.
             *
             * @param {string} notificationType
             * @param {function} callback
             */
            unsubscribe(notificationType, callback) {
                notificationBus.removeEventListener(
                    notificationType,
                    subscribeFnToWrapper.get(callback)
                );
                subscribeFnToWrapper.delete(callback);
            },
            startedAt,
            
            /**
             * The connection state of the worker's websocket
             * It can have the values described in {@link BusState} 
             * @readonly
             * @returns {BusState | undefined}
             */
            get state() {
                return state;
            },
            ...busStates,
            
        };
    },
    /** Overriden to provide logs in tests. Use subscribe() in production. */
    _onMessage(id, type, payload) {},
};
registry.category("services").add("bus_service", busService);
