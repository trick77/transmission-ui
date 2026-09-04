// Seeded randomness for the simulator. Everything that looks arbitrary in the dataset comes from
// here, so the same TM_SIM_SEED always builds the same world.
//
// Node runs this directory directly with its built-in type stripping (>= 23.6), so the whole of
// ui/sim/ must stay erasable: no enum, no parameter properties, explicit .ts on relative imports,
// and `import type { … }` in statement form only (the inline `import { type X }` form leaves a
// side-effect import behind, which would drag the const enum in rpc/types.ts into the runtime).

import { createHash } from 'node:crypto'

/** mulberry32: tiny, fast, good enough, and identical across runs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rand {
  (): number
  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number
  pick<T>(xs: readonly T[]): T
  /** True with probability p. */
  chance(p: number): boolean
  /** Seeded Fisher-Yates, returns a new array. */
  shuffle<T>(xs: readonly T[]): T[]
}

export function makeRand(seed: number): Rand {
  const next = rng(seed)
  const r = (() => next()) as Rand
  r.range = (lo, hi) => lo + next() * (hi - lo)
  r.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1))
  r.pick = xs => xs[Math.floor(next() * xs.length)]
  r.chance = p => next() < p
  r.shuffle = xs => {
    const out = [...xs]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      const t = out[i]; out[i] = out[j]; out[j] = t
    }
    return out
  }
  return r
}

/** Stable 40-hex info hash for a torrent name, so ids, magnets and ?sel= deep links survive a restart. */
export function hashOf(name: string, seed: number): string {
  return createHash('sha1').update(`tm-sim:${seed}:${name}`).digest('hex')
}

/** A 32-bit seed derived from a string, for per-torrent generators. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
