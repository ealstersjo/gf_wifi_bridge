import {ConnectionState} from '../ble/GrainfatherConnection';
import {GrainfatherState} from '../protocol/GrainfatherState';

export const TELEMETRY_INTERVAL_MS = 5_000;
export const TREND_WINDOW_MS = 3 * 60_000;

export type BrewSessionStatus = 'ACTIVE' | 'COMPLETED';
export type RecipeId = string;

export interface MashStep {
  name: string;
  targetTemperatureC: number;
  durationMinutes: number;
  type?: string | null;
  rampTimeMinutes?: number | null;
  infuseAmountL?: number | null;
}

export interface Fermentable { name: string; amountKg: number | null; type?: string | null; yieldPercent?: number | null; color?: number | null; origin?: string | null; supplier?: string | null; notes?: string | null; }
export interface HopAddition { name: string; amountG: number | null; use?: string | null; timeMinutes?: number | null; alphaPercent?: number | null; ibu?: number | null; notes?: string | null; }
export interface YeastEntry { name: string; laboratory?: string | null; productId?: string | null; type?: string | null; form?: string | null; attenuationPercent?: number | null; amountG?: number | null; notes?: string | null; }
export interface WaterProfile { calciumPpm?: number | null; magnesiumPpm?: number | null; sodiumPpm?: number | null; chloridePpm?: number | null; sulfatePpm?: number | null; bicarbonatePpm?: number | null; }
export interface MiscAddition { name: string; type?: string | null; use?: string | null; useFor?: string | null; amountG?: number | null; amountIsWeight?: boolean | null; timeMinutes?: number | null; notes?: string | null; }
export interface EquipmentProfile { name?: string | null; batchSizeL?: number | null; boilSizeL?: number | null; evaporationRateLPerHour?: number | null; efficiencyPercent?: number | null; notes?: string | null; }
export interface FermentationStep { name?: string | null; temperatureC: number | null; durationDays?: number | null; notes?: string | null; }

export interface Recipe {
  id: RecipeId;
  name: string;
  style: string | null;
  notes: string | null;
  plannedBatchVolumeL: number | null;
  grainWeightKg: number | null;
  mashWaterVolumeL: number | null;
  spargeWaterVolumeL: number | null;
  plannedPreBoilVolumeL: number | null;
  mashSteps: MashStep[];
  boilDurationMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  source?: string | null;
  sourceRecipeId?: string | null;
  sourceFormat?: string | null;
  sourceImportedAt?: string | null;
  originalRecipeData?: unknown;
  originalImport?: string | null;
  og?: number | null;
  fg?: number | null;
  abvPercent?: number | null;
  ibu?: number | null;
  color?: number | null;
  efficiencyPercent?: number | null;
  plannedBoilVolumeL?: number | null;
  fermentables?: Fermentable[];
  hops?: HopAddition[];
  yeasts?: YeastEntry[];
  waterProfile?: WaterProfile | null;
  miscs?: MiscAddition[];
  equipment?: EquipmentProfile | null;
  mashProfile?: {name?: string | null; grainTemperatureC?: number | null; tunTemperatureC?: number | null; spargeTemperatureC?: number | null; ph?: number | null; tunWeightKg?: number | null; notes?: string | null} | null;
  fermentation?: FermentationStep[];
}

export type BrewPhase =
  | 'PREHEAT' | 'MASH_HEATING' | 'MASH_REST' | 'MASH_STEP_TRANSITION'
  | 'MASH_OUT' | 'HEAT_TO_BOIL' | 'BOIL' | 'OTHER' | 'UNKNOWN';

export interface SessionActualValues {
  mashWaterVolumeL: number | null;
  preBoilVolumeL: number | null;
  batchVolumeL: number | null;
}

export interface SessionStatistics {
  sessionDurationSeconds: number | null;
  telemetrySampleCount: number;
  telemetryCoveragePercent: number | null;
  heatToFirstMashTarget: HeatIntervalStatistics | null;
  mashSteps: MashStepStatistics[];
  stepTransitions: HeatIntervalStatistics[];
  mashToBoil: HeatIntervalStatistics | null;
  boil: BoilStatistics | null;
}

export interface HeatIntervalStatistics {
  phase: 'HEAT_TO_MASH' | 'STEP_TRANSITION' | 'MASH_TO_BOIL';
  startTemperatureC: number;
  targetTemperatureC: number;
  elapsedSeconds: number;
  averageRateCPerMinute: number;
  volumeL: number | null;
  grainWeightKg: number | null;
  averageHeaterOutputPercent: number | null;
  maximumHeaterOutputPercent: number | null;
  coveragePercent: number;
}

export interface MashStepStatistics {
  index: number;
  targetTemperatureC: number;
  plannedDurationMinutes: number;
  observedDurationSeconds: number | null;
  averageTemperatureC: number | null;
  minimumTemperatureC: number | null;
  maximumTemperatureC: number | null;
  overshootC: number | null;
  undershootC: number | null;
  standardDeviationC: number | null;
  averageHeaterOutputPercent: number | null;
  pumpOnPercent: number | null;
  coveragePercent: number | null;
}

export interface BoilStatistics {
  observedDurationSeconds: number | null;
  averageTemperatureC: number | null;
  averageHeaterOutputPercent: number | null;
  pumpOnPercent: number | null;
  detectedBoilTemperatureC: number | null;
}
export type BrewEventSource = 'WEB' | 'G30' | 'SYSTEM' | 'UNKNOWN' | 'BREW_ENGINE';
export type BrewEventType =
  | 'SESSION_STARTED' | 'SESSION_ENDED'
  | 'G30_CONNECTED' | 'G30_DISCONNECTED'
  | 'TARGET_CHANGED' | 'HEATER_ON' | 'HEATER_OFF' | 'PUMP_ON' | 'PUMP_OFF'
  | 'TIMER_STARTED' | 'TIMER_PAUSED' | 'TIMER_RESUMED' | 'TIMER_COMPLETED' | 'TIMER_CANCELLED'
  | 'DELAYED_HEAT_STARTED' | 'DELAYED_HEAT_PAUSED' | 'DELAYED_HEAT_RESUMED' | 'DELAYED_HEAT_CANCELLED'
  | 'TARGET_REACHED'
  | 'RECIPE_SELECTED' | 'MASH_STEP_STARTED' | 'MASH_STEP_REACHED' | 'MASH_STEP_COMPLETED'
  | 'MASH_COMPLETED' | 'HEAT_TO_BOIL_STARTED' | 'BOIL_STARTED' | 'BOIL_COMPLETED'
  | 'ACTUAL_VOLUME_RECORDED' | 'MANUAL_PHASE_MARKER';

export interface BrewSession {
  id: string;
  name: string | null;
  startedAt: string;
  endedAt: string | null;
  status: BrewSessionStatus;
  recipeId?: RecipeId | null;
  recipeSnapshot?: Recipe | null;
  plannedBatchVolumeL?: number | null;
  plannedPreBoilVolumeL?: number | null;
  grainWeightKg?: number | null;
  actual?: SessionActualValues;
  currentPhase?: BrewPhase;
}

export interface TelemetrySample {
  id: number;
  sessionId: string;
  timestamp: string;
  actualTemperatureC: number;
  targetTemperatureC: number | null;
  heaterEnabled: boolean | null;
  heaterOutputPercent: number | null;
  heaterControlMode: 'TEMPERATURE' | 'MANUAL_POWER' | 'UNKNOWN' | null;
  pumpEnabled: boolean | null;
  rssi: number | null;
}

export interface BrewEvent {
  id: number;
  sessionId: string;
  timestamp: string;
  type: BrewEventType;
  source: BrewEventSource;
  payload: Record<string, unknown>;
}

export interface SessionObservation {
  connectionState: ConnectionState;
  state: GrainfatherState;
  rssi: number | null;
  stale: boolean;
}

export interface SessionLiveState {
  active: BrewSession | null;
  heatingRateCPerMinute: number | null;
  etaSeconds: number | null;
  latestTelemetry: TelemetrySample | null;
  latestEvent: BrewEvent | null;
  revision: number;
  currentPhase?: BrewPhase;
}

export interface SessionStore {
  getActiveSession(): Promise<BrewSession | null>;
  createSession(name: string | null, startedAt: string, recipeId?: RecipeId | null, recipeSnapshot?: Recipe | null): Promise<BrewSession>;
  endSession(id: string, endedAt: string): Promise<BrewSession>;
  listSessions(): Promise<BrewSession[]>;
  getSession(id: string): Promise<BrewSession | null>;
  insertTelemetry(sample: Omit<TelemetrySample, 'id'>): Promise<TelemetrySample>;
  listTelemetry(id: string, since: string | null, limit: number): Promise<TelemetrySample[]>;
  insertEvent(event: Omit<BrewEvent, 'id'>): Promise<BrewEvent>;
  listEvents(id: string, limit: number): Promise<BrewEvent[]>;
  listRecipes?(): Promise<Recipe[]>;
  getRecipe?(id: RecipeId): Promise<Recipe | null>;
  saveRecipe?(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Recipe, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Recipe>;
  duplicateRecipe?(id: RecipeId, name?: string): Promise<Recipe>;
  deleteRecipe?(id: RecipeId): Promise<void>;
  deleteSession?(id: string): Promise<void>;
  updateActualValues?(id: string, actual: SessionActualValues): Promise<BrewSession>;
}

export interface CreateSessionInput {
  name: string | null;
  startedAt: string;
  recipeId?: RecipeId | null;
  recipeSnapshot?: Recipe | null;
}

export function calculateHeatingRate(
  samples: TelemetrySample[],
  nowMs = Date.now(),
): number | null {
  const recent = samples.filter(sample => {
    const time = Date.parse(sample.timestamp);
    return Number.isFinite(time) && nowMs - time <= TREND_WINDOW_MS;
  });
  if (recent.length < 6) return null;
  const times = recent.map(sample => Date.parse(sample.timestamp) / 60_000);
  if (Math.max(...times) - Math.min(...times) < 0.5) return null;
  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
  const meanTemp = recent.reduce((sum, sample) => sum + sample.actualTemperatureC, 0) / recent.length;
  let numerator = 0;
  let denominator = 0;
  recent.forEach((sample, index) => {
    const deltaTime = times[index] - meanTime;
    numerator += deltaTime * (sample.actualTemperatureC - meanTemp);
    denominator += deltaTime * deltaTime;
  });
  if (denominator === 0) return null;
  const rate = numerator / denominator;
  return Math.abs(rate) < 0.05 ? 0 : rate;
}

export function calculateEtaSeconds(
  observation: SessionObservation,
  heatingRateCPerMinute: number | null,
): number | null {
  const actual = observation.state.actualTemperatureC;
  const target = observation.state.targetTemperatureC;
  if (
    observation.stale || observation.connectionState !== 'CONNECTED' ||
    observation.state.heaterOn !== true || actual === null || target === null ||
    heatingRateCPerMinute === null || heatingRateCPerMinute < 0.1
  ) return null;
  const gap = target - actual;
  if (gap <= 0.2) return null;
  const seconds = gap / heatingRateCPerMinute * 60;
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 6 * 3600
    ? Math.round(seconds)
    : null;
}
