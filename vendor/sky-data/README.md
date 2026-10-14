# Sky data (share-alike; not the app's own code)

Two data files that let the app draw the real night sky. Both are cut down from free
catalogues by `tools/build-stars.mjs`. **These two files keep their sources' share-alike
licences** (below). The app's own code only reads them and is a separate work under the
app's own terms. That reading of "data-only use" is the team's, not legal advice.

| File | What it is | Size | Gzipped |
| --- | --- | --- | --- |
| `stars.json` | The 8,920 stars to magnitude 6.5 (everything the eye can see from a dark place), brightest first. Each row: right ascension and declination in degrees (J2000), magnitude, colour index (B-V, `null` for 40 stars), Hipparcos number (`0` for 50 stars). A second list gives the proper names of 440 of them by row number. | 309,914 bytes | 124,853 bytes |
| `figures.json` | The 88 western constellation figures as line segments: pairs of row numbers into `stars.json`, with each figure's abbreviation (`Ori`), Latin name (`Orion`) and plain English name (`Hunter`). 674 segments on 691 stars. `thinLines` are the segments the source marks as thin (fainter extensions, such as the Great Bear's legs). | 12,851 bytes | 4,981 bytes |

The exact layout is in the header of `tools/build-stars.mjs`; `js/app/realsky.js` (`makeSky`)
reads it.

## Sources (retrieved 2026-10-12, pinned to a commit)

### Stars: HYG Database v4.4
- By David Nash (astronexus). Home: <https://codeberg.org/astronexus/hyg>
- File: `data/hyg/CURRENT/hyg_v44.csv.gz` at commit `53e3df311869e813ace5f1ad2ec4ce909f13256c`
  <https://codeberg.org/astronexus/hyg/media/commit/53e3df311869e813ace5f1ad2ec4ce909f13256c/data/hyg/CURRENT/hyg_v44.csv.gz>
  (the repository stores it with Git LFS: the `/raw/` address gives a 133-byte pointer, `/media/` the data)
- 13,636,362 bytes, sha256 `00b349893b9a53106dd488d8371e8d2fa586043e500bb3cdb8bff3931682197d`
  (the same hash the repository's LFS pointer states)
- **Licence: CC BY-SA 4.0.** The `LICENSE` file beside the data says: "This work is licensed
  under a Creative Commons Attribution-ShareAlike 4.0 International License."
  <https://creativecommons.org/licenses/by-sa/4.0/>
- Changes made: cut at magnitude 6.5; the Sun's row dropped; five columns kept (`ra`, `dec`,
  `mag`, `ci`, `hip`) plus `proper`; right ascension turned from hours to degrees; positions
  rounded to 0.001 degrees, magnitude and colour index to 0.01; sorted brightest first.

### Figures: Stellarium sky cultures, "Western"
- By Stellarium's team. Home: <https://github.com/Stellarium/stellarium-skycultures>
- File: `western/index.json` at commit `014fbb5e59233d133c22f9811af96b67d05a95c9`
  <https://raw.githubusercontent.com/Stellarium/stellarium-skycultures/014fbb5e59233d133c22f9811af96b67d05a95c9/western/index.json>
- 107,520 bytes, sha256 `a861accd345249a185a5ecfc2a516f34291c0aa52f4bb8d8337ffc53e9cef6b9`
- **Licence, exactly as stated.** `index.json` carries no licence field. The sky culture's
  `western/description.md` (same commit) ends with:

  > ## Authors
  >
  > Stellarium's team.
  >
  > Illustrations by Johan Meuris.
  >
  > ## License
  >
  > Text and data: CC BY-SA
  >
  > Illustrations: Free Art License

  So the line data is "CC BY-SA", **with no version number given**. We use only the line
  data: no illustrations, no description text. `figures.json` is offered under CC BY-SA 4.0,
  the current version (CC BY-SA from 2.0 on lets an adaptation use a later version of the
  same licence). Which version Stellarium meant is not stated anywhere we found; this is the
  team's reading, not legal advice.
- Changes made: the constellation lines only (no pictures, borders or asterisms); Hipparcos
  numbers replaced by row numbers into `stars.json`; polylines split into pairs; a segment
  drawn twice kept once; sorted by abbreviation.

## Credit text for the app's About

Short (one line, for Settings):

> Star data: HYG Database v4.4 by David Nash (CC BY-SA 4.0). Constellation lines: Stellarium (CC BY-SA).

Full (for About):

> **The stars.** Star positions, brightness and names come from the HYG Database v4.4 by
> David Nash (codeberg.org/astronexus/hyg), used under the Creative Commons
> Attribution-ShareAlike 4.0 licence (creativecommons.org/licenses/by-sa/4.0). We kept the
> stars to magnitude 6.5 and rounded the numbers.
>
> **The constellation lines.** From the Western sky culture of Stellarium
> (stellarium.org, github.com/Stellarium/stellarium-skycultures) by Stellarium's team, text
> and data under the Creative Commons Attribution-ShareAlike licence. We kept the lines and
> matched them to our star list.
>
> These two data files (`vendor/sky-data/stars.json` and `figures.json`) are shared under the
> same share-alike licence, CC BY-SA 4.0. The rest of this app is separate from them.

## Rebuilding

```
mkdir -p tools/.cache/hyg tools/.cache/stellarium
curl -L -o tools/.cache/hyg/hyg_v44.csv.gz "https://codeberg.org/astronexus/hyg/media/commit/53e3df311869e813ace5f1ad2ec4ce909f13256c/data/hyg/CURRENT/hyg_v44.csv.gz"
curl -L -o tools/.cache/stellarium/index.json "https://raw.githubusercontent.com/Stellarium/stellarium-skycultures/014fbb5e59233d133c22f9811af96b67d05a95c9/western/index.json"
node tools/build-stars.mjs
```

The script checks each input's sha256 against the pinned one and writes the same bytes every
time (`npm test` compares them when `tools/.cache/` is present). `tools/.cache/` is not
committed: the HYG source is 13.6 MB.
