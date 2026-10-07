# Grainfather G30 BLE Remote Control

A minimal, native React Native Android application that scans for nearby BLE
devices, connects to a Grainfather G30 Connect controller, subscribes to status
notifications, and provides basic local manual controls. It also exposes the raw
packet bytes needed to verify behavior against a physical controller.

## Included

- Android BLE permission handling for Android 12+ and older supported versions
- Unfiltered nearby-device scanning with name, identifier/address, RSSI, and a
  best-effort "likely G30" marker
- Service and characteristic discovery with GATT UUID/property logging
- Notification monitoring on the verified G30 status characteristic
- Raw timestamped Base64-decoded bytes as hex, decimal, and ASCII
- Verified parsing of temperature (`X`), heater/pump/process state (`Y`), and
  heater-output/manual-power state (`W`)
- Verified 19-byte ASCII commands for target temperature, heater ON/OFF, and
  pump ON/OFF, sent to the G30 write characteristic without response
- Single-flight command handling with a six-second timeout and confirmation
  from subsequent controller notifications rather than optimistic UI updates
- Controller-native timer and delayed heating: start/arm, pause, resume, cancel,
  remaining time, total duration, and controller-reported state
- An 8-second stale-data warning and explicit disconnected labeling
- Three delayed reconnect attempts after an unexpected disconnect; manual
  disconnect disables reconnect
- Embedded LAN HTTP and WebSocket gateway on port 8080
- Same-origin responsive dashboard bundled inside the standalone Android APK
- Remote finite scan/connect, explicit disconnect, and all existing verified
  Grainfather controls through a semantic `/api/v1` API
- Pure TypeScript protocol tests

Not included: heater-power writes, authentication, HTTPS, mDNS,
Internet/cloud access, recipe automation, or push notifications.

## Local Wi-Fi gateway

The Android application is both the BLE client and a small local server:

```text
browser -- same-origin HTTP/WebSocket --> Android gateway
                                             |
                                             +-- existing GrainfatherConnection
                                                     |
                                                     +-- BLE --> G30
```

The native server uses NanoHTTPD/NanoWSD 2.3.1. It is small, embeddable, works
without a separate process, and supports both HTTP and WebSocket in one Android
dependency. Kotlin owns only the network sockets, static-file serving, and the
React Native event bridge. API routing calls the same `GrainfatherConnection`
instance used by the Android UI, so UUIDs, packet framing, command construction,
serialization, validation, confirmation, and reconnect behavior remain in the
existing BLE/domain implementation.

The server binds to `0.0.0.0:8080`, while the Android Gateway card displays the
current useful non-loopback IPv4 address and browser URL. Open
`http://<ANDROID-IP>:8080` from a device on the same LAN. The health endpoint is
available even when the G30 is disconnected. WebSocket clients receive one
snapshot immediately and subsequent changed snapshots. Normal use is
same-origin and the server does not send a permissive CORS header.

WebSocket transport liveness is independent of G30 connection and telemetry
freshness. The server sends an RFC 6455 ping every 10 seconds; browsers answer
with pong frames automatically, and a 30-second socket read watchdog detects a
genuinely unavailable peer. A closed browser connection retries with bounded
2/4/8/10-second backoff and receives the current snapshot when it reopens.
Disconnected or stale G30 state never closes the WebSocket.

**LAN security warning: DO NOT expose port 8080 directly to the public
Internet.** This MVP has no authentication or TLS. It does not configure UPnP,
router forwarding, NAT traversal, or a cloud relay. A future remote-access
layer must be separately authenticated and use HTTPS.

### API

All request and response bodies are JSON. Commands wait for the existing
controller-notification confirmation path and return `{"status":"confirmed"}`
only after the G30 reports the change. They do not optimistically mutate state.
Errors use an HTTP status plus a stable `error` key such as
`grainfather_disconnected`, `command_pending`, `grainfather_not_found`,
`command_timeout`, `invalid_target_temperature`, or `invalid_request`.

```text
GET  /api/v1/health
GET  /api/v1/state
WS   /api/v1/ws

POST /api/v1/grainfather/connect
POST /api/v1/grainfather/disconnect
POST /api/v1/target                 {"temperatureC":65.5}
POST /api/v1/heater                 {"enabled":true}
POST /api/v1/pump                   {"enabled":true}
POST /api/v1/timer/start            {"durationSeconds":120}
POST /api/v1/timer/pause
POST /api/v1/timer/resume
POST /api/v1/timer/cancel
POST /api/v1/delayed-heat/start     {"durationSeconds":300}
POST /api/v1/delayed-heat/pause
POST /api/v1/delayed-heat/resume
POST /api/v1/delayed-heat/cancel
```

There is intentionally no arbitrary BLE-write endpoint. There is also no
heater-power write endpoint because the existing verified implementation makes
heater power read-only.

Example `GET /api/v1/state` response (values vary):

```json
{
  "gateway": {
    "status": "online",
    "version": "0.1.0",
    "port": 8080,
    "localIp": "192.168.1.87",
    "webSocketClients": 1
  },
  "grainfather": {
    "connectionState": "CONNECTED",
    "connectionDetail": "Grainfather G30",
    "stale": false,
    "actualTemperatureC": 64.7,
    "targetTemperatureC": 65,
    "heater": {
      "enabled": true,
      "powerPercent": 100,
      "manualPowerMode": false
    },
    "pump": {"enabled": false},
    "process": {
      "autoMode": false,
      "stageRamp": null,
      "interactionMode": null,
      "interactionCode": null,
      "stageNumber": null
    },
    "timer": {
      "state": "RUNNING",
      "active": true,
      "paused": false,
      "durationSeconds": 3600,
      "remainingSeconds": 1800,
      "elapsedSeconds": 1800,
      "lastUpdate": "2026-09-16T08:00:00.000Z"
    },
    "delayedHeat": {
      "state": "INACTIVE",
      "active": false,
      "remainingSeconds": null,
      "targetTemperatureC": 65
    },
    "command": {"state": "IDLE"},
    "rssi": -52,
    "lastUpdate": "2026-09-16T08:00:00.000Z"
  }
}
```

### Connection policy

Nothing scans while idle. A web connect request starts a finite 25-second scan,
reports `SCANNING`, connects the first device identified by the existing likely
Grainfather rules, reports `CONNECTING`, then `CONNECTED`. If none is found it
stops scanning and reports `NOT_FOUND`. An established unexpected disconnect
retains the existing three delayed reconnect attempts. An explicit Android or
web disconnect first suppresses reconnect and cancels any requested scan, then
disconnects and returns to `DISCONNECTED`; the Wi-Fi server stays online.

### Bundled dashboard and build pipeline

The dependency-free dashboard lives in `web/`. Gradle's
`syncGatewayWebAssets` task copies it to generated Android assets before every
build. The Kotlin server serves only the whitelisted `index.html`, `app.js`, and
`styles.css` files from the APK. The browser uses same-origin `fetch` and
`/api/v1/ws`, so no Node.js, npm, Vite, CDN, Metro, Mac, USB, ADB, or Internet
connection is needed at runtime.

The long-lived runtime is owned by `GatewayForegroundService`, not the React
Native Activity. It keeps the shared React host and one process-wide TypeScript
runtime alive, including the existing `GrainfatherConnection`, native LAN
server, session manager and telemetry sampler. Leaving or destroying the UI
only detaches its presentation subscription. The service starts after normal
boot, but never scans or replays physical commands automatically. See
`ARCHITECTURE.md` for ownership, permissions, wake-lock reasoning and recovery
boundaries, and `FOREGROUND_GATEWAY_TEST_CHECKLIST.md` for required device tests.

## Brew sessions, telemetry, and history

Brew-session recording is an observer above the canonical Grainfather state;
it does not parse BLE, regulate temperature, or issue automatic commands. The
Android native module owns an offline SQLite database named
`brew_sessions.db`. Its normalized, migration-friendly schema contains:

- `brew_sessions`: ID, optional name, start/end timestamps, and
  `ACTIVE`/`COMPLETED` status. A partial unique index permits one active session.
- `telemetry_samples`: session ID, timestamp, actual/target temperature,
  heater state/output, pump state, and RSSI. Indexed by session and timestamp.
- `brew_events`: session ID, timestamp, typed event, source, and a small typed
  payload serialized as JSON. Indexed by session and timestamp.

The event payload is deliberately limited to event-specific details; sessions
and time-series samples are not stored as giant JSON documents. This leaves a
clean boundary for future `Recipe`, `RecipeStep`, `BrewExecution`, and
`BrewStepExecution` tables without implementing a recipe engine today.

While a session is active, one telemetry sample is written every five seconds
only when the G30 is connected, has a verified actual temperature, and passes
the existing eight-second freshness rule. A disconnect leaves the session
active, records a connection event, stops sampling, and resumes sampling after
fresh state returns. Ending a session only ends recording; it never changes the
G30, heater, pump, timer, or BLE connection.

Events have typed sources: confirmed matching gateway commands are `WEB`,
unmatched verified controller transitions are `G30`, and connection/session/
target-reached lifecycle events are `SYSTEM`. Failed commands clear their
pending attribution. Ambiguous behavior is not promoted to `WEB`.

`TARGET_REACHED` arms again only after a target changes by at least 0.5 °C. The
actual temperature must remain within 0.2 °C below the target (or above it) for
five seconds before the event is emitted once. This prevents ordinary ±0.1 °C
controller noise from creating repeated events.

Heating rate is an ordinary least-squares linear regression over the latest
three minutes of persisted samples, using their real timestamps. At least six
samples spanning 30 seconds are required, and trends smaller than 0.05 °C/min
are treated as flat. ETA is shown only with fresh connected data, heater on, a
rate of at least +0.1 °C/min, more than 0.2 °C remaining, and a result no longer
than six hours. It is an estimate, not a G30 prediction.

The dashboard graph is a dependency-free local SVG with 15-minute, one-hour,
and full-session ranges. Historical data loads once over HTTP; each new sample
and event is appended from the compact WebSocket snapshot rather than
rebroadcasting full history every five seconds. Completed sessions are
read-only and remain available in Brew history.

Additional endpoints:

```text
POST /api/v1/sessions                         {"name":"Saturday Pilsner"}
GET  /api/v1/sessions
GET  /api/v1/sessions/:id
POST /api/v1/sessions/:id/end
GET  /api/v1/sessions/:id/telemetry?since=<ISO>&limit=20000
GET  /api/v1/sessions/:id/events?limit=1000
```

If React Native restarts and SQLite contains an active session, that same
session is restored and sampling resumes once fresh G30 data is observed. The
current app still is not a foreground service: Android may stop all collection
when it kills or suspends the process. Durable ownership, process recovery, and
safe BLE/server reattachment belong in the next foreground-service phase.

## Protocol evidence

The primary reference is
[`clausbroch/node-red-gfconnect`](https://github.com/clausbroch/node-red-gfconnect),
specifically its `flow.json`:

- Scanner service: `0000cdd0-0000-1000-8000-00805f9b34fb`
- Read/notification characteristic:
  `0003cdd1-0000-1000-8000-00805f9b0131`
- Write characteristic:
  `0003cdd2-0000-1000-8000-00805f9b0131`

The flow's **Slice message stream** node establishes that BLE input is an ASCII
stream buffered into 17-character records, with overflow retained when a
notification is fragmented or contains more data. Its **Decode response** node
extracts a one-character message type and comma-separated parameters. Its
**Decode Temperature (X)** node establishes that an `X` message has target
temperature at parameter 0 and current temperature at parameter 1. Values are
treated as Celsius before the upstream dashboard optionally converts them for a
Fahrenheit display; no binary scaling formula is applied. The same decoder caps
the controller's documented 120 °C boil-target sentinel at 100 °C.

Conceptual packet:

```text
ZX65.0,16.4,ZZZZZ
 │    │
 │    └─ current temperature: 16.4 °C
 └────── target temperature: 65.0 °C
```

The leading `Z` is stream padding observed on the physical G30. The parser
resynchronizes to the logical `X` record using the same padding rules as the
upstream flow.

The node-red project credits the now-unavailable
`kingpulsar/Grainfather-Bluetooth-Protocol` repository as its reverse-engineering
source. A preserved integration quoting that repository independently lists the
same service, read, and write UUIDs. The service UUID really ends in `b34fb`,
while the two characteristic UUIDs end in `b0131`.

The preserved
[`clausbroch/Grainfather-Bluetooth-Protocol`](https://github.com/clausbroch/Grainfather-Bluetooth-Protocol)
fork independently documents the exact commands used here. Commands are UTF-8/
ASCII text padded with spaces to exactly 19 bytes and written without response:

```text
K1 / K0       heater on / off
L1 / L0       pump on / off
$65.5,        set target temperature to 65.5 °C
```

`Y` parameter 0 is heater enabled and parameter 1 is pump state. Additional `Y`
parameters expose automatic mode, ramp/interaction state, stage number, and
delayed heat. `W` parameter 0 is heater output percentage and parameter 4 is
manual-power mode. Heater enabled is deliberately displayed separately from
heater output: an enabled controller can regulate the element below 100%.
Target commands are confirmed by a later `X` parameter 0 match; heat and pump
commands are confirmed by later `Y` parameter 0 and 1 matches respectively.
The write-without-response completion itself never changes displayed G30 state.

The app does not expose an absolute heater-power command. The source verifies
`f1`/`f0` manual-power mode and context-dependent `U`/`D` adjustments, but not a
direct `setHeaterPower(value)` payload. Sending those controls without a fully
modelled mode transition would be unsafe.

Target entry is limited to a conservative 0–100 °C application envelope. The
protocol source accepts a numeric direct target and the official G30 manual
establishes 100 °C as the controller's boil target; the app never sends the
internal 120 °C boil sentinel reported by status packets.

### Timer and delayed-heat protocol

Timer and delayed heat use the same controller-native countdown engine. The
primary `node-red-gfconnect` flow and the preserved protocol implementation
establish these exact commands:

```text
W{total minutes},60,   set and immediately start a timer
B{total minutes},60,   arm delayed heat for a duration-until-start
G                      toggle pause/resume
C                      cancel the active timer or delayed-heat countdown
```

As with every other command, each string is ASCII/UTF-8 and space-padded to
exactly 19 bytes before being written without response to
`0003cdd2-0000-1000-8000-00805f9b0131`. The development UI accepts whole-minute
durations from 1 minute through 48 hours 59 minutes. That upper limit comes from
the upstream flow's 0–48 hour and 0–59 minute inputs.

There is no separate configure-then-start operation in the verified upstream
flow: `W` sets and starts the timer, while `B` sets and arms delayed heat. There
are also no separate pause and resume payloads; both use the `G` toggle. The app
only sends `G` after a controller notification has established the current
paused state, then waits for the opposite reported state.

Controller feedback arrives on the existing notification characteristic:

```text
T{active},{minutes left bucket},{total start minutes},{seconds left}
W{heater output},{timer paused},...
Y{heater},{pump},...,{delayed heat mode}
```

The upstream `Decode Timer (T)` node normalizes remaining time as
`max(0, (minutesLeft - 1) * 60 + secondsLeft)`. Total duration is
`totalStartMinutes * 60`. `W` parameter 1 supplies the pause flag, and `Y`
parameter 7 distinguishes a delayed-heat countdown from an ordinary timer.
Elapsed time shown by the app is derived as total minus remaining; it is not an
additional controller field.

`RUNNING`, `PAUSED`, `FINISHED`, and `IDLE` are derived only from those reported
fields. Delayed heat is displayed as `ARMED`, `PAUSED`, `STARTED`, or `INACTIVE`.
The app does not run, advance, or recreate a countdown locally.

The delayed-heat command contains no temperature parameter, and its status has
no dedicated delayed target. The UI therefore displays the current controller
target from `X` as the target that remains configured when `B` is sent. It does
not claim that a separate delayed target was reported.

Confirmations are notification-based:

- timer start: matching active `T` with the requested total duration;
- delayed-heat arm: `Y` reports delayed heat enabled;
- pause/resume: `W` reports the requested paused state;
- timer cancel: `T` reports inactive;
- delayed-heat cancel: `Y` reports delayed heat disabled.

No timer command is retried or replayed after reconnect. Timer fields are reset
to unknown while reconnecting and reconstructed solely from fresh `T`, `W`, and
`Y` notifications.

## Prerequisites

- macOS, Linux, or Windows configured for React Native Android development
- Node.js 22.11 or newer (required by this React Native version)
- JDK 17
- Android Studio and Android SDK Platform 37
- An Android phone with BLE, USB debugging enabled, and a USB data connection
- A powered Grainfather G30 Connect controller not already connected to another
  phone or bridge

See the official
[React Native environment setup](https://reactnative.dev/docs/set-up-your-environment)
for Android SDK and device configuration.

## Install and validate

```bash
npm install
npm test -- --runInBand
npm run lint
npx tsc --noEmit
cd android && ./gradlew assembleDebug
cd android && ./gradlew assembleRelease
```

APK outputs:

```text
android/app/build/outputs/apk/debug/app-debug.apk
android/app/build/outputs/apk/release/app-release.apk
```

The release APK embeds the JavaScript bundle and runs standalone without Metro,
USB, ADB, or the development computer. It currently uses the template debug
signing key for direct field-test installation; replace that key before any
production distribution.

## Run on a physical phone

For standalone garage testing, install
`android/app/build/outputs/apk/release/app-release.apk` on the phone. With the
phone temporarily attached, this can be done with:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

After installation, the phone can be disconnected and the app does not need
Metro. For development with live reload instead:

1. Connect the phone and confirm it appears in `adb devices`.
2. From the project root, start Metro with `npm start`.
3. In a second terminal, run `npm run android`.
4. When prompted after tapping **Scan**, grant Nearby devices on Android 12+.
   On Android 11 and older, grant location access and make sure system Location
   is enabled, as Android requires it for BLE scanning on those releases.
5. Power on the G30, tap **Scan**, and select the device marked **LIKELY G30**.
   If its advertised name is unusual, use the address and RSSI to identify it;
   the app does not require a fixed advertised name.
6. Compare **Actual**, **Target**, heater, and pump state with the controller.
   A valid fresh `X` packet removes the **STALE DATA** warning.
7. Follow [PHYSICAL_TEST_CHECKLIST.md](PHYSICAL_TEST_CHECKLIST.md) before using
   the heat control.

Only one central can normally hold the controller connection, so disconnect the
official Grainfather app or GCAST while testing.

## Permissions

The manifest requests only the BLE permissions needed for the supported Android
version:

- Android 12/API 31+: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`
- Android 11/API 30 and earlier: `BLUETOOTH`, `BLUETOOTH_ADMIN`, and runtime
  `ACCESS_FINE_LOCATION`

`INTERNET` permits the embedded server's LAN sockets (and Metro in development),
and `ACCESS_NETWORK_STATE` is used to display the current LAN IPv4 address.

## Debugging

Expand **Raw BLE debug** in the app to see the latest 100 events. Every relevant
notification includes its ISO timestamp, characteristic UUID, hexadecimal bytes,
decimal bytes, ASCII form, and decoded temperature when valid. The same entries
are written to the React Native console with `[BLE]`, `[G30]`, `[PROTOCOL]`,
`[STATE]`, `[COMMAND]`, and `[RECONNECT]` prefixes and can be viewed in Metro or
with:

```bash
adb logcat '*:S' ReactNativeJS:V
```

Gateway activity is added to the same in-app debug list with `[GATEWAY]`,
`[HTTP]`, and `[WS]` categories. WebSocket open, close, error, and throttled
ping/pong events use `[WS-SERVER]`; the browser logs matching `[WS-CLIENT]`
events and reconnect attempts. Changed snapshots are broadcast once; unchanged
one-second freshness checks do not flood the WebSocket or logs.

On every connection, all discovered services and characteristics and their read,
notify, indicate, and write properties are logged. A write occurs only after a
user presses a control button. Command payload, write completion, confirmation,
timeout, and failure are logged separately; write completion is not reported as
controller success.

## Safety / Current limitations

- This application is a remote control. Attend the G30 whenever commands are
  enabled and follow the physical safety checklist.
- It is **not** responsible for temperature regulation.
- The Grainfather controller remains responsible for all process control.
- There is no app-side `actual < target` control loop.
- Commands are never retried or replayed after reconnect.
- Timer and delayed heating run entirely in the G30 controller; there are no
  JavaScript timers, Android alarms, or app-owned schedules.
- Heater-power percentage is read-only because an absolute setter was not
  confidently established from the upstream protocol.
- A physical G30 is required for final on-device confirmation that the displayed
  temperature matches its display; automated tests only validate the verified
  parser behavior.
- The protocol layer buffers fragmented input and handles multiple complete
  17-character records in one notification, following the upstream stream
  slicer. Raw capture remains visible for unrecognized or incomplete records.

## Project structure

```text
src/
  ble/
    BleService.ts                 generic BLE operations and permissions
    GrainfatherConnection.ts     G30 discovery, subscription, logs, reconnect
    SerializedCommandExecutor.ts single-flight confirmation and timeout
    __tests__/
      SerializedCommandExecutor.test.ts
  protocol/
    GrainfatherProtocol.ts       pure verified ASCII parser
    GrainfatherState.ts          decoded state model
    __tests__/
      GrainfatherProtocol.test.ts
  gateway/
    GatewayApi.ts                 semantic API routing and state serialization
    GatewayNative.ts              React Native/native-server bridge
    __tests__/
      GatewayApi.test.ts
  session/
    BrewSession.ts               persistent domain types and trend/ETA math
    BrewSessionManager.ts        sampling, lifecycle, events, attribution
    __tests__/
      BrewSessionManager.test.ts
  screens/
    HomeScreen.tsx
web/
  index.html                      locally served responsive dashboard
  app.js                          same-origin HTTP/WebSocket client
  ws-client.js                    transport liveness and reconnect lifecycle
  styles.css
android/app/src/main/java/com/wifibridge/
  GatewayModule.kt                React Native gateway module and LAN address
  GatewayServer.kt                embedded HTTP/WebSocket/static server
  WebSocketHeartbeatPolicy.kt     ping/read-watchdog policy
  GatewayPackage.kt
  BrewSessionStore.kt            structured SQLite schema and queries
```

See [PHYSICAL_TEST_CHECKLIST.md](PHYSICAL_TEST_CHECKLIST.md) for conservative
BLE/control validation and
[WIFI_GATEWAY_TEST_CHECKLIST.md](WIFI_GATEWAY_TEST_CHECKLIST.md) for the first
end-to-end Mac → Wi-Fi → Android → BLE → G30 test, and
[BREW_SESSION_TEST_CHECKLIST.md](BREW_SESSION_TEST_CHECKLIST.md) for session,
graph, trend, event, disconnect, recovery, and history validation.
