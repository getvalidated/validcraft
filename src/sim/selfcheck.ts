import type { Window } from '../schema';
import type { SimState } from '../seam';

const RUNS = 200;
const STEPS = 24;
const SPEEDS = [1, 5, 20, 60];
const MINUTE = 60_000;

export interface Mismatch {
  t: number;
  speed: number;
  field: keyof SimState;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function runSelfcheck(state: (t: number, speed: number) => SimState, window: Window): Mismatch[] {
  const rnd = mulberry32(4791);
  const span = window.end - window.start;
  const pickSpeed = () => SPEEDS[Math.floor(rnd() * SPEEDS.length)];
  const mismatches: Mismatch[] = [];
  for (let run = 0; run < RUNS; run++) {
    const t = window.start + rnd() * span;
    const speed = pickSpeed();
    const step = ((0.25 + rnd()) * speed * MINUTE) / 60;
    let stepped = state(t - STEPS * step, speed);
    for (let k = STEPS - 1; k >= 0; k--) stepped = state(t - k * step, speed);
    state(window.start + rnd() * span, pickSpeed());
    const direct = state(t, speed);
    for (const field of Object.keys(direct) as (keyof SimState)[]) {
      if (JSON.stringify(direct[field]) !== JSON.stringify(stepped[field])) mismatches.push({ t, speed, field });
    }
  }
  return mismatches;
}
