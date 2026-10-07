import {importBeerXml, importBrewfatherFile} from '../BrewfatherFileImporter';

const recipe = (name: string, id: string) => `<RECIPE><ID>${id}</ID><NAME>${name}</NAME><STYLE>German Pils</STYLE><BATCH_SIZE>10</BATCH_SIZE><BOIL_SIZE>13.4</BOIL_SIZE><BOIL_TIME>60</BOIL_TIME><OG>1.048</OG><FG>1.011</FG><ABV>4.8</ABV><IBU>32</IBU><FERMENTABLES><FERMENTABLE><NAME>Pilsner Malt</NAME><AMOUNT>2.2</AMOUNT></FERMENTABLE><FERMENTABLE><NAME>Munich I</NAME><AMOUNT>0.2</AMOUNT></FERMENTABLE></FERMENTABLES><HOPS><HOP><NAME>Hallertau</NAME><AMOUNT>0.012</AMOUNT><USE>Boil</USE><TIME>60</TIME></HOP></HOPS><YEASTS><YEAST><NAME>W-34/70</NAME><LABORATORY>Fermentis</LABORATORY></YEAST></YEASTS><MASH><MASH_STEPS><MASH_STEP><NAME>Beta</NAME><STEP_TEMP>63</STEP_TEMP><STEP_TIME>30</STEP_TIME></MASH_STEP><MASH_STEP><NAME>Alpha</NAME><STEP_TEMP>70</STEP_TEMP><STEP_TIME>30</STEP_TIME></MASH_STEP></MASH_STEPS></MASH></RECIPE>`;

describe('Brewfather BeerXML import', () => {
  it('normalizes recipe content and preserves ordered steps/source XML', () => {
    const xml = `<RECIPES>${recipe('Tmav&#233;', 'bf-1')}</RECIPES>`;
    const result = importBrewfatherFile(xml, 'recipe.xml');
    expect(result.recipe.sourceFormat).toBe('BeerXML');
    expect(result.recipe.name).toBe('Tmavé');
    expect(result.recipe.name).not.toContain('&#233;');
    expect(result.recipe.mashSteps.map(step => step.name)).toEqual(['Beta', 'Alpha']);
    expect(result.recipe.fermentables?.[0]).toMatchObject({name: 'Pilsner Malt', amountKg: 2.2});
    expect(result.recipe.originalImport).toBe(xml);
  });
  it('handles multiple recipes deliberately', () => {
    const result = importBeerXml(`<RECIPES>${recipe('One', '1')}${recipe('Two', '2')}</RECIPES>`);
    expect(result.recipes).toHaveLength(2);
    expect(() => importBrewfatherFile(`<RECIPES>${recipe('One', '1')}${recipe('Two', '2')}</RECIPES>`)).toThrow(/multiple recipes/);
  });
  it('rejects malformed and unsafe files', () => {
    expect(() => importBeerXml('')).toThrow();
    expect(() => importBeerXml('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><RECIPES/>')).toThrow(/Unsafe/);
    expect(() => importBeerXml('<RECIPES/>')).toThrow(/No recipe/);
  });
});
