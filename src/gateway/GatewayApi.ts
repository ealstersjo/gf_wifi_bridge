import {ConnectionState, DebugEvent} from '../ble/GrainfatherConnection';
import {CommandStatus} from '../ble/SerializedCommandExecutor';
import {GrainfatherState, HeaterControlMode} from '../protocol/GrainfatherState';
import {BrewEvent, BrewSession, Recipe, SessionActualValues, SessionLiveState, SessionStatistics, TelemetrySample} from '../session/BrewSession';
import {mapBrewfatherBatch, mapBrewfatherBatchSummary} from '../recipes/BrewfatherBatchMapper';

export const GATEWAY_VERSION = '0.1.0';
export const G30_STALE_AFTER_MS = 8_000;

export interface GatewayInfo {
  port: number;
  localIp: string | null;
  webSocketClients: number;
}

export interface GatewayRuntimeState {
  connectionState: ConnectionState;
  connectionDetail?: string;
  grainfatherState: GrainfatherState;
  commandStatus: CommandStatus;
  rssi: number | null;
  gatewayInfo: GatewayInfo;
  session?: SessionLiveState;
  debugEvents?: DebugEvent[];
}

export interface GatewayDomain {
  scanAndConnect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setTargetTemperature: (temperatureC: number) => Promise<void>;
  setHeater: (enabled: boolean) => Promise<void>;
  setHeaterControlMode: (mode: Exclude<HeaterControlMode, 'UNKNOWN'>) => Promise<void>;
  setPump: (enabled: boolean) => Promise<void>;
  startTimer: (durationSeconds: number) => Promise<void>;
  setTimerPaused: (paused: boolean) => Promise<void>;
  cancelTimer: () => Promise<void>;
  startDelayedHeat: (durationSeconds: number) => Promise<void>;
  setDelayedHeatPaused: (paused: boolean) => Promise<void>;
  cancelDelayedHeat: () => Promise<void>;
}

export interface GatewayHttpRequest {
  id: string;
  method: string;
  path: string;
  body: string;
}

export interface GatewayHttpResponse {
  statusCode: number;
  body: unknown;
}

export interface SessionApiDomain {
  start(name: string | null, recipeId?: string | null, recipe?: Recipe | null, brewfatherBatchId?: string | null): Promise<BrewSession>;
  end(id: string): Promise<BrewSession>;
  list(): Promise<BrewSession[]>;
  get(id: string): Promise<BrewSession | null>;
  telemetry(id: string, since: string | null, limit: number): Promise<TelemetrySample[]>;
  events(id: string, limit: number): Promise<BrewEvent[]>;
  summary?(id: string): Promise<SessionStatistics | null>;
  recipes?(): Promise<Recipe[]>;
  recipe?(id: string): Promise<Recipe | null>;
  saveRecipe?(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Recipe, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Recipe>;
  duplicateRecipe?(id: string, name?: string): Promise<Recipe>;
  deleteRecipe?(id: string): Promise<void>;
  deleteSession?(id: string): Promise<void>;
  updateActualValues?(id: string, actual: SessionActualValues): Promise<BrewSession>;
  markPhase?(id: string, phase: string): Promise<BrewEvent>;
  performance?(): Promise<unknown>;
  listBrewfatherBatches?(): Promise<unknown[]>;
  getBrewfatherBatch?(id: string): Promise<any | null>;
  saveBrewfatherBatch?(batch: unknown): Promise<unknown>;
}

export interface BrewfatherDomain {
  status(): Promise<{configured: boolean}>;
  test(userId: string, apiKey: string): Promise<{connected: boolean}>;
  save(userId: string, apiKey: string): Promise<{configured: boolean}>;
  clear(): Promise<void>;
  get(path: string): Promise<unknown>;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function serializeGatewayState(
  runtime: GatewayRuntimeState,
  now = new Date(),
): Record<string, unknown> {
  const state = runtime.grainfatherState;
  const lastUpdateMs = state.lastUpdated?.getTime() ?? 0;
  const stale =
    runtime.connectionState !== 'CONNECTED' ||
    !lastUpdateMs ||
    now.getTime() - lastUpdateMs > G30_STALE_AFTER_MS;
  const snapshot: Record<string, unknown> = {
    gateway: {
      status: 'online',
      version: GATEWAY_VERSION,
      port: runtime.gatewayInfo.port,
      localIp: runtime.gatewayInfo.localIp,
      webSocketClients: runtime.gatewayInfo.webSocketClients,
    },
    grainfather: {
      connectionState: runtime.connectionState,
      connectionDetail: runtime.connectionDetail ?? null,
      stale,
      actualTemperatureC: state.actualTemperatureC,
      targetTemperatureC: state.targetTemperatureC,
      heater: {
        enabled: state.heaterOn,
        powerPercent: state.heaterPowerPercent,
        manualPowerMode: state.manualPowerMode,
        controlMode: state.heaterControlMode,
        manualPowerPercent: state.manualPowerMode === true ? state.heaterPowerPercent : null,
      },
      pump: {enabled: state.pumpOn},
      process: {
        autoMode: state.autoMode,
        stageRamp: state.stageRamp,
        interactionMode: state.interactionMode,
        interactionCode: state.interactionCode,
        stageNumber: state.stageNumber,
      },
      timer: {
        state: state.timerState,
        active: state.timerActive,
        paused: state.timerPaused,
        durationSeconds: state.timerDurationSeconds,
        remainingSeconds: state.timerRemainingSeconds,
        elapsedSeconds: state.timerElapsedSeconds,
        lastUpdate: iso(state.timerLastUpdated),
      },
      delayedHeat: {
        state: state.delayedHeatState,
        active: state.delayedHeat,
        remainingSeconds:
          state.delayedHeat === true ? state.timerRemainingSeconds : null,
        targetTemperatureC: state.targetTemperatureC,
      },
      command: runtime.commandStatus,
      rssi: runtime.rssi,
      lastUpdate: iso(state.lastUpdated),
    },
  };
  if (runtime.session) snapshot.session = runtime.session;
  snapshot.debugEvents = (runtime.debugEvents ?? []).map(event => ({
    id: event.id,
    timestamp: event.timestamp.toISOString(),
    category: event.category,
    message: event.message,
    source: event.source ?? 'G30',
    subsystem: event.subsystem ?? event.category,
    severity: event.severity ?? 'INFO',
    eventType: event.eventType ?? event.category,
    requestId: event.requestId ?? null,
    commandId: event.commandId ?? null,
    details: event.details ?? null,
  }));
  return snapshot;
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {};
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  return body[key];
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
    throw new Error(`${key} must be a finite number`);
  }
  return body[key];
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  if (body[key] == null || body[key] === '') return null;
  return requiredNumber(body, key);
}

function recipePayload(body: Record<string, unknown>, id?: string): Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Recipe, 'id' | 'createdAt' | 'updatedAt'>> {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('name must be a non-empty string');
  if (!Array.isArray(body.mashSteps)) throw new Error('mashSteps must be an array');
  const mashSteps = body.mashSteps.map((step, index) => {
    if (!step || typeof step !== 'object') throw new Error(`mashSteps[${index}] must be an object`);
    const value = step as Record<string, unknown>;
    if (typeof value.name !== 'string' || !value.name.trim()) throw new Error(`mashSteps[${index}].name is required`);
    const targetTemperatureC = requiredNumber(value, 'targetTemperatureC');
    const durationMinutes = requiredNumber(value, 'durationMinutes');
    if (durationMinutes < 0) throw new Error('durationMinutes must be non-negative');
    return {name: value.name.trim(), targetTemperatureC, durationMinutes};
  });
  return {
    id,
    name: body.name.trim(), style: typeof body.style === 'string' ? body.style.trim() || null : null,
    notes: typeof body.notes === 'string' ? body.notes : null,
    plannedBatchVolumeL: optionalNumber(body, 'plannedBatchVolumeL'),
    grainWeightKg: optionalNumber(body, 'grainWeightKg'),
    mashWaterVolumeL: optionalNumber(body, 'mashWaterVolumeL'),
    spargeWaterVolumeL: optionalNumber(body, 'spargeWaterVolumeL'),
    plannedPreBoilVolumeL: optionalNumber(body, 'plannedPreBoilVolumeL'),
    mashSteps,
    boilDurationMinutes: optionalNumber(body, 'boilDurationMinutes'),
    source: typeof body.source === 'string' ? body.source : null,
    sourceRecipeId: typeof body.sourceRecipeId === 'string' ? body.sourceRecipeId : null,
    sourceFormat: typeof body.sourceFormat === 'string' ? body.sourceFormat : null,
    sourceImportedAt: typeof body.sourceImportedAt === 'string' ? body.sourceImportedAt : new Date().toISOString(),
    originalRecipeData: body.originalRecipeData ?? null,
    originalImport: typeof body.originalImport === 'string' ? body.originalImport : null,
    fermentables: Array.isArray(body.fermentables) ? body.fermentables : [],
    hops: Array.isArray(body.hops) ? body.hops : [],
    miscs: Array.isArray(body.miscs) ? body.miscs : [],
    yeasts: Array.isArray(body.yeasts) ? body.yeasts : [],
    waterProfile: body.waterProfile && typeof body.waterProfile === 'object' ? body.waterProfile : null,
    equipment: body.equipment && typeof body.equipment === 'object' ? body.equipment : null,
    mashProfile: body.mashProfile && typeof body.mashProfile === 'object' ? body.mashProfile : null,
    fermentation: Array.isArray(body.fermentation) ? body.fermentation : [],
    og: optionalNumber(body, 'og'), fg: optionalNumber(body, 'fg'), abvPercent: optionalNumber(body, 'abvPercent'),
    ibu: optionalNumber(body, 'ibu'), color: optionalNumber(body, 'color'), efficiencyPercent: optionalNumber(body, 'efficiencyPercent'),
    plannedBoilVolumeL: optionalNumber(body, 'plannedBoilVolumeL'),
  };
}

function mapError(error: unknown): GatewayHttpResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (/credentials|scope rejected|Unauthorized|HTTP 401|HTTP 403/i.test(message)) return {statusCode: 401, body: {error: 'brewfather_authentication_failed', message}};
  if (/rate limit|HTTP 429/i.test(message)) return {statusCode: 429, body: {error: 'brewfather_rate_limited', message}};
  if (/Brewfather.*(timeout|unavailable)|HTTP 5\d\d/i.test(message)) return {statusCode: 504, body: {error: 'brewfather_unavailable', message}};
  if (/Brewfather batch not found|HTTP 404/i.test(message)) return {statusCode: 404, body: {error: 'brewfather_batch_not_found', message}};
  if (/SESSION_ACTIVE/i.test(message)) return {statusCode: 409, body: {error: 'SESSION_ACTIVE', message: message.replace(/^SESSION_ACTIVE:\s*/, '')}};
  if (/session not found/i.test(message)) return {statusCode: 404, body: {error: 'SESSION_NOT_FOUND', message}};
  if (/recipe not found/i.test(message)) return {statusCode: 404, body: {error: 'RECIPE_NOT_FOUND', message}};
  if (/not connected|not connected and ready/i.test(message)) {
    return {statusCode: 409, body: {error: 'grainfather_disconnected', message}};
  }
  if (/already pending|Command already pending/i.test(message)) {
    return {statusCode: 409, body: {error: 'command_pending', message}};
  }
  if (/No Grainfather found/i.test(message)) {
    return {statusCode: 404, body: {error: 'grainfather_not_found', message}};
  }
  if (/Timed out/i.test(message)) {
    return {statusCode: 504, body: {error: 'command_timeout', message}};
  }
  if (/temperature/i.test(message)) {
    return {statusCode: 400, body: {error: 'invalid_target_temperature', message}};
  }
  if (/duration|minutes|JSON|must be/i.test(message)) {
    return {statusCode: 400, body: {error: 'invalid_request', message}};
  }
  return {statusCode: 409, body: {error: 'operation_failed', message}};
}

export class GatewayApi {
  private readonly startedAt = Date.now();

  constructor(
    private readonly getRuntime: () => GatewayRuntimeState,
    private readonly domain: GatewayDomain,
    private readonly sessions?: SessionApiDomain,
    private readonly brewfather?: BrewfatherDomain,
  ) {}

  async handle(request: GatewayHttpRequest): Promise<GatewayHttpResponse> {
    try {
      const [path, queryString = ''] = request.path.split('?', 2);
      const query = Object.fromEntries(queryString.split('&').filter(Boolean).map(part => {
        const [key, value = ''] = part.split('=', 2);
        return [decodeURIComponent(key), decodeURIComponent(value)];
      }));
      if (request.method === 'GET' && path === '/api/v1/health') {
        return {
          statusCode: 200,
          body: {
            gateway: 'online',
            version: GATEWAY_VERSION,
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
          },
        };
      }
      if (request.method === 'GET' && path === '/api/v1/diagnostics') {
        const runtime = this.getRuntime();
        return {
          statusCode: 200,
          body: {
            gateway: {
              status: 'online',
              version: GATEWAY_VERSION,
              port: runtime.gatewayInfo.port,
              localIp: runtime.gatewayInfo.localIp,
              webSocketClients: runtime.gatewayInfo.webSocketClients,
            },
            web: {webSocketClients: runtime.gatewayInfo.webSocketClients},
            g30: {
              connectionState: runtime.connectionState,
              connectionDetail: runtime.connectionDetail ?? null,
              rssi: runtime.rssi,
              command: runtime.commandStatus,
            },
            recentErrors: (runtime.debugEvents ?? []).filter(event => event.severity === 'ERROR').slice(0, 20).map(event => ({
              timestamp: event.timestamp.toISOString(), source: event.source ?? 'G30', subsystem: event.subsystem ?? event.category,
              eventType: event.eventType ?? event.category, message: event.message, requestId: event.requestId ?? null,
            })),
          },
        };
      }
      if (request.method === 'GET' && path === '/api/v1/state') {
        return {statusCode: 200, body: serializeGatewayState(this.getRuntime())};
      }
      if (this.brewfather && request.method === 'GET' && path === '/api/v1/brewfather/status') {
        return {statusCode: 200, body: await this.brewfather.status()};
      }
      if (this.brewfather && request.method === 'GET' && path === '/api/v1/brewfather/batches/local') {
        return {statusCode: 200, body: {batches: await this.sessions?.listBrewfatherBatches?.() ?? []}};
      }
      if (this.brewfather && request.method === 'GET' && path === '/api/v1/brewfather/batches') {
        const startAfter = query.startAfter ? `&start_after=${encodeURIComponent(query.startAfter)}` : '';
        const raw = await this.brewfather.get(`/batches?limit=50${startAfter}`);
        const payload = raw as any;
        const rows = Array.isArray(payload) ? payload : payload.batches ?? payload.data ?? payload.items ?? [];
        return {statusCode: 200, body: {batches: rows.map(mapBrewfatherBatchSummary), nextStartAfter: payload.next_start_after ?? payload.nextStartAfter ?? null}};
      }
      const brewfatherBatchMatch = path.match(/^\/api\/v1\/brewfather\/batches\/([^/]+)$/);
      const brewfatherImportMatch = path.match(/^\/api\/v1\/brewfather\/batches\/([^/]+)\/import$/);
      const brewfatherStartMatch = path.match(/^\/api\/v1\/brewfather\/batches\/([^/]+)\/start-session$/);
      if (this.brewfather && request.method === 'GET' && brewfatherBatchMatch) {
        const id = decodeURIComponent(brewfatherBatchMatch[1]);
        const local = await this.sessions?.getBrewfatherBatch?.(id);
        if (query.local === 'true' && local) return {statusCode: 200, body: {batch: local, cached: true}};
        const raw = await this.brewfather.get(`/batches/${encodeURIComponent(id)}`);
        return {statusCode: 200, body: {batch: mapBrewfatherBatch(raw)}};
      }
      if (this.sessions && request.method === 'GET' && path === '/api/v1/recipes') {
        return {statusCode: 200, body: {recipes: await this.sessions.recipes!()}};
      }
      if (this.sessions && request.method === 'GET' && path === '/api/v1/performance') {
        return {statusCode: 200, body: {performance: await this.sessions.performance!()}};
      }
      const recipeMatch = path.match(/^\/api\/v1\/recipes\/([^/]+)$/);
      const duplicateRecipeMatch = path.match(/^\/api\/v1\/recipes\/([^/]+)\/duplicate$/);
      if (this.sessions && request.method === 'GET' && recipeMatch) {
        const recipe = await this.sessions.recipe!(decodeURIComponent(recipeMatch[1]));
        return recipe ? {statusCode: 200, body: {recipe}} : {statusCode: 404, body: {error: 'recipe_not_found'}};
      }
      if (this.sessions && request.method === 'GET' && path === '/api/v1/sessions') {
        return {statusCode: 200, body: {sessions: await this.sessions.list()}};
      }
      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (this.sessions && request.method === 'GET' && sessionMatch) {
        const session = await this.sessions.get(decodeURIComponent(sessionMatch[1]));
        return session ? {statusCode: 200, body: {session}} : {statusCode: 404, body: {error: 'session_not_found'}};
      }
      const telemetryMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/telemetry$/);
      if (this.sessions && request.method === 'GET' && telemetryMatch) {
        const limit = query.limit ? Number(query.limit) : 20_000;
        if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
        if (query.since && !Number.isFinite(Date.parse(query.since))) throw new Error('since must be an ISO timestamp');
        return {statusCode: 200, body: {telemetry: await this.sessions.telemetry(decodeURIComponent(telemetryMatch[1]), query.since || null, limit)}};
      }
      const eventsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/events$/);
      if (this.sessions && request.method === 'GET' && eventsMatch) {
        const limit = query.limit ? Number(query.limit) : 1000;
        if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
        return {statusCode: 200, body: {events: await this.sessions.events(decodeURIComponent(eventsMatch[1]), limit)}};
      }
      const summaryMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/summary$/);
      if (this.sessions && request.method === 'GET' && summaryMatch) {
        const summary = await this.sessions.summary!(decodeURIComponent(summaryMatch[1]));
        return summary ? {statusCode: 200, body: {summary}} : {statusCode: 404, body: {error: 'session_not_found'}};
      }
      if (this.sessions && request.method === 'PUT' && sessionMatch) {
        const body = parseBody(request.body);
        const actual: SessionActualValues = {
          mashWaterVolumeL: optionalNumber(body, 'mashWaterVolumeL'),
          preBoilVolumeL: optionalNumber(body, 'preBoilVolumeL'),
          batchVolumeL: optionalNumber(body, 'batchVolumeL'),
        };
        return {statusCode: 200, body: {session: await this.sessions.updateActualValues!(decodeURIComponent(sessionMatch[1]), actual)}};
      }
      const markerMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/phase-marker$/);
      if (this.sessions && request.method === 'POST' && markerMatch) {
        const body = parseBody(request.body);
        if (typeof body.phase !== 'string' || !body.phase) throw new Error('phase is required');
        return {statusCode: 201, body: {event: await this.sessions.markPhase!(decodeURIComponent(markerMatch[1]), body.phase)}};
      }
      if (this.sessions && request.method === 'DELETE' && recipeMatch) {
        await this.sessions.deleteRecipe!(decodeURIComponent(recipeMatch[1]));
        return {statusCode: 204, body: null};
      }
      if (this.sessions && request.method === 'DELETE' && sessionMatch) {
        await this.sessions.deleteSession!(decodeURIComponent(sessionMatch[1]));
        return {statusCode: 204, body: null};
      }
      if (this.brewfather && request.method === 'DELETE' && path === '/api/v1/brewfather/credentials') {
        await this.brewfather.clear(); return {statusCode: 204, body: null};
      }
      if (request.method !== 'POST') {
        return {statusCode: 404, body: {error: 'not_found'}};
      }

      const body = parseBody(request.body);
      if (this.brewfather && path === '/api/v1/brewfather/test-connection') {
        if (typeof body.userId !== 'string' || typeof body.apiKey !== 'string') throw new Error('Brewfather User ID and API Key are required');
        return {statusCode: 200, body: await this.brewfather.test(body.userId, body.apiKey)};
      }
      if (this.brewfather && path === '/api/v1/brewfather/credentials') {
        if (typeof body.userId !== 'string' || typeof body.apiKey !== 'string') throw new Error('Brewfather User ID and API Key are required');
        return {statusCode: 200, body: await this.brewfather.save(body.userId, body.apiKey)};
      }
      if (this.brewfather && path === '/api/v1/brewfather/batches' && request.method === 'POST') {
        return {statusCode: 200, body: {batches: await this.sessions?.listBrewfatherBatches?.() ?? []}};
      }
      if (this.brewfather && request.method === 'POST' && brewfatherImportMatch) {
        const id = decodeURIComponent(brewfatherImportMatch[1]);
        const raw = await this.brewfather.get(`/batches/${encodeURIComponent(id)}`);
        const mapped = mapBrewfatherBatch(raw);
        const cached = await this.sessions?.saveBrewfatherBatch?.(mapped);
        const recipe = await this.sessions?.saveRecipe?.(mapped.recipe);
        return {statusCode: 201, body: {batch: cached ?? mapped, recipe}};
      }
      if (this.brewfather && request.method === 'POST' && brewfatherStartMatch) {
        const id = decodeURIComponent(brewfatherStartMatch[1]);
        const cached = await this.sessions?.getBrewfatherBatch?.(id) as any;
        if (!cached) throw new Error('Brewfather batch must be imported before starting a local session');
        const recipe = cached.recipe as Recipe;
        const name = typeof body.name === 'string' ? body.name : cached.name;
        return {statusCode: 201, body: {session: await this.sessions?.start(name, null, recipe, id)}};
      }
      if (this.sessions && path === '/api/v1/recipes') {
        return {statusCode: 201, body: {recipe: await this.sessions.saveRecipe!(recipePayload(body))}};
      }
      if (this.sessions && duplicateRecipeMatch) {
        return {statusCode: 201, body: {recipe: await this.sessions.duplicateRecipe!(decodeURIComponent(duplicateRecipeMatch[1]), typeof body.name === 'string' ? body.name : undefined)}};
      }
      if (this.sessions && recipeMatch) {
        return {statusCode: 200, body: {recipe: await this.sessions.saveRecipe!(recipePayload(body, decodeURIComponent(recipeMatch[1])))}};
      }
      if (this.sessions && path === '/api/v1/sessions') {
        const name = body.name == null ? null : body.name;
        if (name !== null && typeof name !== 'string') throw new Error('name must be a string');
        const recipeId = body.recipeId == null ? null : body.recipeId;
        if (recipeId !== null && typeof recipeId !== 'string') throw new Error('recipeId must be a string');
        return {statusCode: 201, body: {session: recipeId === null ? await this.sessions.start(name) : await this.sessions.start(name, recipeId)}};
      }
      const endMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/end$/);
      if (this.sessions && endMatch) {
        return {statusCode: 200, body: {session: await this.sessions.end(decodeURIComponent(endMatch[1]))}};
      }
      switch (path) {
        case '/api/v1/grainfather/connect':
          await this.domain.scanAndConnect();
          break;
        case '/api/v1/grainfather/disconnect':
          await this.domain.disconnect();
          break;
        case '/api/v1/target':
          await this.domain.setTargetTemperature(requiredNumber(body, 'temperatureC'));
          break;
        case '/api/v1/heater':
          await this.domain.setHeater(requiredBoolean(body, 'enabled'));
          break;
        case '/api/v1/heater/mode': {
          const mode = body.mode;
          if (mode !== 'TEMPERATURE' && mode !== 'MANUAL_POWER') throw new Error('mode must be TEMPERATURE or MANUAL_POWER');
          await this.domain.setHeaterControlMode(mode);
          break;
        }
        case '/api/v1/pump':
          await this.domain.setPump(requiredBoolean(body, 'enabled'));
          break;
        case '/api/v1/timer/start':
          await this.domain.startTimer(requiredNumber(body, 'durationSeconds'));
          break;
        case '/api/v1/timer/pause':
          await this.domain.setTimerPaused(true);
          break;
        case '/api/v1/timer/resume':
          await this.domain.setTimerPaused(false);
          break;
        case '/api/v1/timer/cancel':
          await this.domain.cancelTimer();
          break;
        case '/api/v1/delayed-heat/start':
          await this.domain.startDelayedHeat(requiredNumber(body, 'durationSeconds'));
          break;
        case '/api/v1/delayed-heat/pause':
          await this.domain.setDelayedHeatPaused(true);
          break;
        case '/api/v1/delayed-heat/resume':
          await this.domain.setDelayedHeatPaused(false);
          break;
        case '/api/v1/delayed-heat/cancel':
          await this.domain.cancelDelayedHeat();
          break;
        default:
          return {statusCode: 404, body: {error: 'not_found'}};
      }
      return {statusCode: 200, body: {status: 'confirmed'}};
    } catch (error) {
      return mapError(error);
    }
  }
}
