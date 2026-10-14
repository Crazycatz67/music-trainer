# Music trainer

A browser tool for learning to sing in tune. Sing into the microphone, see the note you are
on, match targets, and sing along with songs. Piano comes later. It runs in Chrome with no
accounts and nothing to install; your voice and your song files never leave your computer.

**Try it:** https://crazycatz67.github.io/music-trainer/

## What is in it
- **Free sing:** the note you are on, drawn live on a scrolling stage.
- **Practice:** voice check, find your range, match and hold, sing a constellation, long note.
- **Sing page:** drop in a song; it separates the singer from the music, finds the tune and
  the words, and you sing along with your own Music and Singer volume.
- **Demo songs:** public-domain tunes (`songs/demo/`), so there is something to sing at once.
- **The sky:** the home screen is a star dome; your practice lights it up.

The microphone and camera turn on only when you press for them, and turn off when you stop.

## Run it on your own computer
    python3 serve.py          # then open http://localhost:8090/

Port 8090 is the default (`python3 serve.py 8091` picks another). There is no build step:
plain HTML, CSS and JavaScript modules.

## Songs and copyright
Do not put copyrighted songs, lyrics, charts or recordings in this repo. `songs/` is
git-ignored except `songs/demo/` (public-domain tunes only). The app never downloads or
changes YouTube audio.

## Third-party code
Vendored in `vendor/` at pinned versions, each with its licence: pitchy 4.1.0 (pitch
detection, MIT), fft.js 4.0.4 (MIT), three.js r161 (MIT; draws the star dome) and
onnxruntime-web 1.30.0 (MIT; runs the song-analysis models, which are fetched from their
pinned sources only when you analyse a song).

Third-party data, in `vendor/sky-data/` (share-alike; these two files keep their own licence,
separate from the app's code; sources, hashes and credit text in `vendor/sky-data/README.md`):
`stars.json` from the HYG Database v4.4 by David Nash (CC BY-SA 4.0), and `figures.json` from
Stellarium's Western sky culture ("Text and data: CC BY-SA").
