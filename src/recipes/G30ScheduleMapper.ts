import {Recipe} from '../session/BrewSession';

/** Pure projection only. It performs no BLE/API writes and is intentionally not wired to commands. */
export interface G30BrewSchedule { mashSteps: Array<{temperatureC: number; durationMinutes: number}>; boilDurationMinutes: number | null; }
export function mapRecipeToG30Schedule(recipe: Recipe): G30BrewSchedule {
  return {mashSteps: recipe.mashSteps.filter(step => Number.isFinite(step.targetTemperatureC) && Number.isFinite(step.durationMinutes)).map(step => ({temperatureC: step.targetTemperatureC, durationMinutes: step.durationMinutes})), boilDurationMinutes: recipe.boilDurationMinutes ?? null};
}
