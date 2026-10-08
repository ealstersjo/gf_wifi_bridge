import {
  BrewEvent, BrewEventSource, BrewEventType, BrewSession, SessionLiveState,
  Recipe, SessionActualValues, SessionObservation, SessionStore, TELEMETRY_INTERVAL_MS, TelemetrySample,
  calculateEtaSeconds, calculateHeatingRate,
} from './BrewSession';
import {calculateSessionStatistics, detectPhase} from './BrewAnalytics';

type EventExpectation = {type: BrewEventType; expected: unknown; expiresAt: number; source: BrewEventSource};

export class BrewSessionManager {
  private active: BrewSession | null = null;
  private samples: TelemetrySample[] = [];
  private latestEvent: BrewEvent | null = null;
  private recentEvents: BrewEvent[] = [];
  private previous: SessionObservation | null = null;
  private lastSampleAt = 0;
  private revision = 0;
  private expectation: EventExpectation | null = null;
  private reachedTarget: number | null = null;
  private targetCandidateSince: number | null = null;
  private listener: ((state: SessionLiveState) => void) | null = null;

  constructor(private readonly store: SessionStore) {}

  setListener(listener: (state: SessionLiveState) => void): void {
    this.listener = listener;
  }

  async initialize(): Promise<void> {
    this.active = await this.store.getActiveSession();
    if (this.active) {
      const since = new Date(Date.now() - 3 * 60_000).toISOString();
      this.samples = await this.store.listTelemetry(this.active.id, since, 100);
      const events = await this.store.listEvents(this.active.id, 1000);
      this.recentEvents = events;
      this.latestEvent = events[0] ?? null;
    }
    this.emit();
  }

  snapshot(observation?: SessionObservation): SessionLiveState {
    const rate = this.active && observation && !observation.stale
      ? calculateHeatingRate(this.samples)
      : null;
    return {
      active: this.active,
      heatingRateCPerMinute: rate,
      etaSeconds: observation && this.active ? calculateEtaSeconds(observation, rate) : null,
      latestTelemetry: this.samples.at(-1) ?? null,
      latestEvent: this.latestEvent,
      revision: this.revision,
      currentPhase: detectPhase(this.active, this.samples, this.recentEvents),
    };
  }

  async start(name: string | null, observation: SessionObservation, now = new Date(), recipe: Recipe | null = null): Promise<BrewSession> {
    if (this.active) throw new Error('A brew session is already active');
    const cleanName = name?.trim() || null;
    if (cleanName && cleanName.length > 120) throw new Error('Session name must be 120 characters or fewer');
    const recipeSnapshot = recipe ? JSON.parse(JSON.stringify(recipe)) as Recipe : null;
    this.active = await this.store.createSession(cleanName, now.toISOString(), recipeSnapshot?.id ?? null, recipeSnapshot);
    this.previous = observation;
    this.samples = [];
    this.recentEvents = [];
    this.lastSampleAt = 0;
    this.reachedTarget = null;
    await this.addEvent('SESSION_STARTED', 'SYSTEM', cleanName ? {name: cleanName} : {}, now);
    if (recipe) {
      await this.addEvent('RECIPE_SELECTED', 'WEB', {recipeId: recipe.id, recipeName: recipe.name}, now);
      const firstStep = recipe.mashSteps[0];
      if (firstStep) await this.addEvent('MASH_STEP_STARTED', 'SYSTEM', {index: 0, targetTemperatureC: firstStep.targetTemperatureC, inferred: true}, now);
    }
    await this.sampleIfDue(observation, now, true);
    this.emit(observation);
    return this.active;
  }

  async end(id: string, now = new Date()): Promise<BrewSession> {
    if (!this.active || this.active.id !== id) throw new Error('Active brew session not found');
    await this.addEvent('SESSION_ENDED', 'SYSTEM', {}, now);
    const ended = await this.store.endSession(id, now.toISOString());
    this.active = null;
    this.samples = [];
    this.recentEvents = [];
    this.previous = null;
    this.expectation = null;
    this.revision += 1;
    this.emit();
    return ended;
  }

  expect(type: BrewEventType, expected: unknown, source: BrewEventSource = 'WEB'): void {
    if (this.active) this.expectation = {type, expected, source, expiresAt: Date.now() + 15_000};
  }

  cancelExpectation(type: BrewEventType): void {
    if (this.expectation?.type === type) this.expectation = null;
  }

  async observe(observation: SessionObservation, now = new Date()): Promise<void> {
    if (!this.active) {
      this.previous = observation;
      return;
    }
    await this.recordTransitions(observation, now);
    await this.sampleIfDue(observation, now);
    await this.detectTargetReached(observation, now);
    this.previous = observation;
    this.emit(observation);
  }

  async listSessions(): Promise<BrewSession[]> { return this.store.listSessions(); }
  async getSession(id: string): Promise<BrewSession | null> { return this.store.getSession(id); }
  async telemetry(id: string, since: string | null, limit: number): Promise<TelemetrySample[]> {
    return this.store.listTelemetry(id, since, Math.min(Math.max(limit, 1), 20_000));
  }
  async events(id: string, limit: number): Promise<BrewEvent[]> {
    return this.store.listEvents(id, Math.min(Math.max(limit, 1), 1000));
  }

  async summary(id: string): Promise<ReturnType<typeof calculateSessionStatistics> | null> {
    const session = await this.store.getSession(id);
    if (!session) return null;
    const [samples, events] = await Promise.all([this.store.listTelemetry(id, null, 20_000), this.store.listEvents(id, 10_000)]);
    return calculateSessionStatistics(session, samples, events);
  }

  async performance(): Promise<{
    heatToMash: Array<{volumeL: number | null; averageRateCPerMinute: number; averageTimeSeconds: number; sampleCount: number}>;
    mashToBoil: Array<{volumeL: number | null; averageRateCPerMinute: number; averageTimeSeconds: number; sampleCount: number}>;
  }> {
    const completed = (await this.store.listSessions()).filter(session => session.status === 'COMPLETED');
    const summaries = (await Promise.all(completed.map(session => this.summary(session.id)))).filter(Boolean);
    const aggregate = (key: 'heatToFirstMashTarget' | 'mashToBoil') => {
      const values = summaries.map(summary => summary?.[key]).filter((value): value is NonNullable<typeof value> => value !== null && value !== undefined && value.averageRateCPerMinute > 0);
      const groups = new Map<string, typeof values>();
      values.forEach(value => {
        const bucket = value.volumeL === null ? 'unknown' : `${Math.floor(value.volumeL / 4) * 4}-${Math.floor(value.volumeL / 4) * 4 + 4}L`;
        groups.set(bucket, [...(groups.get(bucket) ?? []), value]);
      });
      return [...groups.entries()].map(([bucket, rows]) => ({
        volumeL: bucket === 'unknown' ? null : Number(bucket.split('-')[0]),
        averageRateCPerMinute: rows.reduce((sum, row) => sum + row.averageRateCPerMinute, 0) / rows.length,
        averageTimeSeconds: rows.reduce((sum, row) => sum + row.elapsedSeconds, 0) / rows.length,
        sampleCount: rows.length,
      }));
    };
    return {heatToMash: aggregate('heatToFirstMashTarget'), mashToBoil: aggregate('mashToBoil')};
  }

  async recipes(): Promise<Recipe[]> { return this.store.listRecipes?.() ?? []; }
  async recipe(id: string): Promise<Recipe | null> { return this.store.getRecipe?.(id) ?? null; }
  async saveRecipe(recipe: Parameters<NonNullable<SessionStore['saveRecipe']>>[0]): Promise<Recipe> {
    if (!this.store.saveRecipe) throw new Error('Recipe storage unavailable');
    return this.store.saveRecipe(recipe);
  }
  async duplicateRecipe(id: string, name?: string): Promise<Recipe> {
    if (!this.store.duplicateRecipe) throw new Error('Recipe storage unavailable');
    return this.store.duplicateRecipe(id, name);
  }
  async deleteRecipe(id: string): Promise<void> {
    if (!this.store.deleteRecipe) throw new Error('Recipe storage unavailable');
    return this.store.deleteRecipe(id);
  }
  async deleteSession(id: string): Promise<void> {
    if (!this.store.deleteSession) throw new Error('Session storage unavailable');
    return this.store.deleteSession(id);
  }
  async updateActualValues(id: string, actual: SessionActualValues, now = new Date()): Promise<BrewSession> {
    if (!this.store.updateActualValues) throw new Error('Actual-value storage unavailable');
    const updated = await this.store.updateActualValues(id, actual);
    if (this.active?.id === id) await this.addEvent('ACTUAL_VOLUME_RECORDED', 'WEB', {...actual}, now);
    return updated;
  }
  async markPhase(id: string, phase: string, now = new Date()): Promise<BrewEvent> {
    return this.store.insertEvent({sessionId: id, timestamp: now.toISOString(), type: 'MANUAL_PHASE_MARKER', source: 'WEB', payload: {phase, manual: true}});
  }

  private async sampleIfDue(observation: SessionObservation, now: Date, force = false): Promise<void> {
    if (!this.active || observation.stale || observation.connectionState !== 'CONNECTED' ||
        observation.state.actualTemperatureC === null) return;
    if (!force && now.getTime() - this.lastSampleAt < TELEMETRY_INTERVAL_MS) return;
    const sample = await this.store.insertTelemetry({
      sessionId: this.active.id,
      timestamp: now.toISOString(),
      actualTemperatureC: observation.state.actualTemperatureC,
      targetTemperatureC: observation.state.targetTemperatureC,
      heaterEnabled: observation.state.heaterOn,
      heaterOutputPercent: observation.state.heaterPowerPercent,
      heaterControlMode: observation.state.heaterControlMode,
      pumpEnabled: observation.state.pumpOn,
      rssi: observation.rssi,
    });
    this.lastSampleAt = now.getTime();
    this.samples.push(sample);
    this.samples = this.samples.filter(item => now.getTime() - Date.parse(item.timestamp) <= 3 * 60_000);
    this.revision += 1;
  }

  private source(type: BrewEventType, expected: unknown): BrewEventSource {
    if (this.expectation && this.expectation.expiresAt >= Date.now() &&
        this.expectation.type === type && Object.is(this.expectation.expected, expected)) {
      const source = this.expectation.source;
      this.expectation = null;
      return source;
    }
    return 'G30';
  }

  private async recordTransitions(current: SessionObservation, now: Date): Promise<void> {
    const previous = this.previous;
    if (!previous) return;
    if (previous.connectionState !== 'CONNECTED' && current.connectionState === 'CONNECTED')
      await this.addEvent('G30_CONNECTED', 'SYSTEM', {}, now);
    if (previous.connectionState === 'CONNECTED' && current.connectionState !== 'CONNECTED')
      await this.addEvent('G30_DISCONNECTED', 'SYSTEM', {}, now);
    if (current.stale || current.connectionState !== 'CONNECTED') return;
    const before = previous.state;
    const after = current.state;
    if (before.targetTemperatureC !== null && after.targetTemperatureC !== null && before.targetTemperatureC !== after.targetTemperatureC) {
      if (this.reachedTarget === null || Math.abs(this.reachedTarget - after.targetTemperatureC) >= 0.5) {
        this.reachedTarget = null;
      }
      this.targetCandidateSince = null;
      await this.addEvent('TARGET_CHANGED', this.source('TARGET_CHANGED', after.targetTemperatureC), {old: before.targetTemperatureC, new: after.targetTemperatureC}, now);
      const stepIndex = this.active?.recipeSnapshot?.mashSteps.findIndex(step => Math.abs(step.targetTemperatureC - after.targetTemperatureC!) <= 0.3) ?? -1;
      if (stepIndex >= 0) await this.addEvent('MASH_STEP_STARTED', 'G30', {index: stepIndex, targetTemperatureC: after.targetTemperatureC, inferred: true}, now);
    }
    await this.booleanTransition(before.heaterOn, after.heaterOn, 'HEATER_ON', 'HEATER_OFF', now);
    await this.booleanTransition(before.pumpOn, after.pumpOn, 'PUMP_ON', 'PUMP_OFF', now);
    if (before.delayedHeat !== true && after.delayedHeat !== true) {
      await this.timerTransitions(before.timerState, after.timerState, now);
    }
    await this.delayedTransitions(before.delayedHeatState, after.delayedHeatState, now);
  }

  private async booleanTransition(before: boolean | null, after: boolean | null, on: BrewEventType, off: BrewEventType, now: Date): Promise<void> {
    if (before === null || after === null || before === after) return;
    const type = after ? on : off;
    await this.addEvent(type, this.source(type, after), {enabled: after}, now);
  }

  private async timerTransitions(before: string, after: string, now: Date): Promise<void> {
    if (before === after || after === 'UNKNOWN') return;
    let type: BrewEventType | null = null;
    if (after === 'RUNNING') type = before === 'PAUSED' ? 'TIMER_RESUMED' : 'TIMER_STARTED';
    else if (after === 'PAUSED') type = 'TIMER_PAUSED';
    else if (after === 'FINISHED') type = 'TIMER_COMPLETED';
    else if (after === 'IDLE' && ['RUNNING', 'PAUSED'].includes(before)) type = 'TIMER_CANCELLED';
    if (type) await this.addEvent(type, this.source(type, after), {old: before, new: after}, now);
  }

  private async delayedTransitions(before: string, after: string, now: Date): Promise<void> {
    if (before === after || after === 'UNKNOWN') return;
    let type: BrewEventType | null = null;
    if (after === 'ARMED') type = before === 'PAUSED' ? 'DELAYED_HEAT_RESUMED' : 'DELAYED_HEAT_STARTED';
    else if (after === 'PAUSED') type = 'DELAYED_HEAT_PAUSED';
    else if (after === 'INACTIVE' && before !== 'STARTED') type = 'DELAYED_HEAT_CANCELLED';
    if (type) await this.addEvent(type, this.source(type, after), {old: before, new: after}, now);
  }

  private async detectTargetReached(observation: SessionObservation, now: Date): Promise<void> {
    const actual = observation.state.actualTemperatureC;
    const target = observation.state.targetTemperatureC;
    if (observation.stale || actual === null || target === null) { this.targetCandidateSince = null; return; }
    if (this.reachedTarget !== null && Math.abs(this.reachedTarget - target) < 0.5) return;
    if (actual < target - 0.2) { this.targetCandidateSince = null; return; }
    if (this.targetCandidateSince === null) { this.targetCandidateSince = now.getTime(); return; }
    if (now.getTime() - this.targetCandidateSince < 5_000) return;
    await this.addEvent('TARGET_REACHED', 'SYSTEM', {targetTemperatureC: target, actualTemperatureC: actual}, now);
    const stepIndex = this.active?.recipeSnapshot?.mashSteps.findIndex(step => Math.abs(step.targetTemperatureC - target) <= 0.3) ?? -1;
    if (stepIndex >= 0) await this.addEvent('MASH_STEP_REACHED', 'SYSTEM', {index: stepIndex, targetTemperatureC: target, actualTemperatureC: actual, inferred: true}, now);
    this.reachedTarget = target;
    this.targetCandidateSince = null;
  }

  private async addEvent(type: BrewEventType, source: BrewEventSource, payload: Record<string, unknown>, now: Date): Promise<void> {
    if (!this.active) return;
    this.latestEvent = await this.store.insertEvent({sessionId: this.active.id, timestamp: now.toISOString(), type, source, payload});
    this.recentEvents.unshift(this.latestEvent);
    this.revision += 1;
  }

  private emit(observation?: SessionObservation): void { this.listener?.(this.snapshot(observation)); }
}
