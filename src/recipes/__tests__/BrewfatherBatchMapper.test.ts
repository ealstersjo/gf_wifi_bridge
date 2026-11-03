import {mapBrewfatherBatch} from '../BrewfatherBatchMapper';

describe('BrewfatherBatchMapper', () => {
  it('maps the embedded batch recipe without discarding brewing data', () => {
    const batch = mapBrewfatherBatch({
      _id: 'batch-1', batchNo: 42, name: 'Spring brew', status: 'Planning', brewDate: '2026-04-01',
      recipe: {
        _id: 'recipe-1', name: 'Hoppy Lager', style: {name: 'Czech Lager'}, batchSize: 20,
        boilTime: 60, og: 1.05, fg: 1.01, abv: 5.2, ibu: 35,
        fermentables: [{name: 'Pilsner malt', amount: 4.5, yield: 80, color: 3}],
        mashSteps: [{name: 'Saccharification', type: 'Infusion', stepTemp: 65.5, stepTime: 60, infuseAmount: 15}],
        hops: [{name: 'Saaz', amount: 40, alpha: 3.5, time: 60, use: 'Boil'}, {name: 'Saaz', amount: 25, time: 0, use: 'Whirlpool'}],
        yeasts: [{name: 'Czech Lager', manufacturer: 'Example', attenuation: 78}],
        notes: 'Keep cold', unknownFutureField: {preserve: true},
      },
    }, '2026-03-01T00:00:00.000Z');
    expect(batch.id).toBe('batch-1');
    expect(batch.batchNo).toBe(42);
    expect(batch.recipe.style).toBe('Czech Lager');
    expect(batch.recipe.mashSteps[0]).toMatchObject({targetTemperatureC: 65.5, durationMinutes: 60});
    expect(batch.recipe.fermentables?.[0].amountKg).toBe(4.5);
    expect(batch.recipe.hops?.[1].use).toBe('Whirlpool');
    expect((batch.originalBatchJson as any).recipe.unknownFutureField.preserve).toBe(true);
  });
});
