# Brewfather BeerXML mapping

The importer uses `fast-xml-parser` with entity decoding enabled and reads
direct children under each BeerXML parent. `DOCTYPE` and `ENTITY` declarations
are rejected; the original XML is retained for future re-processing.

| BeerXML path | BrewRecipe field | Units | UI / future G30 use |
|---|---|---|---|
| `RECIPE/NAME` | `name` | text | Library/detail |
| `RECIPE/STYLE/*` | `style` plus original source | text | Detail |
| `BATCH_SIZE`, `BOIL_SIZE`, `BOIL_TIME` | planned volumes/boil duration | L/min | Process/statistics |
| `OG`, `FG`, `ABV`, `IBU`, `EST_COLOR`, `EFFICIENCY` | recipe stats | source units | Header/statistics |
| `FERMENTABLES/FERMENTABLE` | `fermentables[]` | kg | Brew-day detail |
| `HOPS/HOP` | `hops[]` | kg internally, g UI | Brew-day detail |
| `MISCS/MISC` | `miscs[]` | kg internally, g UI | Brewing salts/additions |
| `YEASTS/YEAST` | `yeasts[]` | source units | Brew-day detail |
| `WATERS/WATER` | `waterProfile` | ppm | Only when present |
| `MASH/MASH_STEPS/MASH_STEP` | `mashProfile`, `mashSteps[]` | °C/min/L | Statistics; future schedule projection |
| `EQUIPMENT` | `equipment` | source units | Process context |

BeerXML does not reliably provide calculated mash/sparge water for every
export, so those fields remain nullable unless a source element is present.
Fermentation data is preserved in `originalImport`; a structured mapping is
not asserted without a reliable BeerXML path in the export.

`G30ScheduleMapper` is a pure, disabled projection of mash temperatures,
mash durations, and boil duration. No verified BLE schedule-transfer capability
is assumed and no command is sent.
