# Foreground Gateway physical test checklist

Automated builds cannot prove the original sleep failure is fixed. Run these
tests with the release APK on the dedicated phone and a physical G30. Record
phone model, Android version, APK checksum, battery-optimization setting and
timestamps. Complete initial setup once: open the app, grant Nearby Devices and
notification permissions, and note the displayed LAN address.

## A — Screen off (original bug reproduction/fix verification)

1. Start the gateway, connect the physical G30 and open the dashboard from Mac.
2. Confirm that live temperature changes arrive.
3. Turn the Android display off. Do not touch, wake or unlock it again.
4. At 5 minutes, 30 minutes and 2 hours verify all of:
   - HTTP dashboard is reachable and WebSocket is connected or recovered.
   - Live G30 temperature continues updating; target, pump and heater are current.
   - A harmless browser command appropriate to the current brew reaches the G30.
   - Controller confirmation returns to the browser (no optimistic-only change).
   - The phone display remained off and the persistent service notification exists.

Pass only if all three checkpoints pass without waking the phone.

## B — Active session and telemetry with screen off

1. Start a Brew Session and confirm samples are appearing.
2. Turn the display off and leave the phone untouched for at least 30 minutes.
3. From Mac, reopen the session graph/history.
4. Verify the same session ID/start time, approximately five-second sample
   density while valid data was available, no sleep-induced gap, and continued
   event persistence. A real BLE disconnect may create a documented gap; screen
   sleep by itself must not.

## C — Activity gone

1. With gateway, G30 and browser working, leave the Android Activity.
2. Swipe the Activity from Recents if the device supports doing so without
   force-stopping the app. Do not reopen it.
3. Verify HTTP, WebSocket, live BLE state, a confirmed command and telemetry
   still work. Verify there is only one foreground notification/server.

## D — Manual disconnect while screen is off

1. With the display off, press **DISCONNECT G30** from Mac.
2. Verify BLE disconnects while the gateway remains online.
3. Wait at least five minutes and verify there is no automatic reconnect.
4. Press **SCAN & CONNECT** from Mac and verify the G30 reconnects without
   touching Android.

## E — Reboot/start without Activity

1. Reboot Android. Do not manually launch the gateway app.
2. If the device requires first unlock after encrypted boot, unlock it once but
   do not open the app; record that requirement.
3. Wait for boot completion and access `http://<ANDROID-IP>:8080` from Mac.
4. Verify gateway ONLINE and G30 DISCONNECTED/IDLE (no automatic scan).
5. Press **SCAN & CONNECT** and verify the physical G30 connects without the UI.
6. Verify no duplicate active Brew Session was created and no prior physical
   command was replayed.

## F — Service stop/start cleanup

1. Press **STOP GATEWAY** in the Android UI.
2. Verify the HTTP/WebSocket endpoint closes, BLE disconnects, telemetry stops,
   notification disappears and the existing active session remains persisted.
3. Press **START GATEWAY**. Verify one server binds to port 8080, the session is
   restored once, G30 stays idle, and browser **SCAN & CONNECT** works.

## G — Long brew / OEM endurance

Run for 2–4 hours with Android on its charger, screen off, G30 connected, an
active session and occasional browser use. Record every HTTP/WS drop, BLE
disconnect/reconnect, telemetry gap, service restart and whether recovery was
automatic. Repeat once with the app manually excluded from battery optimization.
If only the excluded run passes, make that device-specific setup mandatory.

## Failure evidence

For any failure, capture elapsed time, whether the foreground notification was
present, browser error/state, last telemetry timestamp and Android logs filtered
with `adb logcat -s GatewayService ReactNativeJS` after reproducing (ADB is only
for diagnosis, never a runtime requirement).
