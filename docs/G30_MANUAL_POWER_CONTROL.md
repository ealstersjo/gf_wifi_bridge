# G30 manual-power control

## Source-verified protocol

The command table in the preserved `clausbroch/node-red-gfconnect` flow (which
quotes `kingpulsar/Grainfather-Bluetooth-Protocol`) documents these 19-byte,
space-padded ASCII commands on the verified command characteristic:

| Function | Payload before padding | Confirmation/status | Confidence |
| --- | --- | --- | --- |
| Enter manual-power mode | `f1` | `W` parameter 4 = `1` | Source-verified |
| Return to temperature control | `f0` | `W` parameter 4 = `0` | Source-verified |
| Read reported heater output | no write | `W` parameter 0, percent | Source-verified |

The status record is documented as:

```text
W{Heat Power Output Percentage},{Is Timer Paused},{Step Mash Mode},
  {Is Recipe Interrupted},{Manual Power Mode},{Sparge Water Alert Displayed}
```

The project parser therefore exposes `heater.powerPercent`,
`heater.manualPowerMode`, and `heater.controlMode`. A reported output value is
not used to infer manual mode; only `W` parameter 4 is authoritative.

## Intentionally not implemented

The inspected sources document entering/exiting manual mode and reading output,
but do **not** document a command that writes an absolute manual power
percentage. The existing flow's `U`/`D` commands are target-temperature
increment/decrement commands, not a verified power setter. This project does
not guess a payload, range, or increment and therefore has no
`POST /api/v1/heater/power` endpoint.

The dashboard exposes the verified mode switch and read-only controller output,
and explicitly labels manual mode as experimental. Setting 5%, 10%, or 20%
requires an independently verified command and physical testing before it can
be safely added.

## Disconnect behavior

The inspected protocol source documents the commands and status fields, but not
what the physical controller does to manual mode after a BLE disconnect. That
remains a physical acceptance test. The gateway does not send recovery commands
automatically.
