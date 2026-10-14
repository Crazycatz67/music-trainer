// capture-worklet.js — runs on the audio thread: copies every sample that reaches it and
// posts them to the page in chunks, each with the audio context's frame number of its first
// sample. Loaded by js/app/song/recorder.js (audioWorklet.addModule); not an ES module import.
//
// Why a worklet and not MediaRecorder: the page needs to know which sample was captured at
// which moment of the context's clock to line the voice up with the backing. MediaRecorder
// gives compressed sound with an unknown start time and codec padding; this gives the raw
// samples and their exact frame numbers.
//
// Messages in:  { type: 'until', frame }   stop by itself once this frame is reached
//               { type: 'stop' }           post what is held, then { type: 'done' }
// Messages out: { type: 'chunk', frame, samples: Float32Array }   (mono; channels averaged)
//               { type: 'done', reason: 'stop' | 'until', frame }  frame = one past the last sample
//
// It makes no sound: the node has no outputs.

class SongCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = (options.processorOptions && options.processorOptions.chunkFrames) || 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.first = 0;
    this.until = Infinity;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data.type === 'until') this.until = e.data.frame;
      else if (e.data.type === 'stop' && this.on) this.finish('stop', this.first + this.n);
    };
  }

  flush() {
    if (!this.n) return;
    const samples = this.buf.slice(0, this.n);
    this.port.postMessage({ type: 'chunk', frame: this.first, samples }, [samples.buffer]);
    this.n = 0;
  }

  finish(reason, frame) {
    this.flush();
    this.on = false;
    this.port.postMessage({ type: 'done', reason, frame });
  }

  process(inputs) {
    if (!this.on) return false;
    const input = inputs[0];
    const channels = input ? input.length : 0;
    // A source that has gone quiet hands over no channels: that is silence, and it still
    // takes up time, so the take stays in step with the clock.
    const len = channels ? input[0].length : 128;
    for (let i = 0; i < len; i++) {
      // eslint-disable-next-line no-undef
      const frame = currentFrame + i;
      if (frame >= this.until) { this.finish('until', frame); return false; }
      if (this.n === 0) this.first = frame;
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      this.buf[this.n++] = channels > 1 ? v / channels : v;
      if (this.n === this.size) this.flush();
    }
    return true;
  }
}

registerProcessor('song-capture', SongCapture);
