// siren.js — Siren, #/practice/siren (spec section 7.4): one long "oo" or "ng" slide from the
// bottom of the comfortable range to the top and back, twice, along a taller, slower ribbon
// than the glide's. The screen is the Glide warm-up's (js/app/exercises/glide.js
// mountRibbonScreen); this file adds what only the Siren has:
//   - the ladder strip at the stage's right edge: one rung per whole note of the range, lit
//     (filled, and wider, so never by colour alone) once the voice has passed through it;
//   - break markers: hollow diamonds left on the path where the sound cut out or jumped
//     (judged in js/app/glide.js scorePass, drawn by stage.js ribbonMarks), and the result
//     line "One break near B3. That's normal; slide through it more slowly."
//
// CONTRACT — mountSiren(view, opts) -> screen   opts and screen as mountRibbonScreen, kind 'siren'.
//   screen.ladder() -> { low, high, lit: [midi] }   what the strip shows (for the lab)

import { mountRibbonScreen } from './glide.js';

export function mountSiren(view, opts = {}) {
  let ladderApi = null;
  const screen = mountRibbonScreen(view, {
    ...opts, kind: 'siren',
    decorate({ stage }) {
      let low = null, high = null, plans = null;
      const lit = new Set();
      stage.addLayer((ctx, G, tokens) => {
        if (low === null) return;
        const x = G.plotX + G.plotW - 18;
        for (let m = low; m <= high; m++) {
          const y = G.yOfMidi(m), on = lit.has(m), hgt = Math.max(2, Math.min(8, G.laneH * 0.5));
          if (y < 0 || y > ctx.canvas.clientHeight) continue;
          ctx.globalAlpha = on ? 0.95 : 0.45;
          ctx.fillStyle = on ? tokens.good : tokens.quiet;
          ctx.beginPath();
          ctx.roundRect(on ? x - 3 : x, y - hgt / 2, on ? 14 : 8, hgt, hgt / 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      });
      ladderApi = () => ({ low, high, lit: [...lit].sort((a, b) => a - b) });
      return {
        onPlan(plan) { low = plan.low; high = plan.high; plans = plan; },
        // Only notes passed through while a pass is on: humming about before it starts lights nothing.
        onFrame(f) {
          if (!f.voiced || !Number.isFinite(f.midi) || !plans) return;
          if (!plans.passes.some((p) => f.t >= p.t0 && f.t <= p.t1)) return;
          const m = Math.round(f.midi);
          if (m >= low && m <= high) lit.add(m);
        },
        reset() { lit.clear(); },
      };
    },
  });
  return { ...screen, ladder: () => (ladderApi ? ladderApi() : { low: null, high: null, lit: [] }) };
}
