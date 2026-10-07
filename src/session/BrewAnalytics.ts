import {
  BrewEvent,
  BrewPhase,
  BrewSession,
  HeatIntervalStatistics,
  MashStepStatistics,
  MashStep,
  SessionStatistics,
  TelemetrySample,
} from './BrewSession';

/** Analysis deliberately uses persisted samples only; no live values are invented. */
export const TARGET_TOLERANCE_C = 0.3;
export const TARGET_STABILITY_MS = 30_000;
export const BOIL_MIN_TEMPERATURE_C = 90;
export const BOIL_STABILITY_MS = 60_000;
const SAMPLE_INTERVAL_MS = 5_000;

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => Number.isFinite(value));
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values: number[]): number | null {
  const mean = average(values);
  if (mean === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

export function telemetryCoverage(samples: TelemetrySample[], startMs?: number, endMs?: number): number | null {
  const valid = samples.filter(sample => Number.isFinite(Date.parse(sample.timestamp)));
  if (!valid.length) return null;
  const start = startMs ?? Date.parse(valid[0].timestamp);
  const end = endMs ?? Date.parse(valid[valid.length - 1].timestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 100;
  const expected = Math.max(1, Math.round((end - start) / SAMPLE_INTERVAL_MS) + 1);
  return Math.min(100, valid.filter(sample => {
    const timestamp = Date.parse(sample.timestamp);
    return timestamp >= start && timestamp <= end;
  }).length / expected * 100);
}

function stableAt(samples: TelemetrySample[], index: number, target: number): boolean {
  const end = Date.parse(samples[index].timestamp);
  const window = samples.filter(sample => {
    const time = Date.parse(sample.timestamp);
    return time <= end && time >= end - TARGET_STABILITY_MS;
  });
  return window.length >= 2 && window.every(sample => Math.abs(sample.actualTemperatureC - target) <= TARGET_TOLERANCE_C);
}

export function targetReachedAt(samples: TelemetrySample[], target: number, fromIndex = 0): number | null {
  for (let index = Math.max(0, fromIndex); index < samples.length; index += 1) {
    if (Math.abs(samples[index].actualTemperatureC - target) <= TARGET_TOLERANCE_C && stableAt(samples, index, target)) {
      return Date.parse(samples[index].timestamp);
    }
  }
  return null;
}

function heaterStats(samples: TelemetrySample[]): {average: number | null; maximum: number | null} {
  const outputs = finite(samples.map(sample => sample.heaterOutputPercent));
  return {average: average(outputs), maximum: outputs.length ? Math.max(...outputs) : null};
}

function heatInterval(
  phase: HeatIntervalStatistics['phase'],
  samples: TelemetrySample[],
  target: number,
  session: BrewSession,
  volumeL: number | null,
): HeatIntervalStatistics | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const start = Date.parse(first.timestamp);
  const end = Date.parse(last.timestamp);
  const elapsedSeconds = (end - start) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;
  const heater = heaterStats(samples);
  return {
    phase,
    startTemperatureC: first.actualTemperatureC,
    targetTemperatureC: target,
    elapsedSeconds,
    averageRateCPerMinute: (last.actualTemperatureC - first.actualTemperatureC) / (elapsedSeconds / 60),
    volumeL,
    grainWeightKg: session.grainWeightKg ?? session.recipeSnapshot?.grainWeightKg ?? null,
    averageHeaterOutputPercent: heater.average,
    maximumHeaterOutputPercent: heater.maximum,
    coveragePercent: telemetryCoverage(samples) ?? 0,
  };
}

function stepStatistics(index: number, step: MashStep, samples: TelemetrySample[], startMs: number, endMs: number | null): MashStepStatistics {
  const inRange = samples.filter(sample => {
    const time = Date.parse(sample.timestamp);
    return time >= startMs && (endMs === null || time <= endMs);
  });
  const temperatures = inRange.map(sample => sample.actualTemperatureC);
  const heater = heaterStats(inRange);
  const pumpSamples = inRange.filter(sample => sample.pumpEnabled !== null);
  const pumpOn = pumpSamples.filter(sample => sample.pumpEnabled === true).length;
  const reached = targetReachedAt(samples, step.targetTemperatureC, samples.findIndex(sample => Date.parse(sample.timestamp) >= startMs));
  const observedEnd = endMs ?? (inRange.length ? Date.parse(inRange[inRange.length - 1].timestamp) : null);
  return {
    index,
    targetTemperatureC: step.targetTemperatureC,
    plannedDurationMinutes: step.durationMinutes,
    observedDurationSeconds: reached !== null && observedEnd !== null ? Math.max(0, (observedEnd - reached) / 1000) : null,
    averageTemperatureC: average(temperatures),
    minimumTemperatureC: temperatures.length ? Math.min(...temperatures) : null,
    maximumTemperatureC: temperatures.length ? Math.max(...temperatures) : null,
    overshootC: temperatures.length ? Math.max(0, Math.max(...temperatures) - step.targetTemperatureC) : null,
    undershootC: temperatures.length ? Math.max(0, step.targetTemperatureC - Math.min(...temperatures)) : null,
    standardDeviationC: standardDeviation(temperatures),
    averageHeaterOutputPercent: heater.average,
    pumpOnPercent: pumpSamples.length ? pumpOn / pumpSamples.length * 100 : null,
    coveragePercent: inRange.length ? telemetryCoverage(inRange, startMs, endMs ?? undefined) : null,
  };
}

function eventTime(events: BrewEvent[], type: string): number | null {
  const event = events.find(item => item.type === type);
  return event ? Date.parse(event.timestamp) : null;
}

export function calculateSessionStatistics(session: BrewSession, samples: TelemetrySample[], events: BrewEvent[]): SessionStatistics {
  const ordered = [...samples].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const started = Date.parse(session.startedAt);
  const ended = session.endedAt ? Date.parse(session.endedAt) : (ordered.length ? Date.parse(ordered[ordered.length - 1].timestamp) : NaN);
  const steps = session.recipeSnapshot?.mashSteps ?? [];
  const firstTarget = steps[0]?.targetTemperatureC ?? null;
  const firstReached = firstTarget === null ? null : targetReachedAt(ordered, firstTarget);
  const firstStart = ordered.length ? Date.parse(ordered[0].timestamp) : started;
  const heatToMash = firstTarget !== null && firstReached !== null
    ? heatInterval('HEAT_TO_MASH', ordered.filter(sample => Date.parse(sample.timestamp) <= firstReached), firstTarget, session, session.recipeSnapshot?.mashWaterVolumeL ?? null)
    : null;
  const mashSteps = steps.map((step, index) => {
    const stepStart = targetReachedAt(ordered, step.targetTemperatureC, index ? ordered.findIndex(sample => Date.parse(sample.timestamp) >= (targetReachedAt(ordered, steps[index - 1].targetTemperatureC) ?? firstStart)) : 0) ?? firstStart;
    const next = steps[index + 1] ? targetReachedAt(ordered, steps[index + 1].targetTemperatureC) : null;
    return stepStatistics(index, step, ordered, stepStart, next);
  });
  const boilStart = eventTime(events, 'BOIL_STARTED');
  const heatToBoilStart = eventTime(events, 'HEAT_TO_BOIL_STARTED');
  const boilEnd = eventTime(events, 'BOIL_COMPLETED') ?? ended;
  const boilSamples = boilStart === null ? [] : ordered.filter(sample => {
    const timestamp = Date.parse(sample.timestamp);
    return timestamp >= boilStart && (boilEnd === null || timestamp <= boilEnd);
  });
  const boilTemperatures = boilSamples.map(sample => sample.actualTemperatureC);
  const boilHeater = heaterStats(boilSamples);
  const boilPump = boilSamples.filter(sample => sample.pumpEnabled !== null);
  const mashToBoil = heatToBoilStart !== null && boilStart !== null
    ? heatInterval('MASH_TO_BOIL', ordered.filter(sample => {
      const timestamp = Date.parse(sample.timestamp);
      return timestamp >= heatToBoilStart && timestamp <= boilStart;
    }), boilSamples[0]?.actualTemperatureC ?? 90, session, session.recipeSnapshot?.plannedPreBoilVolumeL ?? null)
    : null;
  const coverage = ordered.length ? telemetryCoverage(ordered, firstStart, Number.isFinite(ended) ? ended : undefined) : null;
  return {
    sessionDurationSeconds: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, (ended - started) / 1000) : null,
    telemetrySampleCount: ordered.length,
    telemetryCoveragePercent: coverage,
    heatToFirstMashTarget: heatToMash,
    mashSteps,
    stepTransitions: [],
    mashToBoil,
    boil: boilStart === null ? null : {
      observedDurationSeconds: boilEnd !== null ? Math.max(0, (boilEnd - boilStart) / 1000) : null,
      averageTemperatureC: average(boilTemperatures),
      averageHeaterOutputPercent: boilHeater.average,
      pumpOnPercent: boilPump.length ? boilPump.filter(sample => sample.pumpEnabled === true).length / boilPump.length * 100 : null,
      detectedBoilTemperatureC: boilTemperatures.length ? average(boilTemperatures) : null,
    },
  };
}

export function detectPhase(
  session: BrewSession | null,
  samples: TelemetrySample[],
  events: BrewEvent[],
): BrewPhase {
  if (!session || !samples.length) return 'UNKNOWN';
  const manual = events.find(event => event.type === 'MANUAL_PHASE_MARKER')?.payload?.phase;
  if (manual === 'BOIL_STARTED') return 'BOIL';
  if (manual === 'MASH_COMPLETED') return 'HEAT_TO_BOIL';
  if (eventTime(events, 'BOIL_STARTED') !== null) return 'BOIL';
  if (eventTime(events, 'HEAT_TO_BOIL_STARTED') !== null) return 'HEAT_TO_BOIL';
  const steps = session.recipeSnapshot?.mashSteps ?? [];
  const latest = samples[samples.length - 1];
  if (!steps.length || latest.targetTemperatureC === null) return 'UNKNOWN';
  const index = steps.findIndex(step => Math.abs(step.targetTemperatureC - latest.targetTemperatureC!) <= TARGET_TOLERANCE_C);
  if (index < 0) return 'OTHER';
  if (Math.abs(latest.actualTemperatureC - steps[index].targetTemperatureC) <= TARGET_TOLERANCE_C) return 'MASH_REST';
  if (index > 0) return 'MASH_STEP_TRANSITION';
  return latest.actualTemperatureC < steps[index].targetTemperatureC ? 'MASH_HEATING' : 'MASH_OUT';
}
