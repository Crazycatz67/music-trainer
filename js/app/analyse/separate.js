// separate.js — splits a song into the singer and everything else, in the browser.
//
// Model: HTDemucs (Meta AI, MIT) as the 21-piece mixed-precision ONNX export
// monteslu/htdemucs-web-onnx, run by onnxruntime-web (vendored) on WebGPU, with a
// WebAssembly try as the fallback. The model takes 7.8 s of 44.1 kHz stereo plus its
// spectrogram and returns four stems (drums, bass, other, vocals) as a spectrogram part and
// a waveform part; the spectrogram maths before and after the model is done here.
//
// NOTHING is fetched when this file is imported. The runtime (27 MB, from vendor/) and the
// model (126 MB, from Hugging Face, see models.js) are fetched only inside
// createSeparator(), which a page must call from the visitor's own press, after telling
// them the size. Model files are kept in the browser's Cache Storage, so the download
// happens once per browser; they are never part of the repo.
//
// CONTRACT
//   Pure half (imports in Node; tools/checks/analyse.check.mjs):
//     DEMUCS = { sampleRate: 44100, segment: 343980, nfft: 4096, hop: 1024, bins: 2048,
//                frames: 336, overlap: 0.25, sources: ['drums', 'bass', 'other', 'vocals'] }
//     createSpectro() -> { forward(left, right) -> Float32Array [4 x 2048 x 336],
//                          inverse(x, source, channel) -> Float32Array [343980] }
//         forward: left/right are one segment (shorter is padded with silence). Layout:
//         channel-part (L real, L imaginary, R real, R imaginary), then bin, then frame;
//         the same framing, window and scale as demucs's own _spec (torch.stft, normalized).
//         inverse: reads source `source` of the model's x output [4 x 4 x 2048 x 336].
//     planSegments(samples) -> [{ start, length }]   7.8 s pieces, each overlapping the last by a quarter
//     segmentWeight() -> Float32Array [343980]       triangle used to cross-fade the overlaps
//
//   Browser half:
//     createSeparator({ backend = 'auto', modelBase?, onProgress?, cacheName? }) -> Promise<separator>
//         backend     'auto' (WebGPU when the browser has an adapter, else WebAssembly),
//                     'webgpu' or 'wasm' to force one
//         modelBase   URL of a folder holding the model files (default: the pinned
//                     Hugging Face revision in models.js)
//         onProgress  ({ stage: 'runtime' | 'download' | 'sessions', done, total, file? })
//         Every model file is checked against the size and sha256 in models.js; a mismatch
//         rejects with Error('separate: <file> ...') and nothing is cached.
//         Rejects with an Error whose message starts 'separate:' when no backend works; in
//         'auto', a WebGPU failure is tried again on WebAssembly and the reason kept in
//         separator.info.fallbackReason.
//     separator.info = { backend, adapter, threads, bytes, fromCache, downloadMs,
//                        sessionMs, runtimeMs, fallbackReason }
//     separator.separate(left, right, { onProgress?, signal?, allStems = false,
//                                       backing = BACKING_DEFAULT }) -> Promise<result>
//         left/right: Float32Array at 44100 Hz (resample first; a mono file passes the same
//         array twice). result = { vocals: [L, R], backing: [L, R], stats }
//         backing  'residual': the input minus the vocals, so the two always add up to the
//                  input. 'stems': drums + bass + other as the model gave them (one more
//                  inverse spectrogram per piece and channel; vocals + backing then add up
//                  to the input only as well as the model's four stems do).
//                  Anything else throws RangeError('separate: unknown backing ...').
//                  Which is the default, and the measurements behind it: BACKING_DEFAULT below.
//         allStems adds result.stems = { drums, bass, other, vocals } (each [L, R]); it
//         costs three more inverse spectrograms per piece, so only labs ask for it.
//         stats = { seconds, segments, spectroMs, modelMs, readMs, inverseMs, totalMs,
//                   firstSegmentMs, xRealtime, reconstructionDb, backing }
//         reconstructionDb: how far the four stems of the first segment are from adding up
//         to the input, its first and last 4096 samples left out (-30 or lower = the maths
//         around the model is right; half-precision numbers keep it from going much lower).
//         An aborted signal rejects with its reason between two segments.
//     separator.dispose()

import FFT from '../../../vendor/fft.js-4.0.4/fft.js';
import { MODELS } from './models.js';

export const DEMUCS = Object.freeze({
  sampleRate: 44100, segment: 343980, nfft: 4096, hop: 1024, bins: 2048, frames: 336, overlap: 0.25,
  sources: Object.freeze(['drums', 'bass', 'other', 'vocals']),
});

export const BACKINGS = Object.freeze(['residual', 'stems']);
// How the backing track is built. MEASURED 2026-10-13 with the real model on eight test songs
// (docs/team-log/reports/2026-10-13-cody-backing-residue.md): the two are the same track to
// within -33 dB of the song, because the model's four stems add up to the song that well.
// 'stems' leaves no less of the singer (within 1.5 dB either way) and loses 0.5 dB of the
// band above 4 kHz, so 'residual' stays the default. Change this only with new numbers, and
// raise ANALYSIS_VERSION in job.js when the saved sound changes.
export const BACKING_DEFAULT = 'residual';

// demucs pads each side by 1.5 hops (plus enough on the right to reach a whole number of
// hops), torch.stft then pads half a window more, and demucs drops the 2 frames that
// padding added at each end. Reproduced exactly, or the model sees a shifted picture.
const PAD = (DEMUCS.hop / 2) * 3;
const PADDED = DEMUCS.frames * DEMUCS.hop + 2 * PAD;          // 347136
const CENTRED = PADDED + DEMUCS.nfft;                         // 351232
const SKIP = 2;                                               // frames dropped at each end

export function createSpectro() {
  const { nfft, hop, bins, frames, segment } = DEMUCS;
  const fft = new FFT(nfft);
  const window = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
  const scale = 1 / Math.sqrt(nfft);
  const padded = new Float32Array(PADDED), centred = new Float32Array(CENTRED);
  const frame = new Float32Array(nfft), spectrum = fft.createComplexArray(), time = fft.createComplexArray();
  const ola = new Float32Array(CENTRED);

  const reflect = (i, n) => (i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i);

  function forward(left, right) {
    const mag = new Float32Array(4 * bins * frames);
    [left, right].forEach((channel, c) => {
      for (let i = 0; i < PADDED; i++) { const j = reflect(i - PAD, segment); padded[i] = j < channel.length ? channel[j] : 0; }
      for (let i = 0; i < CENTRED; i++) centred[i] = padded[reflect(i - nfft / 2, PADDED)];
      const re = c * 2 * bins * frames, im = re + bins * frames;
      for (let k = 0; k < frames; k++) {
        const at = (k + SKIP) * hop;
        for (let i = 0; i < nfft; i++) frame[i] = centred[at + i] * window[i];
        fft.realTransform(spectrum, frame);
        for (let f = 0; f < bins; f++) {
          mag[re + f * frames + k] = spectrum[2 * f] * scale;
          mag[im + f * frames + k] = spectrum[2 * f + 1] * scale;
        }
      }
    });
    return mag;
  }

  function inverse(x, source, channel) {
    const base = (source * 4 + channel * 2) * bins * frames, im = base + bins * frames;
    ola.fill(0);
    const gain = Math.sqrt(nfft);
    for (let k = 0; k < frames; k++) {
      for (let f = 0; f < bins; f++) { spectrum[2 * f] = x[base + f * frames + k] * gain; spectrum[2 * f + 1] = x[im + f * frames + k] * gain; }
      spectrum[2 * bins] = 0; spectrum[2 * bins + 1] = 0;          // the top bin demucs leaves out
      fft.completeSpectrum(spectrum);
      fft.inverseTransform(time, spectrum);
      const at = (k + SKIP) * hop;
      for (let i = 0; i < nfft; i++) ola[at + i] += time[2 * i] * window[i];
    }
    // Four windows overlap everywhere we read, and their squares add up to exactly 1.5.
    const out = new Float32Array(segment), first = nfft / 2 + PAD;
    for (let i = 0; i < segment; i++) out[i] = ola[first + i] / 1.5;
    return out;
  }

  return { forward, inverse };
}

export function planSegments(samples) {
  const stride = Math.floor((1 - DEMUCS.overlap) * DEMUCS.segment), plan = [];
  for (let start = 0; start < samples; start += stride) {
    plan.push({ start, length: Math.min(DEMUCS.segment, samples - start) });
    if (start + DEMUCS.segment >= samples) break;
  }
  return plan;
}

export function segmentWeight() {
  const n = DEMUCS.segment, w = new Float32Array(n), half = n / 2;
  for (let i = 0; i < n; i++) w[i] = Math.min(i + 1, n - i) / half;
  return w;
}

// ---------------------------------------------------------------------------- browser half

const ORT_DIR = new URL('../../../vendor/onnxruntime-web-1.30.0/', import.meta.url).href;
// From the model card: on WebGPU these nodes of piece 0 (the input normalisation) give NaN
// in half precision and must stay on the CPU.
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];

const now = () => performance.now();
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

// One model file: from Cache Storage when it is there, else from the network, checked, then
// stored. Shared with the pitch model loader in the lab.
//   fetchModelFile(url, { name, bytes, sha256 }, { cacheName? }) -> Promise<{ data: ArrayBuffer, fromCache }>
//   loadOrt('webgpu' | 'wasm') -> Promise<the onnxruntime-web module>   (fetches the runtime)
export async function fetchModelFile(url, file, { cacheName = 'music-trainer-analyse-models-v1' } = {}) {
  const cache = typeof caches !== 'undefined' ? await caches.open(cacheName).catch(() => null) : null;
  const hit = cache ? await cache.match(url) : null;
  if (hit) {
    const data = await hit.arrayBuffer();
    if (data.byteLength === file.bytes) return { data, fromCache: true };
    await cache.delete(url);   // a cut-off download from an earlier visit
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`separate: ${file.name} could not be downloaded (HTTP ${res.status})`);
  const data = await res.arrayBuffer();
  if (data.byteLength !== file.bytes) throw new Error(`separate: ${file.name} is ${data.byteLength} bytes, expected ${file.bytes}`);
  if (file.sha256 && globalThis.crypto?.subtle) {
    const got = hex(await crypto.subtle.digest('SHA-256', data));
    if (got !== file.sha256) throw new Error(`separate: ${file.name} does not match its pinned sha256`);
  }
  if (cache) await cache.put(url, new Response(data.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return { data, fromCache: false };
}

// The onnxruntime-web module, loaded once. Single-threaded WebAssembly unless the page is
// cross-origin isolated (threads need SharedArrayBuffer, which browsers only give then).
//
// Two builds, because neither does both jobs (measured, 1.30.0): the 'webgpu' build is the
// only one that takes forceCpuNodeNames, which HTDemucs needs, but its CPU side lacks an
// operator SwiftF0 uses ("Could not find an implementation for Cast(13)"); the plain 'wasm'
// build runs SwiftF0 and has no WebGPU. They are separate modules and do not share state.
const ortPromises = {};
export function loadOrt(build = 'webgpu') {
  if (build !== 'webgpu' && build !== 'wasm') throw new RangeError(`separate: unknown runtime build ${build}`);
  ortPromises[build] ??= import(/* no bundler: a plain URL */ `${ORT_DIR}ort.${build}.min.mjs`).then((ort) => {
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    ort.env.logLevel = 'error';
    return ort;
  });
  return ortPromises[build];
}

export async function createSeparator({ backend = 'auto', modelBase = MODELS.htdemucs.base, onProgress = () => {}, cacheName } = {}) {
  const info = { backend: null, adapter: null, threads: 1, bytes: 0, fromCache: 0, downloadMs: 0, sessionMs: 0, runtimeMs: 0, fallbackReason: null };
  let t = now();
  onProgress({ stage: 'runtime', done: 0, total: 1 });
  const ort = await loadOrt();
  info.runtimeMs = Math.round(now() - t);
  info.threads = ort.env.wasm.numThreads;

  let adapter = null;
  if (backend !== 'wasm' && navigator.gpu) adapter = await navigator.gpu.requestAdapter().catch(() => null);
  if (backend === 'webgpu' && !adapter) throw new Error('separate: this browser gave no WebGPU adapter');
  if (adapter?.info) info.adapter = [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' ');

  t = now();
  const files = MODELS.htdemucs.files, total = files.reduce((s, f) => s + f.bytes, 0);
  const data = {};
  for (const file of files) {
    onProgress({ stage: 'download', done: info.bytes, total, file: file.name });
    const got = await fetchModelFile(modelBase + file.name, file, { cacheName });
    data[file.name] = got.data;
    info.bytes += file.bytes;
    if (got.fromCache) info.fromCache++;
  }
  info.downloadMs = Math.round(now() - t);
  const manifest = JSON.parse(new TextDecoder().decode(data['htdemucs_split_manifest.json']));

  async function open(which) {
    const sessions = [];
    for (let i = 0; i < manifest.pieces.length; i++) {
      onProgress({ stage: 'sessions', done: i, total: manifest.pieces.length, file: manifest.pieces[i].file });
      const options = which === 'webgpu'
        ? { executionProviders: [i === 0 ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu'], graphOptimizationLevel: 'all', preferredOutputLocation: 'gpu-buffer', logSeverityLevel: 3 }
        : { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
      // logSeverityLevel 3 (errors only): the runtime otherwise prints "some nodes were not
      // assigned to the preferred provider" through console.error for the nodes pinned to
      // the CPU on purpose, which reads as a page error.
      try {
        sessions.push(await ort.InferenceSession.create(new Uint8Array(data[manifest.pieces[i].file]), options));
      } catch (e) {
        await Promise.all(sessions.map((s) => s.release().catch(() => {})));
        throw new Error(`separate: ${which} could not open ${manifest.pieces[i].file}: ${e?.message ?? e}`);
      }
    }
    return sessions;
  }

  t = now();
  let sessions;
  if (adapter) {
    try { sessions = await open('webgpu'); info.backend = 'webgpu'; }
    catch (e) { if (backend === 'webgpu') throw e; info.fallbackReason = e.message; }
  } else if (backend === 'auto') info.fallbackReason = 'no WebGPU adapter';
  if (!sessions) { sessions = await open('wasm'); info.backend = 'wasm'; }
  info.sessionMs = Math.round(now() - t);

  const spectro = createSpectro(), weight = segmentWeight();
  const { segment, bins, frames } = DEMUCS, VOCALS = DEMUCS.sources.indexOf('vocals');
  let busy = false;

  // drums + bass + other of one piece in ONE inverse per channel: the inverse is linear, so
  // the three spectrograms are added first (three inverses would cost three times as much).
  const restX = new Float32Array(4 * bins * frames);
  function restOf(x, xt) {
    const block = 4 * bins * frames;
    for (let i = 0; i < block; i++) restX[i] = x[i] + x[block + i] + x[2 * block + i];
    return [0, 1].map((c) => {
      const out = spectro.inverse(restX, 0, c);
      for (let s = 0; s < VOCALS; s++) { const wave = (s * 2 + c) * segment; for (let i = 0; i < segment; i++) out[i] += xt[wave + i]; }
      return out;
    });
  }

  async function runSegment(left, right, stats, wantAll, wantRest) {
    let t0 = now();
    const mix = new Float32Array(2 * segment);
    mix.set(left.subarray(0, segment), 0); mix.set(right.subarray(0, segment), segment);
    const mag = spectro.forward(left, right);
    stats.spectroMs += now() - t0;

    t0 = now();
    const map = { mix: new ort.Tensor('float32', mix, [1, 2, segment]), mag: new ort.Tensor('float32', mag, [1, 4, bins, frames]) };
    for (let i = 0; i < sessions.length; i++) {
      const feeds = {};
      for (const name of manifest.pieces[i].inputs) feeds[name] = map[name];
      Object.assign(map, await sessions[i].run(feeds));
    }
    stats.modelMs += now() - t0;

    t0 = now();
    // getData also waits for the GPU to finish, so the model's real time ends here.
    const x = await map[manifest.outputs.freq].getData(), xt = await map[manifest.outputs.time].getData();
    for (const tensor of Object.values(map)) { try { tensor.dispose(); } catch { /* a CPU tensor */ } }
    stats.readMs += now() - t0;

    t0 = now();
    const stem = (source) => [0, 1].map((c) => {
      const out = spectro.inverse(x, source, c), wave = (source * 2 + c) * segment;
      for (let i = 0; i < segment; i++) out[i] += xt[wave + i];
      return out;
    });
    const vocals = stem(VOCALS);
    const others = wantAll ? [0, 1, 2].map(stem) : null;
    const rest = !wantRest ? null : others
      ? [0, 1].map((c) => Float32Array.from(others[0][c], (v, i) => v + others[1][c][i] + others[2][c][i]))
      : restOf(x, xt);
    if (stats.reconstructionDb === null) {
      // Do the four stems add up to what went in? Checked once; it proves the framing,
      // window and scale above match what the model was trained with.
      const sum = [new Float32Array(vocals[0]), new Float32Array(vocals[1])];
      for (let s = 0; s < VOCALS; s++) (others ? others[s] : stem(s)).forEach((ch, c) => { for (let i = 0; i < segment; i++) sum[c][i] += ch[i]; });
      let err = 0, ref = 0;
      // Not the first and last window: demucs drops the two spectrogram frames that hang
      // over each end, so the ends of a piece never add up (the cross-fade hides them).
      const n = Math.min(segment, left.length) - DEMUCS.nfft;
      for (let i = DEMUCS.nfft; i < n; i++) { err += (sum[0][i] - left[i]) ** 2 + (sum[1][i] - right[i]) ** 2; ref += left[i] ** 2 + right[i] ** 2; }
      stats.reconstructionDb = ref > 0 ? Math.round(10 * Math.log10(Math.max(err / ref, 1e-12)) * 10) / 10 : 0;
    }
    stats.inverseMs += now() - t0;
    return { stems: others ? [...others, vocals] : [null, null, null, vocals], rest };
  }

  async function separate(left, right, { onProgress: progress = () => {}, signal, allStems = false, backing: mode = BACKING_DEFAULT } = {}) {
    if (!BACKINGS.includes(mode)) throw new RangeError(`separate: unknown backing ${mode}`);
    if (busy) throw new Error('separate: already running (one song at a time)');
    if (left.length !== right.length) throw new RangeError(`separate: left and right differ in length (${left.length}, ${right.length})`);
    busy = true;
    try {
      const n = left.length, plan = planSegments(n), start = now();
      const stats = { seconds: n / DEMUCS.sampleRate, segments: plan.length, spectroMs: 0, modelMs: 0, readMs: 0, inverseMs: 0, totalMs: 0, firstSegmentMs: 0, xRealtime: 0, reconstructionDb: null, backing: mode };
      const acc = DEMUCS.sources.map((_, s) => (allStems || s === VOCALS ? [new Float32Array(n), new Float32Array(n)] : null));
      const vocals = acc[VOCALS], sum = new Float32Array(n);
      const fromStems = mode === 'stems', backing = [new Float32Array(n), new Float32Array(n)];
      const padL = new Float32Array(segment), padR = new Float32Array(segment);
      for (let k = 0; k < plan.length; k++) {
        signal?.throwIfAborted();
        progress({ done: k, total: plan.length });
        const { start: at, length } = plan[k];
        padL.fill(0); padR.fill(0);
        padL.set(left.subarray(at, at + length)); padR.set(right.subarray(at, at + length));
        const t0 = now();
        const { stems: out, rest } = await runSegment(padL, padR, stats, allStems, fromStems);
        if (k === 0) stats.firstSegmentMs = Math.round(now() - t0);
        for (let s = 0; s < acc.length; s++) {
          if (!acc[s]) continue;
          for (let i = 0; i < length; i++) { acc[s][0][at + i] += out[s][0][i] * weight[i]; acc[s][1][at + i] += out[s][1][i] * weight[i]; }
        }
        if (rest) for (let i = 0; i < length; i++) { backing[0][at + i] += rest[0][i] * weight[i]; backing[1][at + i] += rest[1][i] * weight[i]; }
        for (let i = 0; i < length; i++) sum[at + i] += weight[i];
      }
      for (let i = 0; i < n; i++) {
        const w = sum[i] || 1;
        for (const pair of acc) if (pair) { pair[0][i] /= w; pair[1][i] /= w; }
        if (fromStems) { backing[0][i] /= w; backing[1][i] /= w; }
        else { backing[0][i] = left[i] - vocals[0][i]; backing[1][i] = right[i] - vocals[1][i]; }
      }
      stats.totalMs = now() - start;
      for (const key of ['spectroMs', 'modelMs', 'readMs', 'inverseMs', 'totalMs']) stats[key] = Math.round(stats[key]);
      stats.xRealtime = Math.round((stats.seconds / (stats.totalMs / 1000)) * 10) / 10;
      progress({ done: plan.length, total: plan.length });
      const result = { vocals, backing, stats };
      if (allStems) result.stems = Object.fromEntries(DEMUCS.sources.map((name, s) => [name, acc[s]]));
      return result;
    } finally { busy = false; }
  }

  return {
    info, separate,
    async dispose() { await Promise.all(sessions.map((s) => s.release().catch(() => {}))); },
  };
}
