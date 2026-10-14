# Music trainer

A browser tool for learning to sing in tune. Sing into the microphone, see the note you are
on, match targets, and (later) sing along with songs. Piano comes after that. It runs only on
your own computer, in Chrome, with no accounts and nothing to install.

## Run it
    python3 serve.py          # then open http://localhost:8090/

Port 8090 is the default (`python3 serve.py 8091` picks another). There is no build step.
Today you can use Free sing and the first exercise, Match and hold; Songs and Progress are placeholders.

## Test it
- `npm test` runs the Node checks (24 files, 321 tests). Nothing to install; needs Node 26.
- Labs run in the browser while the server is up (`?auto=1` runs one without a press; the
  audio labs then need Chrome's `--autoplay-policy=no-user-gesture-required`):
  - http://localhost:8090/labs/pitch-lab.html?live=1 (pitch detection, 18 checks)
  - http://localhost:8090/labs/stage-lab.html?live=1 (the drawn stage, 55 checks; 54 without `?live=1`)
  - http://localhost:8090/labs/matchhold-lab.html?auto=1 (Match and hold, 18 checks; add `&theme=dawn`)
  - http://localhost:8090/labs/matchhold-breakit-lab.html?auto=1 (hard cases, 5 checks)
  - http://localhost:8090/labs/hidden-mic-lab.html?auto=1 (microphone released on hide or leave, 12 checks)
  - http://localhost:8090/labs/sky-lab.html?auto=1 (the star dome, 29 checks with WebGL, 12 without)
  - http://localhost:8090/labs/constellation-lab.html?auto=1 (Sing a constellation, 33 checks, about 60 s; add `&theme=dawn`)
  - http://localhost:8090/labs/constellation-breakit-lab.html?auto=1 (hard cases, 11 checks, about 155 s)
  - http://localhost:8090/labs/range-lab.html?auto=1 (Find your range, 43 checks, about 33 s; add `&theme=dawn`)
  - http://localhost:8090/labs/range-breakit-lab.html?auto=1 (hard cases, 4 checks, about 30 s)
  - http://localhost:8090/labs/coach-lab.html?auto=1 (practice record, coach notes, Today and the daily session, 34 checks, about 33 s; add `&theme=dawn`)
- Headless Chrome needs a 1440x900 window or the labs fail.
- Results are kept in `docs/testing/LEDGER.md`; known problems in `docs/team-log/bugs.md`.
- The microphone and camera turn on only when you press for them, and never in an automated run. See `docs/testing/README.md`.

## Songs and copyright
Do not put copyrighted songs, lyrics, charts or recordings in this repo. `songs/` is
git-ignored except `songs/demo/` (public-domain tunes only). The app never downloads or
changes YouTube audio.

## Third-party code
Vendored in `vendor/` at pinned versions, each with its MIT licence in the file header:
pitchy 4.1.0 (pitch detection), fft.js 4.0.4, and three.js r161 (0.161.0, MIT; draws the star dome).

Third-party data, in `vendor/sky-data/` (share-alike; these two files keep their own licence,
separate from the app's code; sources, hashes and credit text in `vendor/sky-data/README.md`):
`stars.json` from the HYG Database v4.4 by David Nash (CC BY-SA 4.0), and `figures.json` from
Stellarium's Western sky culture ("Text and data: CC BY-SA"). Rebuilt by `tools/build-stars.mjs`.

## More
Plan: `docs/PLAN.md`. Design: `docs/design/`. Team notes: `docs/team-log/AGENT-BRIEF.md`.
