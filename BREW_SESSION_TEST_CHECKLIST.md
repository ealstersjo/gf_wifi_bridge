# Brew Session Physical Test Checklist

This validates the new recording/history layer against the already verified
browser → LAN → Android → BLE → physical G30 path. It has not been physically
verified until this checklist is completed.

## Setup and safety

- [ ] Install the latest standalone release APK.
- [ ] Put the G30 in a safe operating condition and remain with it throughout.
- [ ] Connect the browser to the Android gateway and connect Android to the G30.
- [ ] Confirm actual/target temperature, heater, output, pump, RSSI, and data age
      are live before starting.
- [ ] Do not test heating without the correct safe liquid level and normal G30
      operating precautions.

## Active session and telemetry

1. [ ] Enter an optional name and press **Start brew session**.
2. [ ] Verify the session becomes ACTIVE, the name/start time appear, and its
       runtime advances.
3. [ ] Wait at least 20 seconds, then confirm the graph has multiple samples.
4. [ ] Leave the G30 heating for at least several minutes.
5. [ ] Verify the 15-minute graph grows live without refreshing.
6. [ ] Verify actual and target lines are distinguishable.
7. [ ] Verify heater output has a read-only percentage bar.
8. [ ] After enough rising history, verify heating rate appears and is stable
       rather than jumping with every notification.
9. [ ] Verify ETA appears only while connected, fresh, below target, and heating
       upward with the heater enabled.
10. [ ] Turn the heater off and confirm ETA becomes unavailable.

## Confirmed commands and events

11. [ ] Change target from the browser and wait for G30 confirmation.
12. [ ] Verify one `TARGET_CHANGED` event with source `WEB`, old target, and new
        target. Ensure it was not created merely when the request was accepted.
13. [ ] Toggle the pump from the browser and verify the confirmed event is `WEB`.
14. [ ] Toggle the pump physically on the G30 and verify the event is `G30` when
        there is no matching pending web command.
15. [ ] Safely test heater events in the same way if appropriate.
16. [ ] Exercise timer and delayed-heat operations already verified by the
        controller; verify only state transitions supported by G30 feedback are
        logged.

## Target reached hysteresis

17. [ ] Allow actual temperature to reach within 0.2 °C below target and remain
        there for at least five seconds.
18. [ ] Verify exactly one `TARGET_REACHED` event is recorded.
19. [ ] Let temperature oscillate normally around the same target and verify no
        duplicate target-reached events appear.
20. [ ] Change target by at least 0.5 °C, reach it, and verify one new event.

## Disconnect and recovery

21. [ ] Disconnect or power off the G30 while leaving the session active.
22. [ ] Verify a `G30_DISCONNECTED` event and that the session remains ACTIVE.
23. [ ] Wait at least 15 seconds; verify no flat/fabricated samples are appended.
24. [ ] Reconnect and verify `G30_CONNECTED` is recorded.
25. [ ] Verify sampling resumes in the same session after fresh state returns.

## End and history

26. [ ] Press **End session**.
27. [ ] Verify recording stops without disconnecting G30 or changing heater,
        pump, target, timer, or delayed heat.
28. [ ] Verify the completed session appears in Brew history.
29. [ ] Open it and verify start/end, duration, full-session graph, telemetry,
        and event log remain available and read-only.
30. [ ] Test 15-minute, one-hour, and Session graph ranges.
31. [ ] Start a new session and verify the completed session is retained.

## Restart recovery

32. [ ] Start a temporary session, close/relaunch the Android process normally,
        and verify the persisted ACTIVE session is restored rather than replaced.
33. [ ] Verify sampling resumes after connected fresh G30 state returns.
34. [ ] End the recovered session.

Record Android/browser versions, session IDs, unexpected events, gaps, and
relevant `[GATEWAY]`, `[HTTP]`, `[WS]`, `[STATE]`, and `[COMMAND]` logs here.

This checklist does not certify killed-process, reboot, background, or headless
operation. Those require the future Android foreground-service architecture.
