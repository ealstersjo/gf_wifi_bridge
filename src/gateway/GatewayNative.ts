import {
  EmitterSubscription,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';

import {GatewayHttpRequest} from './GatewayApi';
import {BrewEvent, BrewSession, Recipe, SessionActualValues, SessionStore, TelemetrySample} from '../session/BrewSession';

export interface NativeGatewayStatus {
  running: boolean;
  port: number;
  localIp: string | null;
  webSocketClients: number;
  serviceRunning: boolean;
  serviceStartedAt: number;
}

export interface NativeGatewayServiceStatus { running: boolean; startedAt: number; }

export interface NativeGatewayLog {
  category: 'GATEWAY' | 'HTTP' | 'WS';
  message: string;
}

interface GatewayServerModule {
  start(port: number): Promise<NativeGatewayStatus>;
  stop(): Promise<void>;
  updateSnapshot(snapshotJson: string): void;
  respond(requestId: string, statusCode: number, bodyJson: string): void;
  getStatus(): Promise<NativeGatewayStatus>;
  startGatewayService(): Promise<NativeGatewayServiceStatus>;
  stopGatewayService(): Promise<void>;
  getGatewayServiceStatus(): Promise<NativeGatewayServiceStatus>;
  sessionStore(operation: string, payloadJson: string): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const server = NativeModules.GatewayServer as GatewayServerModule;
const emitter = new NativeEventEmitter(NativeModules.GatewayServer);

async function storeCall<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await server.sessionStore(operation, JSON.stringify(payload));
  return JSON.parse(result) as T;
}

export const NativeSessionStore: SessionStore = {
  getActiveSession: () => storeCall<BrewSession | null>('getActive'),
  createSession: (name, startedAt, recipeId = null, recipeSnapshot = null) => storeCall<BrewSession>('createSession', {name, startedAt, recipeId, recipeSnapshot}),
  endSession: (id, endedAt) => storeCall<BrewSession>('endSession', {id, endedAt}),
  listSessions: () => storeCall<BrewSession[]>('listSessions'),
  getSession: id => storeCall<BrewSession | null>('getSession', {id}),
  insertTelemetry: sample => storeCall<TelemetrySample>('insertTelemetry', sample),
  listTelemetry: (id, since, limit) => storeCall<TelemetrySample[]>('listTelemetry', {id, since, limit}),
  insertEvent: event => storeCall<BrewEvent>('insertEvent', event),
  listEvents: (id, limit) => storeCall<BrewEvent[]>('listEvents', {id, limit}),
  listRecipes: () => storeCall<Recipe[]>('listRecipes'),
  getRecipe: id => storeCall<Recipe | null>('getRecipe', {id}),
  saveRecipe: recipe => storeCall<Recipe>('saveRecipe', recipe),
  duplicateRecipe: (id, name) => storeCall<Recipe>('duplicateRecipe', {id, name}),
  deleteRecipe: id => storeCall<void>('deleteRecipe', {id}),
  deleteSession: id => storeCall<void>('deleteSession', {id}),
  updateActualValues: (id, actual: SessionActualValues) => storeCall<BrewSession>('updateActualValues', {id, actual}),
};

export const GatewayNative = {
  start: (port = 8080): Promise<NativeGatewayStatus> => server.start(port),
  stop: (): Promise<void> => server.stop(),
  getStatus: (): Promise<NativeGatewayStatus> => server.getStatus(),
  startGatewayService: (): Promise<NativeGatewayServiceStatus> => server.startGatewayService(),
  stopGatewayService: (): Promise<void> => server.stopGatewayService(),
  getGatewayServiceStatus: (): Promise<NativeGatewayServiceStatus> => server.getGatewayServiceStatus(),
  updateSnapshot: (snapshot: Record<string, unknown>): void =>
    server.updateSnapshot(JSON.stringify(snapshot)),
  respond: (
    requestId: string,
    statusCode: number,
    body: unknown,
  ): void => server.respond(requestId, statusCode, JSON.stringify(body)),
  onRequest: (
    listener: (request: GatewayHttpRequest) => void,
  ): EmitterSubscription =>
    emitter.addListener('GatewayHttpRequest', request =>
      listener(request as unknown as GatewayHttpRequest),
    ),
  onLog: (
    listener: (event: NativeGatewayLog) => void,
  ): EmitterSubscription =>
    emitter.addListener('GatewayLog', event =>
      listener(event as unknown as NativeGatewayLog),
    ),
  onClientCount: (
    listener: (count: number) => void,
  ): EmitterSubscription =>
    emitter.addListener('GatewayClientCount', count =>
      listener(count as unknown as number),
    ),
  onServiceCommand: (
    listener: (command: 'START' | 'STOP') => void,
  ): EmitterSubscription =>
    emitter.addListener('GatewayServiceCommand', command =>
      listener(command as 'START' | 'STOP'),
    ),
};
