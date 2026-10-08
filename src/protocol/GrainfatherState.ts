export type GrainfatherTimerState =
  | 'UNKNOWN'
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'FINISHED';

export type GrainfatherDelayedHeatState =
  | 'UNKNOWN'
  | 'INACTIVE'
  | 'ARMED'
  | 'PAUSED'
  | 'STARTED';

export type HeaterControlMode = 'TEMPERATURE' | 'MANUAL_POWER' | 'UNKNOWN';

export interface GrainfatherState {
  actualTemperatureC: number | null;
  targetTemperatureC: number | null;
  heaterOn: boolean | null;
  pumpOn: boolean | null;
  heaterPowerPercent: number | null;
  autoMode: boolean | null;
  stageRamp: boolean | null;
  interactionMode: boolean | null;
  interactionCode: number | null;
  stageNumber: number | null;
  delayedHeat: boolean | null;
  manualPowerMode: boolean | null;
  heaterControlMode: HeaterControlMode;
  timerActive: boolean | null;
  timerPaused: boolean | null;
  timerDurationSeconds: number | null;
  timerRemainingSeconds: number | null;
  timerElapsedSeconds: number | null;
  timerState: GrainfatherTimerState;
  delayedHeatState: GrainfatherDelayedHeatState;
  timerLastUpdated: Date | null;
  lastUpdated: Date | null;
}

export const EMPTY_GRAINFATHER_STATE: GrainfatherState = {
  actualTemperatureC: null,
  targetTemperatureC: null,
  heaterOn: null,
  pumpOn: null,
  heaterPowerPercent: null,
  autoMode: null,
  stageRamp: null,
  interactionMode: null,
  interactionCode: null,
  stageNumber: null,
  delayedHeat: null,
  manualPowerMode: null,
  heaterControlMode: 'UNKNOWN',
  timerActive: null,
  timerPaused: null,
  timerDurationSeconds: null,
  timerRemainingSeconds: null,
  timerElapsedSeconds: null,
  timerState: 'UNKNOWN',
  delayedHeatState: 'UNKNOWN',
  timerLastUpdated: null,
  lastUpdated: null,
};

export function deriveGrainfatherState(
  state: GrainfatherState,
): GrainfatherState {
  const heaterControlMode: HeaterControlMode =
    state.manualPowerMode === true ? 'MANUAL_POWER' :
      state.manualPowerMode === false ? 'TEMPERATURE' : 'UNKNOWN';
  let timerState: GrainfatherTimerState = 'UNKNOWN';
  if (state.timerPaused === true) {
    timerState = 'PAUSED';
  } else if (state.timerActive === true) {
    timerState = state.timerRemainingSeconds === 0 ? 'FINISHED' : 'RUNNING';
  } else if (state.timerActive === false && state.timerPaused === false) {
    timerState = 'IDLE';
  }

  let delayedHeatState: GrainfatherDelayedHeatState = 'UNKNOWN';
  if (state.delayedHeat === false) {
    delayedHeatState = 'INACTIVE';
  } else if (state.delayedHeat === true) {
    if (state.timerPaused === true) {
      delayedHeatState = 'PAUSED';
    } else if (state.timerActive === true) {
      delayedHeatState =
        state.timerRemainingSeconds === 0 ? 'STARTED' : 'ARMED';
    }
  }

  const timerElapsedSeconds =
    state.timerDurationSeconds !== null && state.timerRemainingSeconds !== null
      ? Math.max(
          0,
          Math.min(
            state.timerDurationSeconds,
            state.timerDurationSeconds - state.timerRemainingSeconds,
          ),
        )
      : null;

  return {...state, heaterControlMode, timerState, delayedHeatState, timerElapsedSeconds};
}
