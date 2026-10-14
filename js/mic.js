// mic.js — microphone in, pitch frames out. Browser only.
//
// CONTRACT
//   startMic({ onFrame, onLevel?, onEnd?, audioContext?, stream?, deviceId?,
//              detector?, tracker? }) -> Promise<mic>
//     onFrame(frame, rawFrame)  called once per animation frame while audio is flowing.
//                 frame is the tracked pitch frame { t, hz, midi, clarity, voiced }
//                 (see js/pitch.js); rawFrame is the detector's reading before the tracker.
//                 t = AudioContext time, in seconds, of the CENTRE of the analysed window.
//                 Input latency is not subtracted; it is reported in mic.latency.
//     onLevel(rms, peak)  loudness of the same window, 0..1, for a level meter, and the
//                 largest sample size in it (0..1 and above): a peak at full scale means the
//                 input clipped, which loudness alone cannot show.
//     onEnd(reason) the input stopped by itself: 'track-ended' (unplugged, permission
//                 withdrawn). Not called for mic.stop().
//     audioContext  share one clock with playback; if omitted, one is created and closed
//                 again by stop().
//     stream        use this MediaStream instead of asking for the microphone (the pitch
//                 lab feeds synthesised sound this way; no microphone is opened).
//     detector, tracker   option objects for createDetector / createTracker;
//                 tracker: false gives raw frames only.
//
//   mic.ctx, mic.stream, mic.sampleRate, mic.windowSize
//   mic.requested   { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
//   mic.applied     what track.getSettings() says the browser really did:
//                   { echoCancellation, noiseSuppression, autoGainControl, sampleRate,
//                     channelCount, latency, deviceId, label }; a value the browser does not
//                   report is null (unknown, NOT "off").
//   mic.processingOff   true only when all three are reported false
//   mic.warnings    plain sentences, one per setting that is still on or unknown
//   mic.latency     { input (track, seconds or null), base (context, seconds or null) }
//   mic.stop()      stops the loop, releases the microphone (if we opened it), closes the
//                   context (if we created it). Safe to call twice.
//
// Failure behaviour: startMic rejects and leaves nothing open.
//   NotSupportedError  no getUserMedia here (old browser, or page not on https/localhost)
//   NotAllowedError    the user or the system refused the microphone
//   NotFoundError      no microphone
//   (the last two are the browser's own DOMExceptions, passed through)
//
// Why an AnalyserNode read once per animation frame, and not an AudioWorklet: it needs no
// second file or build step, the detector costs well under a millisecond per window, and
// the screen cannot show more than one reading per frame anyway. The price: readings stop
// while the tab is hidden (no animation frames), and a long main-thread stall drops
// readings instead of delaying them. Both are acceptable for a practice screen; a
// recording feature that needs every sample should use a worklet instead.

import { createDetector, createTracker, windowFor } from './pitch.js';

const REQUESTED = Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });

const LABELS = {
  echoCancellation: 'echo cancellation',
  noiseSuppression: 'noise suppression',
  autoGainControl: 'automatic gain',
};

// What the browser says it applied. Separate and exported so a settings screen can show it
// for any track.
export function readAppliedSettings(track) {
  const s = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
  const pick = (key) => (key in s ? s[key] : null);
  const applied = {
    echoCancellation: pick('echoCancellation'),
    noiseSuppression: pick('noiseSuppression'),
    autoGainControl: pick('autoGainControl'),
    sampleRate: pick('sampleRate'),
    channelCount: pick('channelCount'),
    latency: pick('latency'),
    deviceId: pick('deviceId'),
    label: track ? track.label || '' : '',
  };
  const warnings = [];
  for (const key of Object.keys(REQUESTED)) {
    // Chrome may report echoCancellation as a mode string ('all', 'remote-only'): anything
    // but a plain false means some processing is on.
    if (applied[key] === false) continue;
    warnings.push(applied[key] === null
      ? `The browser does not say whether ${LABELS[key]} is off.`
      : `${LABELS[key][0].toUpperCase()}${LABELS[key].slice(1)} is still on; it can bend or mute a sung note.`);
  }
  return { applied, warnings, processingOff: warnings.length === 0 };
}

export async function startMic({
  onFrame, onLevel, onEnd, audioContext, stream, deviceId, detector, tracker,
} = {}) {
  if (typeof onFrame !== 'function') throw new TypeError('startMic: onFrame(frame, rawFrame) is required');

  const ownStream = !stream;
  if (ownStream) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new DOMException('No microphone access here: the page must be on https or localhost.', 'NotSupportedError');
    }
    // Plain (ideal) values, not { exact }: with exact, a device that cannot switch a
    // feature off fails outright. We would rather open it and say what is still on.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...REQUESTED, channelCount: 1, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      video: false,
    });
  }

  const track = stream.getAudioTracks()[0];
  const ownContext = !audioContext;
  let ctx = audioContext, source = null, analyser = null, raf = 0, stopped = false;

  const release = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { if (source) source.disconnect(); } catch { /* already disconnected */ }
    if (ownStream) for (const t of stream.getTracks()) t.stop();
    if (ownContext && ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  };

  try {
    if (!track) throw new DOMException('The stream has no audio track.', 'NotFoundError');
    ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume();

    // The default 2048 window is too short for low notes at 96 or 192 kHz (an audio
    // interface can run the context that fast): size it to the context unless the caller
    // chose one.
    const det = createDetector({ windowSize: windowFor(ctx.sampleRate, detector && detector.minHz), ...detector });
    const trk = tracker === false ? null : createTracker(tracker);
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = det.windowSize;
    // Not connected to ctx.destination: the singer must never hear the microphone back.
    source.connect(analyser);

    const { applied, warnings, processingOff } = readAppliedSettings(track);
    const buffer = new Float32Array(det.windowSize);
    const halfWindow = det.windowSize / 2 / ctx.sampleRate;
    let lastTime = -1;

    const tick = () => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      const now = ctx.currentTime;
      // The context clock stands still while suspended or stalled; reading then would
      // report the same audio twice under one timestamp.
      if (now <= lastTime || now < 2 * halfWindow) return;
      lastTime = now;
      analyser.getFloatTimeDomainData(buffer);
      const raw = det.detect(buffer, ctx.sampleRate, now - halfWindow);
      if (onLevel) {
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) { const a = Math.abs(buffer[i]); if (a > peak) peak = a; }
        onLevel(det.lastRms, peak);
      }
      onFrame(trk ? trk.push(raw) : raw, raw);
    };

    const onTrackEnded = () => {
      if (stopped) return;
      mic.stop();
      if (onEnd) onEnd('track-ended');
    };
    track.addEventListener('ended', onTrackEnded);

    const mic = {
      ctx, stream,
      sampleRate: ctx.sampleRate,
      windowSize: det.windowSize,
      requested: REQUESTED,
      applied, warnings, processingOff,
      latency: { input: applied.latency, base: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : null },
      stop() {
        if (stopped) return;
        stopped = true;
        track.removeEventListener('ended', onTrackEnded);
        release();
      },
    };
    raf = requestAnimationFrame(tick);
    return mic;
  } catch (err) {
    stopped = true;
    release();
    throw err;
  }
}
