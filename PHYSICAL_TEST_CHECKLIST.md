# Grainfather G30 physical test checklist

Use the standalone release APK. Keep the official Grainfather app and GCAST
disconnected so they do not compete for the BLE connection.

## Before testing

- Put the G30 in a stable, attended location.
- For pump tests, fill it with enough clean water to operate the pump safely.
- Do not run the pump dry.
- Do not test heat with an empty vessel. Confirm the element is covered and the
  system is otherwise in a physically safe condition for heating.
- Keep access to the physical controller and power switch throughout the test.

## Test 1 – Connect and read state

- Tap **Scan**, select **Grain**, and wait for **CONNECTED**.
- Verify Android actual temperature equals the G30 display.
- Verify Android target temperature equals the G30 display.
- Verify Android heater-enabled state equals the G30 heat indication.
- Verify Android pump state equals the G30 pump indication.
- If shown, verify heater output percentage is plausible for the controller's
  current state. This is decoded status only; the app does not set power.
- Verify the last-update age resets and raw BLE debug continues to populate.

## Test 2 – Pump

- Start with the physical pump OFF.
- Tap **Pump ON** once. Verify the app shows a pending command.
- Verify the pump starts and the physical controller indicates pump ON.
- Verify Android changes to pump ON only after a reported state notification.
- Tap **Pump OFF** once and repeat the same checks in reverse.

## Test 3 – Target temperature

- Record the existing target temperature.
- Tap **+ 0.5 °C** once.
- Verify the physical G30 target changes by 0.5 °C.
- Verify the notification stream reports the new target and Android confirms it.
- Tap **− 0.5 °C** to restore the original target and verify confirmation again.

## Test 4 – Heater

Only perform this test with adequate water in the vessel and in a condition
where energising the element is safe.

- Start with heat OFF and tap **Heat ON** once.
- Verify the physical controller responds and indicates heat enabled.
- Verify Android changes to heater enabled only after reported state feedback.
- Do not interpret heater output below 100% as failure: the controller remains
  responsible for regulating power against the target.
- Tap **Heat OFF**, verify the physical indication clears, and verify Android
  receives and displays the OFF state.
- Leave heat OFF after the test.

## Test 5 – Disconnect and failure behavior

- Tap **Disconnect**.
- Verify the app shows **DISCONNECTED**, data becomes stale, and controls disable.
- Wait at least 10 seconds and verify the app does not automatically reconnect.
- Reconnect, issue one safe pump command, and immediately try another control.
- Verify the second action is disabled/rejected while the first is pending and
  no command storm appears in raw debug.

## Test 6 – Controller timer

- Enter a short duration, for example **0 h 2 min**, and tap **Start timer**.
- Verify the physical G30 displays and starts the two-minute timer.
- Verify Android confirms `RUNNING` from controller feedback and shows the same
  remaining time and total duration.
- Tap **Pause**. Verify the physical countdown pauses, then verify Android
  changes to `PAUSED` only after reported state feedback.
- Tap **Resume** and verify both the physical controller and Android resume.
- Tap **Cancel timer** and verify both return to an inactive/idle state.
- Where possible, start or change a timer from the physical G30 and verify
  Android follows the controller without sending a command.

## Test 7 – Delayed heat

Only run the activation portion with adequate water in the vessel and in a
condition where heating is safe. The app intentionally has no confirmation
dialog; the operator remains responsible for the physical setup.

- Set the desired target on the G30 or through Android and record it.
- Enter a short delay and tap **Arm delayed heat**.
- Verify the physical G30 shows delayed heat and the expected countdown.
- Verify Android confirms `ARMED`, shows the same remaining time, and displays
  the controller's current target.
- Tap **Pause**, verify the physical controller pauses, and verify Android
  reports `PAUSED` from controller feedback.
- Tap **Resume** and verify both resume.
- Tap **Cancel delayed heat** and verify the G30 and Android become inactive.
- Arm another short delay and allow it to expire. Verify the G30 itself
  transitions into heating and Android only observes the resulting state.
- Turn heat OFF after the test.
- Optionally disconnect Android after delayed heat is confirmed armed. Verify
  the controller retains the countdown, then reconnect and verify Android
  reconstructs its view without restarting or resending it.

## Heater-power note

`W` status exposes heater output percentage and manual-power mode. No direct,
absolute heater-power write was implemented because the reviewed protocol only
verified entering/exiting manual-power mode and context-dependent up/down steps;
that is not a safe `setHeaterPower(value)` operation. There is therefore no
physical power-write test in this checklist.
