import {calculateSessionStatistics, detectPhase, targetReachedAt, telemetryCoverage} from '../BrewAnalytics';
import {BrewEvent, BrewSession, TelemetrySample} from '../BrewSession';

const samples: TelemetrySample[] = Array.from({length: 13}, (_, index) => ({
  id: index + 1,
  sessionId: 's1',
  timestamp: new Date(1_000_000 + index * 5_000).toISOString(),
  actualTemperatureC: index < 6 ? 20 + index * 7.8 : 67 + (index % 2 ? 0.2 : -0.1),
  targetTemperatureC: 67,
  heaterEnabled: true,
  heaterOutputPercent: index < 6 ? 100 : 30, heaterControlMode: 'TEMPERATURE',
  pumpEnabled: index % 2 === 0,
  rssi: -50,
}));

const session: BrewSession = {
  id: 's1', name: 'Test', startedAt: samples[0].timestamp, endedAt: samples.at(-1)!.timestamp, status: 'COMPLETED',
  recipeId: 'r1', recipeSnapshot: {id: 'r1', name: 'Test', style: null, notes: null, plannedBatchVolumeL: 10, grainWeightKg: 2, mashWaterVolumeL: 12, spargeWaterVolumeL: null, plannedPreBoilVolumeL: 11, mashSteps: [{name: 'Mash', targetTemperatureC: 67, durationMinutes: 60}], boilDurationMinutes: 60, createdAt: samples[0].timestamp, updatedAt: samples[0].timestamp},
};

describe('BrewAnalytics', () => {
  it('requires a tolerance and stability window for target reached', () => {
    expect(targetReachedAt(samples, 67)).not.toBeNull();
    expect(targetReachedAt(samples.map(sample => ({...sample, actualTemperatureC: 66.5})), 67)).toBeNull();
  });

  it('calculates coverage and meaningful mash statistics', () => {
    expect(telemetryCoverage(samples)).toBe(100);
    const summary = calculateSessionStatistics(session, samples, []);
    expect(summary.telemetrySampleCount).toBe(13);
    expect(summary.heatToFirstMashTarget?.averageRateCPerMinute).toBeGreaterThan(0);
    expect(summary.mashSteps[0].averageTemperatureC).toBeCloseTo(67, 0);
    expect(summary.mashSteps[0].pumpOnPercent).toBeGreaterThan(0);
  });

  it('keeps ambiguous phase unknown and recognizes a stable mash rest', () => {
    expect(detectPhase(null, samples, [])).toBe('UNKNOWN');
    expect(detectPhase(session, samples, [])).toBe('MASH_REST');
    const boilEvent: BrewEvent = {id: 1, sessionId: 's1', timestamp: samples.at(-1)!.timestamp, type: 'BOIL_STARTED', source: 'WEB', payload: {manual: true}};
    expect(detectPhase(session, samples, [boilEvent])).toBe('BOIL');
  });
});
