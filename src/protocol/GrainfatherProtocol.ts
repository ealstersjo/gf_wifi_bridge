import {GrainfatherState} from './GrainfatherState';

/**
 * Protocol sources:
 * - clausbroch/node-red-gfconnect flow.json, "Slice message stream",
 *   "Decode response", "Decode Temperature (X)", "Decode Timer (T)",
 *   "Decode Status (Y/W)", and "Calculate timer" nodes.
 * - clausbroch/Grainfather-Bluetooth-Protocol, a preserved fork containing
 *   the UUID/protocol table and exact command constructors.
 *
 * The controller sends a stream of 17-character ASCII records. After framing,
 * X, Y, T, and W records contain temperatures, switch/process state, timer
 * state, and power/paused state respectively. Notifications can start with Z padding
 * immediately before the record type (for example ZX65.0,16.4,ZZZZZ).
 * No binary byte offsets or invented conversion formula are used here.
 */

const ASCII_NUMBER = /^[-+]?\d+(?:\.\d+)?$/;
const G30_RECORD_LENGTH = 17;
const G30_RESYNC_PADDING = '0123456789,Z';
export const G30_COMMAND_LENGTH = 19;
export const MIN_TARGET_TEMPERATURE_C = 0;
export const MAX_TARGET_TEMPERATURE_C = 100;
export const MIN_CONTROLLER_DURATION_SECONDS = 60;
// node-red-gfconnect exposes 0..48 hours plus 0..59 minutes for both timer
// and delayed heat, making 48:59 its largest verified input.
export const MAX_CONTROLLER_DURATION_SECONDS = (48 * 60 + 59) * 60;

export interface ParsedGrainfatherStatus {
  messageType: 'X' | 'Y' | 'T' | 'W';
  rawText: string;
  state: Partial<GrainfatherState>;
}

export function bytesToAscii(data: Uint8Array): string {
  return Array.from(data, byte => String.fromCharCode(byte)).join('');
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, byte => byte.toString(16).padStart(2, '0'))
    .join(' ')
    .toUpperCase();
}

export function asciiToBytes(value: string): Uint8Array {
  return Uint8Array.from([...value].map(character => character.charCodeAt(0)));
}

export function formatGrainfatherCommand(command: string): Uint8Array {
  if (!command || /[^\x20-\x7E]/.test(command)) {
    throw new Error('G30 commands must contain printable ASCII characters');
  }
  if (command.length > G30_COMMAND_LENGTH) {
    throw new Error(`G30 command exceeds ${G30_COMMAND_LENGTH} characters`);
  }
  return asciiToBytes(command.padEnd(G30_COMMAND_LENGTH, ' '));
}

export function buildHeaterCommand(enabled: boolean): Uint8Array {
  return formatGrainfatherCommand(enabled ? 'K1' : 'K0');
}

export function buildPumpCommand(enabled: boolean): Uint8Array {
  return formatGrainfatherCommand(enabled ? 'L1' : 'L0');
}

// Exact command strings are documented by the preserved
// clausbroch/Grainfather-Bluetooth-Protocol fork and its
// GrainfatherCommands.js implementation. Its transport writes UTF-8 text,
// space-padded to 19 characters, without response.
export function buildTargetTemperatureCommand(
  temperatureC: number,
): Uint8Array {
  if (
    !Number.isFinite(temperatureC) ||
    temperatureC < MIN_TARGET_TEMPERATURE_C ||
    temperatureC > MAX_TARGET_TEMPERATURE_C
  ) {
    throw new Error(
      `Target temperature must be between ${MIN_TARGET_TEMPERATURE_C} and ${MAX_TARGET_TEMPERATURE_C} °C`,
    );
  }
  return formatGrainfatherCommand(`$${temperatureC},`);
}

function validateControllerDuration(durationSeconds: number): number {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < MIN_CONTROLLER_DURATION_SECONDS ||
    durationSeconds > MAX_CONTROLLER_DURATION_SECONDS ||
    durationSeconds % 60 !== 0
  ) {
    throw new Error(
      'Duration must be a whole number of minutes between 1 minute and 48 hours 59 minutes',
    );
  }
  return durationSeconds / 60;
}

/** Sets and immediately starts the controller-native timer. */
export function buildStartTimerCommand(durationSeconds: number): Uint8Array {
  const minutes = validateControllerDuration(durationSeconds);
  return formatGrainfatherCommand(`W${minutes},60,`);
}

/** Arms controller-native delayed heat after the supplied countdown duration. */
export function buildStartDelayedHeatCommand(
  durationSeconds: number,
): Uint8Array {
  const minutes = validateControllerDuration(durationSeconds);
  return formatGrainfatherCommand(`B${minutes},60,`);
}

/** G is a protocol toggle; callers must use reported paused state as truth. */
export function buildToggleTimerPauseCommand(): Uint8Array {
  return formatGrainfatherCommand('G');
}

/** C cancels the controller's active timer, including a delayed-heat timer. */
export function buildCancelTimerCommand(): Uint8Array {
  return formatGrainfatherCommand('C');
}

/**
 * Stateful equivalent of node-red-gfconnect's "Slice message stream" node.
 * It joins partial BLE notifications, emits every complete 17-character
 * record, and discards only the exact leading padding characters used by the
 * upstream resynchronisation logic.
 */
export class GrainfatherMessageFramer {
  private buffer = '';

  push(data: Uint8Array): Uint8Array[] {
    this.buffer += bytesToAscii(data).replace(/\0/g, '');
    const records: Uint8Array[] = [];

    while (this.buffer.length >= G30_RECORD_LENGTH) {
      while (
        this.buffer.length > 0 &&
        G30_RESYNC_PADDING.includes(this.buffer.charAt(0))
      ) {
        this.buffer = this.buffer.slice(1);
      }

      if (this.buffer.length < G30_RECORD_LENGTH) {
        break;
      }

      records.push(asciiToBytes(this.buffer.slice(0, G30_RECORD_LENGTH)));
      this.buffer = this.buffer.slice(G30_RECORD_LENGTH);
    }

    return records;
  }

  reset(): void {
    this.buffer = '';
  }
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value || !ASCII_NUMBER.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  const trimmed = value?.trim();
  return trimmed === '1' ? true : trimmed === '0' ? false : null;
}

export function parseGrainfatherStatus(
  data: Uint8Array,
  receivedAt = new Date(),
): ParsedGrainfatherStatus | null {
  if (data.length < 4) {
    return null;
  }

  const rawText = bytesToAscii(data).replace(/\0/g, '').trim();
  // The hardware capture contains one Z padding byte before the logical X
  // record. This is consistent with the upstream stream slicer discarding Z
  // while resynchronising to the next command letter.
  const record = rawText.replace(/^Z+(?=[XYTW])/, '');
  const messageType = record.charAt(0);
  if (
    messageType !== 'X' &&
    messageType !== 'Y' &&
    messageType !== 'T' &&
    messageType !== 'W'
  ) {
    return null;
  }

  // node-red-gfconnect treats Z as the end marker, otherwise it removes the
  // trailing delimiter. Normalising trailing commas accepts both forms.
  const endMarker = record.indexOf('Z');
  const body = (endMarker >= 0 ? record.slice(1, endMarker) : record.slice(1))
    .replace(/[\s,]+$/, '');
  const parameters = body.split(',').map(value => value.trim());
  if (messageType === 'X') {
    const parsedTargetTemperatureC = parseFiniteNumber(parameters[0]);
    const actualTemperatureC = parseFiniteNumber(parameters[1]);
    if (parsedTargetTemperatureC === null || actualTemperatureC === null) {
      return null;
    }
    return {
      messageType,
      rawText,
      state: {
        actualTemperatureC,
        targetTemperatureC: Math.min(parsedTargetTemperatureC, 100),
        lastUpdated: receivedAt,
      },
    };
  }

  if (messageType === 'Y') {
    const heaterOn = parseBoolean(parameters[0]);
    const pumpOn = parseBoolean(parameters[1]);
    if (heaterOn === null || pumpOn === null) {
      return null;
    }
    const state: Partial<GrainfatherState> = {heaterOn, pumpOn};
    const autoMode = parseBoolean(parameters[2]);
    const stageRamp = parseBoolean(parameters[3]);
    const interactionMode = parseBoolean(parameters[4]);
    const interactionCode = parseInteger(parameters[5]);
    const stageNumber = parseInteger(parameters[6]);
    const delayedHeat = parseBoolean(parameters[7]);
    if (autoMode !== null) state.autoMode = autoMode;
    if (stageRamp !== null) state.stageRamp = stageRamp;
    if (interactionMode !== null) state.interactionMode = interactionMode;
    if (interactionCode !== null) state.interactionCode = interactionCode;
    if (stageNumber !== null) state.stageNumber = stageNumber;
    if (delayedHeat !== null) state.delayedHeat = delayedHeat;
    return {messageType, rawText, state};
  }

  if (messageType === 'T') {
    const timerActive = parseBoolean(parameters[0]);
    const timeLeftMinutes = parseInteger(parameters[1]);
    const timerTotalMinutes = parseInteger(parameters[2]);
    const timeLeftSeconds = parseInteger(parameters[3]);
    if (
      timerActive === null ||
      timeLeftMinutes === null ||
      timerTotalMinutes === null ||
      timeLeftSeconds === null ||
      timeLeftMinutes < 0 ||
      timerTotalMinutes < 0 ||
      timeLeftSeconds < 0
    ) {
      return null;
    }
    // This is the exact normalization in node-red-gfconnect's "Decode Timer
    // (T)" node. The controller reports a minute bucket and a seconds value
    // where a newly-started whole-minute timer uses seconds=60.
    const timerRemainingSeconds = Math.max(
      0,
      (timeLeftMinutes - 1) * 60 + timeLeftSeconds,
    );
    return {
      messageType,
      rawText,
      state: {
        timerActive,
        timerDurationSeconds: timerTotalMinutes * 60,
        timerRemainingSeconds,
        timerLastUpdated: receivedAt,
      },
    };
  }

  const heaterPowerPercent = parseFiniteNumber(parameters[0]);
  if (
    heaterPowerPercent === null ||
    heaterPowerPercent < 0 ||
    heaterPowerPercent > 100
  ) {
    return null;
  }
  const state: Partial<GrainfatherState> = {heaterPowerPercent};
  const timerPaused = parseBoolean(parameters[1]);
  const manualPowerMode = parseBoolean(parameters[4]);
  if (timerPaused !== null) state.timerPaused = timerPaused;
  if (manualPowerMode !== null) state.manualPowerMode = manualPowerMode;
  return {messageType, rawText, state};
}
