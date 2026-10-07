import {XMLParser} from 'fast-xml-parser';
import {Fermentable, HopAddition, MashStep, MiscAddition, Recipe, YeastEntry} from '../session/BrewSession';

export type ImportPreview = {recipe: Recipe; warnings: string[]};
export type ImportBatch = {recipes: ImportPreview[]; format: 'BeerXML'};
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const text = (v: unknown): string | null => typeof v === 'string' ? v.trim() || null : v == null ? null : String(v);
const arr = <T>(v: T | T[] | undefined): T[] => v == null ? [] : Array.isArray(v) ? v : [v];
const massKg = (v: unknown) => { const n = num(v); return n === null ? null : n; };
const volumeL = (v: unknown) => num(v);
const tempC = (v: unknown) => num(v);
const child = (node: any, key: string) => node && node[key];

function fromBeerXml(xml: string, source: any, importedAt: string): ImportPreview {
  const name = text(source.NAME); if (!name) throw new Error('No direct RECIPE/NAME value found in BeerXML');
  const style = child(source, 'STYLE') || {};
  const fermentables: Fermentable[] = arr(child(source, 'FERMENTABLES')?.FERMENTABLE).map((item: any) => ({name: text(item.NAME) || 'Unnamed fermentable', amountKg: massKg(item.AMOUNT), type: text(item.TYPE), yieldPercent: num(item.YIELD), color: num(item.COLOR), origin: text(item.ORIGIN), supplier: text(item.SUPPLIER), notes: text(item.NOTES)}));
  const hops: HopAddition[] = arr(child(source, 'HOPS')?.HOP).map((item: any) => ({name: text(item.NAME) || 'Unnamed hop', amountG: num(item.AMOUNT) === null ? null : num(item.AMOUNT)! * 1000, use: text(item.USE), timeMinutes: num(item.TIME), alphaPercent: num(item.ALPHA), ibu: num(item.IBU), notes: text(item.NOTES)}));
  const yeasts: YeastEntry[] = arr(child(source, 'YEASTS')?.YEAST).map((item: any) => ({name: text(item.NAME) || 'Unnamed yeast', laboratory: text(item.LABORATORY), productId: text(item.PRODUCT_ID), type: text(item.TYPE), form: text(item.FORM), attenuationPercent: num(item.ATTENUATION), amountG: num(item.AMOUNT) === null ? null : num(item.AMOUNT)! * 1000, notes: text(item.NOTES)}));
  const miscs: MiscAddition[] = arr(child(source, 'MISCS')?.MISC).map((item: any) => ({name: text(item.NAME) || 'Unnamed addition', type: text(item.TYPE), use: text(item.USE), useFor: text(item.USE_FOR), amountG: num(item.AMOUNT) === null ? null : num(item.AMOUNT)! * 1000, amountIsWeight: item.AMOUNT_IS_WEIGHT == null ? null : String(item.AMOUNT_IS_WEIGHT).toLowerCase() === 'true', timeMinutes: num(item.TIME), notes: text(item.NOTES)}));
  const mashSteps: MashStep[] = arr(child(child(source, 'MASH'), 'MASH_STEPS')?.MASH_STEP).map((item: any, index) => ({name: text(item.NAME) || `Step ${index + 1}`, type: text(item.TYPE), targetTemperatureC: tempC(item.STEP_TEMP) ?? 0, durationMinutes: num(item.STEP_TIME) ?? 0, rampTimeMinutes: num(item.RAMP_TIME), infuseAmountL: volumeL(item.INFUSE_AMOUNT)}));
  const water = child(source, 'WATERS')?.WATER; const mash = child(source, 'MASH'); const equipment = child(source, 'EQUIPMENT');
  const recipe: Recipe = {id: text(source.ID) || name, name, style: text(style.NAME), notes: text(source.NOTES), plannedBatchVolumeL: volumeL(source.BATCH_SIZE), plannedBoilVolumeL: volumeL(source.BOIL_SIZE), plannedPreBoilVolumeL: volumeL(source.BOIL_SIZE), mashWaterVolumeL: null, spargeWaterVolumeL: null, grainWeightKg: fermentables.reduce((s, x) => s + (x.amountKg ?? 0), 0) || null, mashSteps, boilDurationMinutes: num(source.BOIL_TIME), createdAt: importedAt, updatedAt: importedAt, source: 'BREWFATHER', sourceRecipeId: text(source.ID) || name, sourceFormat: 'BeerXML', sourceImportedAt: importedAt, originalRecipeData: source, originalImport: xml, og: num(source.OG), fg: num(source.FG), abvPercent: num(source.ABV), ibu: num(source.IBU), color: num(source.EST_COLOR), efficiencyPercent: num(source.EFFICIENCY), fermentables, hops, yeasts, miscs, waterProfile: water ? {calciumPpm: num(water.CALCIUM), magnesiumPpm: num(water.MAGNESIUM), sodiumPpm: num(water.SODIUM), chloridePpm: num(water.CHOLORIDE ?? water.CHLORIDE), sulfatePpm: num(water.SULFATE), bicarbonatePpm: num(water.BICARBONATE)} : null, equipment: equipment ? {name: text(equipment.NAME), batchSizeL: volumeL(equipment.BATCH_SIZE), boilSizeL: volumeL(equipment.BOIL_SIZE), evaporationRateLPerHour: num(equipment.EVAP_RATE), efficiencyPercent: num(equipment.EFFICIENCY), notes: text(equipment.NOTES)} : null, mashProfile: mash ? {name: text(mash.NAME), grainTemperatureC: tempC(mash.GRAIN_TEMP), tunTemperatureC: tempC(mash.TUN_TEMP), spargeTemperatureC: tempC(mash.SPARGE_TEMP), ph: num(mash.PH), tunWeightKg: massKg(mash.TUN_WEIGHT), notes: text(mash.NOTES)} : null};
  const warnings: string[] = []; if (!mashSteps.length) warnings.push('No structured mash steps were supplied.'); if (!fermentables.length) warnings.push('No fermentables were supplied.'); return {recipe, warnings};
}

export function importBeerXml(xml: string, _filename = 'recipe.xml'): ImportBatch {
  if (!xml.trim()) throw new Error('The selected file is empty'); if (xml.length > 5_000_000) throw new Error('Recipe file is too large'); if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsafe XML declarations are not supported');
  let parsed: any; try { parsed = new XMLParser({ignoreAttributes: true, processEntities: true, htmlEntities: true, preserveOrder: false}).parse(xml); } catch { throw new Error('The selected file is not valid BeerXML'); }
  const recipes = arr(parsed?.RECIPES?.RECIPE ?? parsed?.RECIPE); if (!recipes.length) throw new Error('No recipe was found in this BeerXML file'); const importedAt = new Date().toISOString(); return {format: 'BeerXML', recipes: recipes.map(recipe => fromBeerXml(xml, recipe, importedAt))};
}
export function importBrewfatherFile(xml: string, filename = 'recipe.xml'): ImportPreview { if (!/\.xml$/i.test(filename) && !xml.trim().startsWith('<')) throw new Error('BeerXML import expects an XML file exported from Brewfather'); const batch = importBeerXml(xml, filename); if (batch.recipes.length !== 1) throw new Error('This file contains multiple recipes; use the multi-recipe import flow'); return batch.recipes[0]; }
