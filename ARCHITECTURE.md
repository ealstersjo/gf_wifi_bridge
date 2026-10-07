# Gateway architecture and lifecycle

## Ownership

The Android foreground service is the lifecycle owner. It starts and retains
the application's shared React Native `ReactHost`; the JavaScript bundle then
starts one process-wide `GatewayRuntime`. The Activity only subscribes to that
runtime for presentation and sends user actions to it.

```text
BOOT_COMPLETED / Activity / explicit START
                    |
                    v
       GatewayForegroundService (Kotlin)
       foreground notification + CPU wake lock
                    |
             shared ReactHost
                    |
                    v
        GatewayRuntime singleton (TypeScript)
          |         |             |
          |         |             +-- BrewSessionManager
          |         |                   +-- 5 s telemetry -> SQLite
          |         +-- GatewayApi -> one native HTTP/WebSocket server :8080
          +-- one GrainfatherConnection
                    +-- one BLE manager
                    +-- canonical G30 state
                    +-- serialized/confirmed command executor

       MainActivity / HomeScreen
                    |
                    +-- subscribe/render/control the same GatewayRuntime
                        (never constructs a gateway or BLE runtime)
```

The native `GatewayModule` owns the NanoHTTPD/NanoWSD socket objects and the
SQLite store because those are Android resources. Semantic API routing,
canonical G30 state, BLE behavior, protocol parsing and command confirmation
remain in TypeScript. There is no Kotlin Grainfather implementation and no
second canonical state store.

## Lifecycle

- `GatewayForegroundService` enters the foreground immediately, then starts
  the shared React host. `START_STICKY` asks Android to recreate it after an
  eligible process kill.
- Bundle startup calls the idempotent `GatewayRuntime.start()`. Repeated service
  or Activity starts cannot construct a second runtime or bind a second server.
- Activity stop/destruction only removes its UI subscription. It does not stop
  the service, HTTP/WebSocket server, BLE connection, session or sampler.
- Explicit **STOP GATEWAY** stops HTTP/WebSocket, performs the existing manual
  BLE disconnect (which cancels scan/reconnect), removes subscriptions/timers,
  releases the wake lock and removes the foreground notification. It does not
  implicitly end a persisted active brew session.
- On cold/process restart, `BrewSessionManager.initialize()` restores the one
  persisted ACTIVE session. The G30 starts disconnected/idle: there is no boot
  scan and no heater, pump, target, timer or delayed-heat command replay.
- A browser WebSocket reconnect obtains a fresh snapshot. While offline the
  dashboard reports the loss and disables commands instead of presenting stale
  controller data as current.

## Android boundary and permissions

The project uses minSdk 24, targetSdk 36 and the `connectedDevice` foreground
service type.

- `FOREGROUND_SERVICE`: permits foreground service operation.
- `FOREGROUND_SERVICE_CONNECTED_DEVICE`: required for the declared service
  type on modern Android.
- `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`: Android 12+ discovery/GATT access.
  Legacy Bluetooth/location declarations remain capped at API 30.
- `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE`: local LAN server,
  address/status discovery and an allowed connected-device FGS prerequisite.
- `POST_NOTIFICATIONS`: lets Android 13+ show the persistent gateway
  notification in the notification drawer. Foreground-service startup is not
  conditional on the user granting it.
- `RECEIVE_BOOT_COMPLETED`: starts the gateway after normal boot completion.
- `WAKE_LOCK`: permits one `PARTIAL_WAKE_LOCK`, held only while the service is
  active and released in `onDestroy`.

No screen wake flag and no `WiFiLock` are used. A partial CPU wake lock is used
because this appliance must execute a JavaScript timer, process BLE callbacks,
serve sockets and persist telemetry at roughly five-second intervals for hours
with the display off. Correct foreground ownership alone does not guarantee
that schedule after the CPU suspends. The lock never illuminates the display.
A Wi-Fi lock was not added because it is device/network-policy dependent and a
high-performance lock would impose unnecessary power cost without physical
evidence that it is needed.

## Boot and recovery boundaries

`GatewayBootReceiver` handles normal `BOOT_COMPLETED` and package replacement.
It deliberately does not use direct-boot/credential-encrypted storage APIs, so
some encrypted devices require the first unlock after reboot before the full
runtime and session database are usable. BLE runtime permissions must also have
been granted during initial app setup. OEM battery managers may still kill even
a foreground service; for the dedicated, charger-connected phone, manually
exclude the app from battery optimization and verify the device-specific
autostart setting.

Recovery is intentionally safe rather than actuator-preserving: the service
and LAN server return, the active session identity is restored, but BLE remains
idle until the user chooses **SCAN & CONNECT**. Fresh controller notifications
then rebuild canonical state and telemetry resumes. Pending physical commands
exist only in memory and are never replayed.
