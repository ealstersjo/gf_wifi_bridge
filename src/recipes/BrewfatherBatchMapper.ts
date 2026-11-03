import {Fermentable, HopAddition, MashStep, MiscAddition, Recipe, YeastEntry} from '../session/BrewSession';

export interface BrewfatherBatchSummary {
  id: string;
  batchNo: string | number | null;
  name: string | null;
  recipeName: string | null;
  status: string | null;
  brewDate: string | null;
  style: string | null;
  batchVolumeL: number | null;
}

export interface BrewfatherBatch extends BrewfatherBatchSummary {
  recipeId: string | null;
  importedAt?: string;
  lastSyncedAt?: string;
  recipe: Recipe;
  originalBatchJson: unknown;
}

const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const first = (source: Record<string, any>, keys: string[]): any => keys.map(key => source[key]).find(value => value !== undefined && value !== null && value !== '');
const text = (value: unknown): string | null => value == null ? null : String(value).trim() || null;
const num = (value: unknown): number | null => { const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace(',', '.')); return Number.isFinite(parsed) ? parsed : null; };
const arr = (value: unknown): any[] => Array.isArray(value) ? value : value == null ? [] : [value];
const value = (source: Record<string, any>, keys: string[]) => first(source, keys);
const kg = (source: Record<string, any>): number | null => num(value(source, ['amountKg', 'amount_kg', 'amount'])) ?? null;
const grams = (source: Record<string, any>): number | null => num(value(source, ['amountG', 'amount_g', 'amount'])) ?? null;

function recipeSource(batch: Record<string, any>): Record<string, any> {
  return obj(first(batch, ['recipe', 'recipeSnapshot']));
}

function mapRecipe(batch: Record<string, any>, importedAt: string): Recipe {
  const source = recipeSource(batch);
  const style = obj(first(source, ['style', 'styleInfo']));
  const equipment = obj(first(source, ['equipment', 'equipmentProfile']));
  const mash = obj(first(source, ['mash', 'mashProfile']));
  const fermentables: Fermentable[] = arr(first(source, ['fermentables', 'fermentable'])).map(item => {
    const row = obj(item);
    return {name: text(value(row, ['name', 'ingredient'])) || 'Unnamed fermentable', amountKg: kg(row), type: text(row.type), yieldPercent: num(value(row, ['yield', 'yieldPercent'])), color: num(row.color), origin: text(row.origin), supplier: text(row.supplier), notes: text(row.notes)};
  });
  const hops: HopAddition[] = arr(first(source, ['hops', 'hop'])).map(item => {
    const row = obj(item);
    return {name: text(value(row, ['name', 'ingredient'])) || 'Unnamed hop', amountG: grams(row), use: text(value(row, ['use', 'usage'])), timeMinutes: num(value(row, ['time', 'timeMinutes', 'boilTime'])), alphaPercent: num(value(row, ['alpha', 'alphaPercent'])), ibu: num(row.ibu), notes: text(row.notes)};
  });
  const miscs: MiscAddition[] = arr(first(source, ['miscs', 'misc', 'additions'])).map(item => {
    const row = obj(item);
    return {name: text(value(row, ['name', 'ingredient'])) || 'Unnamed addition', type: text(row.type), use: text(value(row, ['use', 'usage'])), useFor: text(row.useFor), amountG: grams(row), amountIsWeight: typeof row.amountIsWeight === 'boolean' ? row.amountIsWeight : null, timeMinutes: num(value(row, ['time', 'timeMinutes'])), notes: text(row.notes)};
  });
  const mashSteps: MashStep[] = arr(first(source, ['mashSteps', 'mash_steps', 'steps'])).map((item, index) => {
    const row = obj(item);
    return {name: text(value(row, ['name', 'stepName'])) || `Step ${index + 1}`, type: text(row.type), targetTemperatureC: num(value(row, ['stepTemp', 'temperature', 'targetTemperatureC'])) ?? 0, durationMinutes: num(value(row, ['stepTime', 'duration', 'durationMinutes'])) ?? 0, rampTimeMinutes: num(value(row, ['rampTime', 'rampTimeMinutes'])), infuseAmountL: num(value(row, ['infuseAmount', 'infuseAmountL']))};
  });
  const yeasts: YeastEntry[] = arr(first(source, ['yeasts', 'yeast'])).map(item => {
    const row = obj(item);
    return {name: text(value(row, ['name', 'ingredient'])) || 'Unnamed yeast', laboratory: text(value(row, ['laboratory', 'manufacturer'])), productId: text(value(row, ['productId', 'product_id', 'product'])), type: text(row.type), form: text(row.form), attenuationPercent: num(value(row, ['attenuation', 'attenuationPercent'])), amountG: grams(row), notes: text(row.notes)};
  });
  const fermentation = arr(first(source, ['fermentation', 'fermentationSchedule', 'fermentationSteps'])).map(item => {
    const row = obj(item);
    return {name: text(row.name), temperatureC: num(value(row, ['temperature', 'temperatureC', 'temp'])), durationDays: num(value(row, ['duration', 'durationDays', 'days'])), notes: text(row.notes)};
  });
  const name = text(first(batch, ['name', 'batchName'])) || text(source.name) || `Batch ${text(batch._id) || 'unknown'}`;
  return {
    id: text(batch._id) || text(batch.id) || name,
    name: text(source.name) || text(first(batch, ['recipeName'])) || name,
    style: text(first(style, ['name', 'style'])) || text(source.style),
    notes: text(first(source, ['notes', 'description'])) || text(batch.notes),
    plannedBatchVolumeL: num(first(source, ['batchSize', 'batchSizeL', 'batchVolume', 'batchVolumeL'])),
    plannedBoilVolumeL: num(first(source, ['boilSize', 'boilSizeL', 'preBoilVolume', 'preBoilVolumeL'])),
    plannedPreBoilVolumeL: num(first(source, ['preBoilVolume', 'preBoilVolumeL', 'boilSize', 'boilSizeL'])),
    grainWeightKg: fermentables.reduce((total, item) => total + (item.amountKg ?? 0), 0) || null,
    mashWaterVolumeL: num(first(source, ['mashWaterVolume', 'mashWaterVolumeL'])),
    spargeWaterVolumeL: num(first(source, ['spargeWaterVolume', 'spargeWaterVolumeL'])),
    mashSteps, boilDurationMinutes: num(first(source, ['boilTime', 'boilDuration', 'boilDurationMinutes'])),
    createdAt: importedAt, updatedAt: importedAt, source: 'BREWFATHER', sourceRecipeId: text(first(source, ['_id', 'id'])), sourceFormat: 'BREWFATHER_API_V2', sourceImportedAt: importedAt,
    originalRecipeData: source, originalImport: null,
    og: num(first(source, ['og', 'originalGravity'])), fg: num(first(source, ['fg', 'finalGravity'])), abvPercent: num(first(source, ['abv', 'abvPercent'])), ibu: num(source.ibu), color: num(first(source, ['color', 'srm'])), efficiencyPercent: num(first(source, ['efficiency', 'efficiencyPercent'])), fermentables, hops, yeasts, miscs,
    equipment: Object.keys(equipment).length ? {name: text(equipment.name), batchSizeL: num(first(equipment, ['batchSize', 'batchSizeL'])), boilSizeL: num(first(equipment, ['boilSize', 'boilSizeL'])), evaporationRateLPerHour: num(first(equipment, ['evaporationRate', 'evaporationRateLPerHour'])), efficiencyPercent: num(first(equipment, ['efficiency', 'efficiencyPercent'])), notes: text(equipment.notes)} : null,
    mashProfile: Object.keys(mash).length ? {name: text(mash.name), grainTemperatureC: num(first(mash, ['grainTemp', 'grainTemperatureC'])), tunTemperatureC: num(first(mash, ['tunTemp', 'tunTemperatureC'])), spargeTemperatureC: num(first(mash, ['spargeTemp', 'spargeTemperatureC'])), ph: num(mash.ph), tunWeightKg: num(first(mash, ['tunWeight', 'tunWeightKg'])), notes: text(mash.notes)} : null,
    waterProfile: null, fermentation,
  };
}

export function mapBrewfatherBatch(raw: unknown, importedAt = new Date().toISOString()): BrewfatherBatch {
  const envelope = obj(raw); const batch = obj(envelope.batch ?? raw);
  const recipe = mapRecipe(batch, importedAt);
  return {id: text(batch._id) || text(batch.id) || recipe.id, batchNo: first(batch, ['batchNo', 'batchNumber']), name: text(first(batch, ['name', 'batchName'])) || recipe.name, recipeName: recipe.name, status: text(batch.status), brewDate: text(first(batch, ['brewDate', 'plannedDate'])), style: recipe.style, batchVolumeL: recipe.plannedBatchVolumeL, recipeId: text(first(recipeSource(batch), ['_id', 'id'])), importedAt, lastSyncedAt: importedAt, recipe, originalBatchJson: raw};
}

export function mapBrewfatherBatchSummary(raw: unknown): BrewfatherBatchSummary {
  const envelope = obj(raw); const batch = obj(envelope.batch ?? raw); const recipe = obj(batch.recipe);
  return {id: text(batch._id) || text(batch.id) || '', batchNo: first(batch, ['batchNo', 'batchNumber']), name: text(first(batch, ['name', 'batchName'])), recipeName: text(first(batch, ['recipeName'])) || text(recipe.name), status: text(batch.status), brewDate: text(first(batch, ['brewDate', 'plannedDate'])), style: text(batch.style) || text(recipe.style), batchVolumeL: num(first(batch, ['batchSize', 'batchVolume', 'batchVolumeL'])) || num(first(recipe, ['batchSize', 'batchVolume', 'batchVolumeL']))};
}
