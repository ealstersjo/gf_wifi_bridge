# Wi-Fi Gateway Physical Test Checklist

This checklist is the first physical proof of the complete path:

```text
Mac browser → local Wi-Fi → Android gateway → BLE → Grainfather G30
```

The build is automated-tested, but LAN control is not considered physically
verified until this checklist is completed with a separate browser device and
the real G30.

## Safety and setup

- [ ] Put the G30 in a safe test condition and follow its operating manual.
- [ ] Only test the heater when the vessel contains an appropriate amount of
      liquid and heating is physically safe.
- [ ] Keep a person at the G30 throughout remote-control testing.
- [ ] Install `android/app/build/outputs/apk/release/app-release.apk` on the
      Android phone.
- [ ] Place the Android phone next to the G30 in the garage/brewery.
- [ ] Connect the Android phone and Mac to the same trusted Wi-Fi LAN.
- [ ] Disconnect the official Grainfather app/GCAST so it does not own BLE.
- [ ] Open the Android app and grant its requested BLE permissions.
- [ ] Confirm the Android Gateway card says `RUNNING`, port `8080`, and shows a
      non-loopback local IPv4 address.
- [ ] Disconnect USB. Stop Metro and ADB. Leave no development computer service
      running. The test must use only the installed APK and LAN.
- [ ] Do not expose or forward TCP port 8080 to the public Internet.

Record Android URL: `http://________________:8080`

## Test 1 — Gateway

- [ ] Open the recorded URL in the Mac browser.
- [ ] Verify the dashboard loads without Internet, Metro, USB, or ADB.
- [ ] Verify it distinguishes `Gateway online` from `G30 DISCONNECTED`.
- [ ] Open `http://<ANDROID-IP>:8080/api/v1/health` and verify JSON reports
      `gateway: "online"` and version `0.1.0`.
- [ ] Open `http://<ANDROID-IP>:8080/api/v1/state` and verify semantic JSON is
      returned without BLE UUIDs, packets, or characteristic data.

## Test 2 — Connect

- [ ] Begin with the G30 disconnected.
- [ ] Press **Scan & connect** in the browser.
- [ ] Observe `SCANNING → CONNECTING → CONNECTED` in the browser.
- [ ] Verify Android physically connects to the intended G30.
- [ ] If practical, repeat once with the G30 powered off and verify scanning
      stops after about 25 seconds and reports `NOT_FOUND`; it must not scan
      continuously. Power the G30 on and press **Try again**.

## Test 3 — Live state

- [ ] Verify actual temperature, target temperature, heater state, pump state,
      heater power, timer/delayed-heat state, RSSI, and freshness are sensible.
- [ ] Change a supported value with the physical G30 controls.
- [ ] Verify the browser updates automatically without refresh or polling.
- [ ] Temporarily interrupt notifications if practical and confirm old data is
      marked stale rather than presented as fresh.

## Test 4 — Remote pump

- [ ] From the browser, turn the pump on in a physically safe condition.
- [ ] Verify the physical G30/pump responds.
- [ ] Verify the browser shows pending feedback before it reports the G30-
      confirmed state.
- [ ] Turn the pump off and verify the confirmed state again.

## Test 5 — Target temperature

- [ ] Change the target by 0.5 °C from the browser.
- [ ] Verify the physical G30 shows the requested target.
- [ ] Verify the new target returns through BLE and appears in the browser.
- [ ] Restore the desired safe target.

## Test 6 — Heater

- [ ] Confirm heating is physically safe before continuing.
- [ ] Turn the heater on from the browser.
- [ ] Verify the physical G30 and browser-confirmed state.
- [ ] Return the heater to a safe/off state and verify confirmation.

## Test 7 — Timer

- [ ] Start a short timer from the browser.
- [ ] Verify the G30 reports it running and the browser shows its reported
      remaining/total time.
- [ ] Pause, resume, and cancel; verify each state is confirmed by the G30.
- [ ] Confirm refreshing the browser does not create a browser-owned timer.

## Test 8 — Delayed heat

- [ ] Set a safe target and arm delayed heat with a short test delay.
- [ ] Verify the controller reports the delayed-heat state and remaining time.
- [ ] Test pause/resume, then cancel and return the equipment to a safe state.
- [ ] Confirm the browser does not continue or recreate the schedule itself.

## Test 9 — Explicit disconnect

- [ ] Press **Disconnect G30** in the browser.
- [ ] Verify BLE disconnects.
- [ ] Verify the web dashboard and health endpoint remain reachable.
- [ ] Verify the browser reports `G30 DISCONNECTED`.
- [ ] Wait longer than the normal reconnect delays and verify Android does not
      automatically reconnect or resume scanning.
- [ ] Optionally connect with the official Grainfather app to prove BLE was
      released, then disconnect that app before continuing.

## Test 10 — Reconnect

- [ ] Press **Scan & connect** again.
- [ ] Verify `SCANNING → CONNECTING → CONNECTED` and live state resumes.
- [ ] Verify no command made before disconnect is replayed.

## Record results

- Android model / Android version:
- G30 firmware (if known):
- Android local IP:
- Browser/device:
- Tests passed:
- Failures or unexpected logs:
- Relevant `[GATEWAY]`, `[HTTP]`, `[WS]`, `[BLE]`, or `[COMMAND]` entries:

Do not treat background/headless operation as tested here. This MVP must remain
alive in the Android app process; foreground-service, reboot, and killed-UI
behavior are intentionally outside this pass.
