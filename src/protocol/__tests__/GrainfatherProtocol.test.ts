import {
  buildCancelTimerCommand,
  buildHeaterCommand,
  buildPumpCommand,
  buildStartDelayedHeatCommand,
  buildStartTimerCommand,
  buildTargetTemperatureCommand,
  buildToggleTimerPauseCommand,
  bytesToAscii,
  bytesToHex,
  GrainfatherMessageFramer,
  MAX_CONTROLLER_DURATION_SECONDS,
  parseGrainfatherStatus,
} from '../GrainfatherProtocol';
import {
  deriveGrainfatherState,
  EMPTY_GRAINFATHER_STATE,
} from '../GrainfatherState';

const ascii = (value: string): Uint8Array =>
  Uint8Array.from([...value].map(character => character.charCodeAt(0)));

describe('parseGrainfatherStatus', () => {
  it('parses the captured ZX target/current temperature packet', () => {
    const receivedAt = new Date('2026-09-09T20:01:14.000Z');
    const result = parseGrainfatherStatus(
      ascii('ZX65.0,16.4,ZZZZZ'),
      receivedAt,
    );

    expect(result).toMatchObject({
      messageType: 'X',
      state: {
        targetTemperatureC: 65,
        actualTemperatureC: 16.4,
        lastUpdated: receivedAt,
      },
    });
  });

  it('decodes Y heater, pump, and process state', () => {
    expect(parseGrainfatherStatus(ascii('ZY1,0,1,0,0,3,2,1,Z'))).toEqual({
      messageType: 'Y',
      rawText: 'ZY1,0,1,0,0,3,2,1,Z',
      state: {
        heaterOn: true,
        pumpOn: false,
        autoMode: true,
        stageRamp: false,
        interactionMode: false,
        interactionCode: 3,
        stageNumber: 2,
        delayedHeat: true,
      },
    });
  });

  it('decodes W heater output and manual-power state', () => {
    expect(parseGrainfatherStatus(ascii('ZW75,0,0,0,1,0,Z'))).toMatchObject({
      messageType: 'W',
      state: {
        heaterPowerPercent: 75,
        timerPaused: false,
        manualPowerMode: true,
      },
    });
  });

  it('decodes running T timer status using upstream minute-bucket semantics', () => {
    const receivedAt = new Date('2026-09-16T08:00:00.000Z');
    expect(
      parseGrainfatherStatus(ascii('ZT1,2,2,30,ZZZZZZ'), receivedAt),
    ).toMatchObject({
      messageType: 'T',
      state: {
        timerActive: true,
        timerDurationSeconds: 120,
        timerRemainingSeconds: 90,
        timerLastUpdated: receivedAt,
      },
    });
  });

  it('decodes idle and elapsed timer records without negative time', () => {
    expect(parseGrainfatherStatus(ascii('T0,0,0,0,ZZZZZZZ'))).toMatchObject({
      state: {
        timerActive: false,
        timerDurationSeconds: 0,
        timerRemainingSeconds: 0,
      },
    });
    expect(parseGrainfatherStatus(ascii('T1,0,2,0,ZZZZZZZ'))).toMatchObject({
      state: {timerActive: true, timerRemainingSeconds: 0},
    });
  });

  it('accepts upstream-framed records and maps the boil sentinel', () => {
    expect(parseGrainfatherStatus(ascii('X120,99.8,'))).toMatchObject({
      state: {targetTemperatureC: 100, actualTemperatureC: 99.8},
    });
  });

  it('rejects malformed, incomplete, unknown, and invalid state records', () => {
    expect(parseGrainfatherStatus(ascii('ZXbroken,packet,ZZ'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZX65.0,,ZZZZZZZZ'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZY2,0,0,0,0,0,0,0,Z'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZW101,0,0,0,0,0,Z'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZT2,2,2,30,ZZZZZZ'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZT1,-1,2,30,ZZZZZ'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZT1,2,nope,30,ZZZ'))).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZQ1,2,3,ZZZZZZZZ'))).toBeNull();
    expect(parseGrainfatherStatus(new Uint8Array())).toBeNull();
    expect(parseGrainfatherStatus(ascii('ZX65.0,'))).toBeNull();
  });

  it('formats raw bytes as uppercase hex', () => {
    expect(bytesToHex(ascii('X65'))).toBe('58 36 35');
  });
});

describe('G30 commands', () => {
  it.each([
    [buildHeaterCommand(true), 'K1'],
    [buildHeaterCommand(false), 'K0'],
    [buildPumpCommand(true), 'L1'],
    [buildPumpCommand(false), 'L0'],
    [buildTargetTemperatureCommand(65), '$65,'],
    [buildTargetTemperatureCommand(65.5), '$65.5,'],
    [buildStartTimerCommand(120), 'W2,60,'],
    [buildStartDelayedHeatCommand(8.5 * 3600), 'B510,60,'],
    [buildToggleTimerPauseCommand(), 'G'],
    [buildCancelTimerCommand(), 'C'],
  ])('creates an exact 19-byte space-padded payload', (payload, command) => {
    expect(payload).toHaveLength(19);
    expect(bytesToAscii(payload)).toBe(command.padEnd(19, ' '));
  });

  it('rejects unsafe target values', () => {
    expect(() => buildTargetTemperatureCommand(Number.NaN)).toThrow();
    expect(() => buildTargetTemperatureCommand(-0.5)).toThrow();
    expect(() => buildTargetTemperatureCommand(100.5)).toThrow();
  });

  it('accepts the verified maximum duration', () => {
    expect(bytesToAscii(buildStartTimerCommand(MAX_CONTROLLER_DURATION_SECONDS)))
      .toBe('W2939,60,'.padEnd(19, ' '));
  });

  it.each([0, 59, 90, MAX_CONTROLLER_DURATION_SECONDS + 60, Number.NaN])(
    'rejects invalid controller duration %p',
    duration => {
      expect(() => buildStartTimerCommand(duration)).toThrow();
      expect(() => buildStartDelayedHeatCommand(duration)).toThrow();
    },
  );
});

describe('derived timer and delayed-heat state', () => {
  it.each([
    [{timerActive: false, timerPaused: false}, 'IDLE'],
    [{timerActive: true, timerPaused: false, timerRemainingSeconds: 90}, 'RUNNING'],
    [{timerActive: true, timerPaused: true, timerRemainingSeconds: 90}, 'PAUSED'],
    [{timerActive: true, timerPaused: false, timerRemainingSeconds: 0}, 'FINISHED'],
  ] as const)('derives timer state %s as %s', (update, expected) => {
    expect(
      deriveGrainfatherState({...EMPTY_GRAINFATHER_STATE, ...update}).timerState,
    ).toBe(expected);
  });

  it('derives delayed heat active, paused, started, and inactive states', () => {
    expect(
      deriveGrainfatherState({
        ...EMPTY_GRAINFATHER_STATE,
        delayedHeat: true,
        timerActive: true,
        timerPaused: false,
        timerRemainingSeconds: 60,
      }).delayedHeatState,
    ).toBe('ARMED');
    expect(
      deriveGrainfatherState({
        ...EMPTY_GRAINFATHER_STATE,
        delayedHeat: true,
        timerActive: true,
        timerPaused: true,
      }).delayedHeatState,
    ).toBe('PAUSED');
    expect(
      deriveGrainfatherState({
        ...EMPTY_GRAINFATHER_STATE,
        delayedHeat: true,
        timerActive: true,
        timerPaused: false,
        timerRemainingSeconds: 0,
      }).delayedHeatState,
    ).toBe('STARTED');
    expect(
      deriveGrainfatherState({
        ...EMPTY_GRAINFATHER_STATE,
        delayedHeat: false,
      }).delayedHeatState,
    ).toBe('INACTIVE');
  });

  it('derives elapsed seconds from controller total and remaining values', () => {
    expect(
      deriveGrainfatherState({
        ...EMPTY_GRAINFATHER_STATE,
        timerDurationSeconds: 120,
        timerRemainingSeconds: 90,
      }).timerElapsedSeconds,
    ).toBe(30);
  });
});

describe('GrainfatherMessageFramer', () => {
  it('buffers a record fragmented across BLE notifications', () => {
    const framer = new GrainfatherMessageFramer();

    expect(framer.push(ascii('ZX65.0,1'))).toEqual([]);
    const records = framer.push(ascii('6.4,ZZZZZZ'));

    expect(records).toHaveLength(1);
    expect(parseGrainfatherStatus(records[0])).toMatchObject({
      state: {targetTemperatureC: 65, actualTemperatureC: 16.4},
    });
  });

  it('emits multiple fixed-width records received together', () => {
    const framer = new GrainfatherMessageFramer();
    const records = framer.push(
      ascii('X65.0,16.4,ZZZZZZY1,0,0,0,0,0,0,,Z'),
    );

    expect(records).toHaveLength(2);
    expect(parseGrainfatherStatus(records[0])?.messageType).toBe('X');
    expect(parseGrainfatherStatus(records[1])?.messageType).toBe('Y');
  });
});
