# Brew statistics and recipe physical test checklist

Use this checklist on a real G30 after installing the standalone release APK.
The gateway must remain a passive observer: recipe data and phase markers must
never start heating, pumping, or any other Grainfather operation.

## Recipe and session capture

- [ ] Create a recipe with at least two mash steps, planned batch volume,
      grain weight, mash water, sparge water, pre-boil volume, and boil time.
- [ ] Edit and duplicate the recipe; confirm the original remains unchanged.
- [ ] Start a session using the recipe and verify the active session shows the
      recipe name and planned values.
- [ ] End the session, edit the recipe, and verify the historical session still
      contains the original recipe snapshot.
- [ ] Enter actual mash, pre-boil, and batch volumes; confirm they are stored
      on the session and appear in its summary.

## Telemetry and phase detection

- [ ] Leave the G30 disconnected: the gateway remains online and no samples
      or fabricated phase transitions are created.
- [ ] Connect the G30 and verify samples arrive at roughly the five-second
      cadence without changing any controller state.
- [ ] Confirm target stability and mash-step statistics use persisted samples,
      with tolerance and coverage shown where enough data exists.
- [ ] Use manual phase markers for mash complete, boil started, and boil
      complete when the physical brew reaches those points.
- [ ] Confirm UNKNOWN is shown when the available data cannot support a phase
      conclusion; stale data is not treated as fresh.

## Review and repeatability

- [ ] End the session and review its summary: duration, sample count,
      coverage, heat-to-mash, mash-step, mash-to-boil, and boil fields.
- [ ] Open historical performance and confirm each aggregate includes a
      comparable volume bucket and sample count.
- [ ] Repeat with a second comparable session and confirm the aggregate updates
      without modifying either historical snapshot.
- [ ] Verify existing BLE connect/disconnect, command confirmation, telemetry,
      WebSocket, and foreground-service behavior remains unchanged.
