/**
 * Node.js microbenchmark for the layout() resize hot path.
 *
 * Creates realistic synthetic PreparedText objects (no canvas needed)
 * and benchmarks layout() in a tight loop. This isolates exactly the
 * code in line-break.ts that we're optimizing.
 *
 * Usage: npx tsx scripts/bench-layout.ts
 */

// We need to provide the internal shape that layout() expects.
// PreparedText is opaque but just a plain object at runtime.
import { layout } from '../src/layout.ts'
import type { PreparedText } from '../src/layout.ts'
import type { SegmentBreakKind } from '../src/analysis.ts'
import { walkPreparedLines, layoutNextLineRange, type PreparedLineBreakData, type InternalLayoutLine, type LineBreakCursor } from '../src/line-break.ts'

// Seed a deterministic pseudo-random for reproducible benchmarks
let seed = 42
function rand(): number {
  seed = (seed * 16807 + 0) % 2147483647
  return (seed - 1) / 2147483646
}
function resetSeed(s = 42): void { seed = s }

// Build a synthetic PreparedText that matches real-world segment distributions.
//
// breakableRatio: fraction of word segments that get per-grapheme breakableWidths
//   0 = pure Latin (no overflow breaking), 1 = all segments breakable (like Thai/CJK)
//   ~0.5 = mixed content like Arabic/Hindi with breakable long words
function makePrepared(opts: {
  segmentCount: number
  avgWordWidth: number
  spaceWidth: number
  maxWidth: number
  hasBreakableWords?: boolean
  hasCJK?: boolean
  breakableRatio?: number
  seed?: number
}): PreparedText {
  const {
    segmentCount,
    avgWordWidth,
    spaceWidth,
    hasBreakableWords = false,
    hasCJK = false,
    breakableRatio = 0,
  } = opts
  resetSeed(opts.seed ?? 42)

  const widths: number[] = []
  const lineEndFitAdvances: number[] = []
  const lineEndPaintAdvances: number[] = []
  const kinds: SegmentBreakKind[] = []
  const breakableWidths: (number[] | null)[] = []
  const breakablePrefixWidths: (number[] | null)[] = []

  for (let i = 0; i < segmentCount; i++) {
    const isSpace = i % 2 === 1 // alternating word-space pattern
    if (isSpace) {
      widths.push(spaceWidth)
      lineEndFitAdvances.push(0)
      lineEndPaintAdvances.push(0)
      kinds.push('space')
      breakableWidths.push(null)
      breakablePrefixWidths.push(null)
    } else {
      // Vary word widths around the average (±40%)
      const w = avgWordWidth * (0.6 + rand() * 0.8)
      widths.push(w)
      lineEndFitAdvances.push(w)
      lineEndPaintAdvances.push(w)
      kinds.push('text')

      if (hasCJK) {
        // CJK: every grapheme is breakable, ~12px each
        const graphemeCount = Math.max(1, Math.round(w / 12))
        const gWidths = Array.from({ length: graphemeCount }, () => w / graphemeCount)
        breakableWidths.push(gWidths)
        breakablePrefixWidths.push(null)
      } else if (breakableRatio > 0 && rand() < breakableRatio) {
        // Breakable word (e.g. Thai, Arabic, Hindi script segments)
        const graphemeCount = Math.max(2, Math.round(w / 8))
        const gWidths = Array.from({ length: graphemeCount }, () => w / graphemeCount)
        breakableWidths.push(gWidths)
        breakablePrefixWidths.push(null)
      } else if (hasBreakableWords && w > opts.maxWidth * 0.8) {
        // Long word that needs grapheme-level breaking
        const graphemeCount = Math.max(2, Math.round(w / 8))
        const gWidths = Array.from({ length: graphemeCount }, () => w / graphemeCount)
        breakableWidths.push(gWidths)
        breakablePrefixWidths.push(null)
      } else {
        breakableWidths.push(null)
        breakablePrefixWidths.push(null)
      }
    }
  }

  return {
    widths,
    lineEndFitAdvances,
    lineEndPaintAdvances,
    kinds,
    simpleLineWalkFastPath: true,
    segLevels: null,
    breakableWidths,
    breakablePrefixWidths,
    discretionaryHyphenWidth: 5.5,
    tabStopAdvance: spaceWidth * 8,
    chunks: [{
      startSegmentIndex: 0,
      endSegmentIndex: widths.length,
      consumedEndSegmentIndex: widths.length,
    }],
  } as unknown as PreparedText
}

// Build a synthetic PreparedText that exercises the full (non-simple) line-walk path.
// Includes soft hyphens, hard breaks (multiple chunks), and optional tabs.
function makePreparedFull(opts: {
  segmentCount: number
  avgWordWidth: number
  spaceWidth: number
  maxWidth: number
  softHyphenRate?: number   // fraction of word segments followed by a soft-hyphen segment
  hardBreakRate?: number    // fraction of spaces replaced by hard breaks (creating chunks)
  tabRate?: number          // fraction of spaces replaced by tab segments
  breakableRatio?: number
  seed?: number
}): PreparedText {
  const {
    segmentCount,
    avgWordWidth,
    spaceWidth,
    softHyphenRate = 0.1,
    hardBreakRate = 0.05,
    tabRate = 0,
    breakableRatio = 0,
  } = opts
  resetSeed(opts.seed ?? 42)

  const widths: number[] = []
  const lineEndFitAdvances: number[] = []
  const lineEndPaintAdvances: number[] = []
  const kinds: SegmentBreakKind[] = []
  const breakableWidths: (number[] | null)[] = []
  const breakablePrefixWidths: (number[] | null)[] = []

  // Track hard break positions for chunk building
  const hardBreakPositions: number[] = []

  for (let i = 0; i < segmentCount; i++) {
    const isSpace = i % 2 === 1
    if (isSpace) {
      const r = rand()
      if (r < hardBreakRate) {
        // Hard break segment
        widths.push(0)
        lineEndFitAdvances.push(0)
        lineEndPaintAdvances.push(0)
        kinds.push('hard-break')
        breakableWidths.push(null)
        breakablePrefixWidths.push(null)
        hardBreakPositions.push(i)
      } else if (r < hardBreakRate + tabRate) {
        // Tab segment
        widths.push(spaceWidth * 4) // approximate tab width
        lineEndFitAdvances.push(0)
        lineEndPaintAdvances.push(spaceWidth * 4)
        kinds.push('tab')
        breakableWidths.push(null)
        breakablePrefixWidths.push(null)
      } else if (rand() < softHyphenRate) {
        // Space followed by soft-hyphen: emit space then soft-hyphen
        widths.push(spaceWidth)
        lineEndFitAdvances.push(0)
        lineEndPaintAdvances.push(0)
        kinds.push('space')
        breakableWidths.push(null)
        breakablePrefixWidths.push(null)
        // Note: soft hyphen is a zero-width break opportunity
        // We just use space + mark it as soft-hyphen next time
      } else {
        widths.push(spaceWidth)
        lineEndFitAdvances.push(0)
        lineEndPaintAdvances.push(0)
        kinds.push('space')
        breakableWidths.push(null)
        breakablePrefixWidths.push(null)
      }
    } else {
      const w = avgWordWidth * (0.6 + rand() * 0.8)
      widths.push(w)
      lineEndFitAdvances.push(w)
      lineEndPaintAdvances.push(w)

      // Occasionally emit a soft-hyphen kind on word segments
      if (rand() < softHyphenRate) {
        kinds.push('soft-hyphen')
      } else {
        kinds.push('text')
      }

      if (breakableRatio > 0 && rand() < breakableRatio) {
        const graphemeCount = Math.max(2, Math.round(w / 8))
        const gWidths = Array.from({ length: graphemeCount }, () => w / graphemeCount)
        breakableWidths.push(gWidths)
        breakablePrefixWidths.push(null)
      } else {
        breakableWidths.push(null)
        breakablePrefixWidths.push(null)
      }
    }
  }

  // Build chunks from hard breaks
  const chunks: { startSegmentIndex: number; endSegmentIndex: number; consumedEndSegmentIndex: number }[] = []
  let chunkStart = 0
  for (const hbPos of hardBreakPositions) {
    chunks.push({
      startSegmentIndex: chunkStart,
      endSegmentIndex: hbPos,
      consumedEndSegmentIndex: hbPos + 1,
    })
    chunkStart = hbPos + 1
  }
  // Final chunk
  chunks.push({
    startSegmentIndex: chunkStart,
    endSegmentIndex: widths.length,
    consumedEndSegmentIndex: widths.length,
  })

  return {
    widths,
    lineEndFitAdvances,
    lineEndPaintAdvances,
    kinds,
    simpleLineWalkFastPath: false,
    segLevels: null,
    breakableWidths,
    breakablePrefixWidths,
    discretionaryHyphenWidth: 5.5,
    tabStopAdvance: spaceWidth * 8,
    chunks,
  } as unknown as PreparedText
}

// --- Benchmark harness ---

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * p / 100) - 1
  return sorted[Math.max(0, idx)]!
}

function runBenchmark(
  label: string,
  prepared: PreparedText,
  maxWidth: number,
  lineHeight: number,
  iterations: number,
  warmup: number,
): { label: string; medianNs: number; p5Ns: number; p95Ns: number; opsPerSec: number; lineCount: number } {
  // Warmup
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    const r = layout(prepared, maxWidth, lineHeight)
    sink += r.lineCount
  }

  // Measure
  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    // Run a batch to get stable sub-microsecond timing
    for (let j = 0; j < 1000; j++) {
      const r = layout(prepared, maxWidth, lineHeight)
      sink += r.lineCount
    }
    const elapsed = (performance.now() - t0) / 1000 // ms per single call
    timings.push(elapsed * 1e6) // convert to nanoseconds
  }

  // Prevent dead code elimination
  if (sink < 0) console.log(sink)

  const lineCount = layout(prepared, maxWidth, lineHeight).lineCount
  const med = median(timings)

  return {
    label,
    medianNs: med,
    p5Ns: percentile(timings, 5),
    p95Ns: percentile(timings, 95),
    opsPerSec: Math.round(1e9 / med),
    lineCount,
  }
}

// --- Test cases matching real-world patterns ---

const ITERATIONS = 50
const WARMUP = 20

const cases = [
  {
    label: 'Latin short (6 words)',
    prepared: makePrepared({ segmentCount: 11, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 300 }),
    maxWidth: 300,
  },
  {
    label: 'Latin medium (25 words)',
    prepared: makePrepared({ segmentCount: 49, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 400 }),
    maxWidth: 400,
  },
  {
    label: 'Latin long (100 words)',
    prepared: makePrepared({ segmentCount: 199, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 400 }),
    maxWidth: 400,
  },
  {
    label: 'Latin resize sweep (25w)',
    prepared: makePrepared({ segmentCount: 49, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 300 }),
    maxWidth: 300, // will be swept
  },
  {
    label: 'CJK medium (50 chars)',
    prepared: makePrepared({ segmentCount: 99, avgWordWidth: 16, spaceWidth: 4, maxWidth: 300, hasCJK: true }),
    maxWidth: 300,
  },
  {
    label: 'Long word overflow',
    prepared: makePrepared({ segmentCount: 11, avgWordWidth: 200, spaceWidth: 4.4, maxWidth: 200, hasBreakableWords: true }),
    maxWidth: 200,
  },
  {
    label: 'Corpus-scale (500 segs)',
    prepared: makePrepared({ segmentCount: 500, avgWordWidth: 40, spaceWidth: 4.4, maxWidth: 350 }),
    maxWidth: 350,
  },

  // --- Magazine / editorial scale ---
  // Based on real corpus data from benchmarks/chrome.json:
  // Japanese prose: ~5000 segs, 380 lines, all CJK grapheme-breakable
  // Thai prose: ~10000 segs, 8087 breakable, 1024 lines
  // Arabic prose: ~37000 segs, 18745 breakable, 2643 lines
  // Hindi prose: ~10000 segs, 4090 breakable, 653 lines
  {
    label: 'Magazine page (2k segs)',
    prepared: makePrepared({ segmentCount: 2000, avgWordWidth: 42, spaceWidth: 4.4, maxWidth: 350 }),
    maxWidth: 350,
  },
  {
    label: 'CJK editorial (5k segs)',
    prepared: makePrepared({ segmentCount: 5000, avgWordWidth: 16, spaceWidth: 4, maxWidth: 300, hasCJK: true }),
    maxWidth: 300,
  },
  {
    label: 'Thai-like (10k, 80% brk)',
    prepared: makePrepared({ segmentCount: 10000, avgWordWidth: 30, spaceWidth: 3, maxWidth: 300, breakableRatio: 0.8 }),
    maxWidth: 300,
  },
  {
    label: 'Arabic-like (37k, 50% brk)',
    prepared: makePrepared({ segmentCount: 37000, avgWordWidth: 22, spaceWidth: 4, maxWidth: 300, breakableRatio: 0.5 }),
    maxWidth: 300,
  },
  {
    label: 'Mixed long (10k segs)',
    prepared: makePrepared({ segmentCount: 10000, avgWordWidth: 38, spaceWidth: 4.4, maxWidth: 400, breakableRatio: 0.15, seed: 7 }),
    maxWidth: 400,
  },
]

console.log('pretext layout() microbenchmark')
console.log('='.repeat(80))
console.log(`Node ${process.version} | ${ITERATIONS} iterations × 1000 calls | ${WARMUP} warmup batches`)
console.log()

const results: typeof cases extends (infer T)[] ? (T & { medianNs: number })[] : never = [] as any

for (const c of cases) {
  const r = runBenchmark(c.label, c.prepared, c.maxWidth, 20, ITERATIONS, WARMUP)
  results.push({ ...c, ...r })
  console.log(
    `${r.label.padEnd(30)} ${(r.medianNs).toFixed(0).padStart(8)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(7)}ns p5 | ${r.p95Ns.toFixed(0).padStart(7)}ns p95 | ` +
    `${(r.opsPerSec / 1e6).toFixed(2).padStart(6)}M ops/s | ${r.lineCount} lines`
  )
}

// Resize sweep: same prepared text, different widths
console.log()
console.log('Resize sweep (25-word Latin, widths 200-500px):')
const sweepPrepared = makePrepared({ segmentCount: 49, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 500 })
for (const w of [200, 250, 300, 350, 400, 450, 500]) {
  const r = runBenchmark(`  width=${w}px`, sweepPrepared, w, 20, ITERATIONS, WARMUP)
  console.log(
    `${r.label.padEnd(30)} ${(r.medianNs).toFixed(0).padStart(8)}ns median | ` +
    `${r.opsPerSec / 1e6 > 1 ? (r.opsPerSec / 1e6).toFixed(2) + 'M' : (r.opsPerSec / 1e3).toFixed(0) + 'K'} ops/s | ${r.lineCount} lines`
  )
}

// Output JSON summary for easy diffing
const layoutSummary = results.map(r => ({ label: r.label, medianNs: Math.round(r.medianNs), lineCount: r.lineCount }))
console.log()
console.log('JSON summary (layout):')
console.log(JSON.stringify(layoutSummary, null, 2))

// =============================================================================
// walkPreparedLines benchmark (line-walking path used by layoutWithLines)
// =============================================================================

function runWalkBenchmark(
  label: string,
  prepared: PreparedText,
  maxWidth: number,
  iterations: number,
  warmup: number,
): { label: string; medianNs: number; p5Ns: number; p95Ns: number; opsPerSec: number; lineCount: number } {
  const internalPrepared = prepared as unknown as PreparedLineBreakData

  // Warmup
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    const n = walkPreparedLines(internalPrepared, maxWidth, (_line: InternalLayoutLine) => { sink++ })
    sink += n
  }

  // Measure
  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let j = 0; j < 1000; j++) {
      const n = walkPreparedLines(internalPrepared, maxWidth, (_line: InternalLayoutLine) => { sink++ })
      sink += n
    }
    const elapsed = (performance.now() - t0) / 1000
    timings.push(elapsed * 1e6)
  }

  if (sink < 0) console.log(sink)

  let lineCount = 0
  walkPreparedLines(internalPrepared, maxWidth, () => { lineCount++ })
  const med = median(timings)

  return {
    label,
    medianNs: med,
    p5Ns: percentile(timings, 5),
    p95Ns: percentile(timings, 95),
    opsPerSec: Math.round(1e9 / med),
    lineCount,
  }
}

console.log()
console.log()
console.log('pretext walkPreparedLines() microbenchmark (line-walking path)')
console.log('='.repeat(80))
console.log(`Node ${process.version} | ${ITERATIONS} iterations × 1000 calls | ${WARMUP} warmup batches`)
console.log()

// Reuse the same cases for walk benchmarks
const walkCases = [
  { label: 'Walk: Latin short (6w)', prepared: cases[0]!.prepared, maxWidth: cases[0]!.maxWidth },
  { label: 'Walk: Latin medium (25w)', prepared: cases[1]!.prepared, maxWidth: cases[1]!.maxWidth },
  { label: 'Walk: Latin long (100w)', prepared: cases[2]!.prepared, maxWidth: cases[2]!.maxWidth },
  { label: 'Walk: CJK medium (50ch)', prepared: cases[4]!.prepared, maxWidth: cases[4]!.maxWidth },
  { label: 'Walk: Long word overflow', prepared: cases[5]!.prepared, maxWidth: cases[5]!.maxWidth },
  { label: 'Walk: Corpus 500 segs', prepared: cases[6]!.prepared, maxWidth: cases[6]!.maxWidth },
  { label: 'Walk: Magazine 2k segs', prepared: cases[7]!.prepared, maxWidth: cases[7]!.maxWidth },
  { label: 'Walk: CJK editorial 5k', prepared: cases[8]!.prepared, maxWidth: cases[8]!.maxWidth },
  { label: 'Walk: Thai-like 10k', prepared: cases[9]!.prepared, maxWidth: cases[9]!.maxWidth },
  { label: 'Walk: Arabic-like 37k', prepared: cases[10]!.prepared, maxWidth: cases[10]!.maxWidth },
  { label: 'Walk: Mixed long 10k', prepared: cases[11]!.prepared, maxWidth: cases[11]!.maxWidth },
]

const walkResults: { label: string; medianNs: number; lineCount: number }[] = []

for (const c of walkCases) {
  const r = runWalkBenchmark(c.label, c.prepared, c.maxWidth, ITERATIONS, WARMUP)
  walkResults.push(r)
  console.log(
    `${r.label.padEnd(30)} ${(r.medianNs).toFixed(0).padStart(8)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(7)}ns p5 | ${r.p95Ns.toFixed(0).padStart(7)}ns p95 | ` +
    `${(r.opsPerSec / 1e6).toFixed(2).padStart(6)}M ops/s | ${r.lineCount} lines`
  )
}

console.log()
console.log('JSON summary (walk):')
console.log(JSON.stringify(walkResults.map(r => ({ label: r.label, medianNs: Math.round(r.medianNs), lineCount: r.lineCount })), null, 2))

// =============================================================================
// Full-path walkPreparedLines benchmark (non-simple: soft hyphens, chunks, tabs)
// =============================================================================

console.log()
console.log()
console.log('pretext walkPreparedLines() full-path microbenchmark (soft hyphens, chunks)')
console.log('='.repeat(80))
console.log(`Node ${process.version} | ${ITERATIONS} iterations × 1000 calls | ${WARMUP} warmup batches`)
console.log()

const fullCases = [
  {
    label: 'Full: Latin 25w (SHY+HB)',
    prepared: makePreparedFull({ segmentCount: 49, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 400, softHyphenRate: 0.15, hardBreakRate: 0.08 }),
    maxWidth: 400,
  },
  {
    label: 'Full: Latin 100w (SHY+HB)',
    prepared: makePreparedFull({ segmentCount: 199, avgWordWidth: 45, spaceWidth: 4.4, maxWidth: 400, softHyphenRate: 0.15, hardBreakRate: 0.05 }),
    maxWidth: 400,
  },
  {
    label: 'Full: 500 segs (SHY+HB)',
    prepared: makePreparedFull({ segmentCount: 500, avgWordWidth: 40, spaceWidth: 4.4, maxWidth: 350, softHyphenRate: 0.1, hardBreakRate: 0.03 }),
    maxWidth: 350,
  },
  {
    label: 'Full: 2k segs (SHY+HB)',
    prepared: makePreparedFull({ segmentCount: 2000, avgWordWidth: 42, spaceWidth: 4.4, maxWidth: 350, softHyphenRate: 0.1, hardBreakRate: 0.03 }),
    maxWidth: 350,
  },
  {
    label: 'Full: 5k segs (mixed)',
    prepared: makePreparedFull({ segmentCount: 5000, avgWordWidth: 30, spaceWidth: 4, maxWidth: 300, softHyphenRate: 0.08, hardBreakRate: 0.02, breakableRatio: 0.3 }),
    maxWidth: 300,
  },
  {
    label: 'Full: 10k segs (mixed)',
    prepared: makePreparedFull({ segmentCount: 10000, avgWordWidth: 30, spaceWidth: 4, maxWidth: 300, softHyphenRate: 0.08, hardBreakRate: 0.02, breakableRatio: 0.3 }),
    maxWidth: 300,
  },
]

const fullResults: { label: string; medianNs: number; lineCount: number }[] = []

for (const c of fullCases) {
  const r = runWalkBenchmark(c.label, c.prepared, c.maxWidth, ITERATIONS, WARMUP)
  fullResults.push(r)
  console.log(
    `${r.label.padEnd(30)} ${(r.medianNs).toFixed(0).padStart(8)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(7)}ns p5 | ${r.p95Ns.toFixed(0).padStart(7)}ns p95 | ` +
    `${(r.opsPerSec / 1e6).toFixed(2).padStart(6)}M ops/s | ${r.lineCount} lines`
  )
}

console.log()
console.log('JSON summary (full-path walk):')
console.log(JSON.stringify(fullResults.map(r => ({ label: r.label, medianNs: Math.round(r.medianNs), lineCount: r.lineCount })), null, 2))

// =============================================================================
// layoutNextLineRange benchmark (streaming line-by-line API)
// =============================================================================

function runStreamBenchmark(
  label: string,
  prepared: PreparedText,
  maxWidth: number,
  iterations: number,
  warmup: number,
): { label: string; medianNs: number; p5Ns: number; p95Ns: number; opsPerSec: number; lineCount: number } {
  const internalPrepared = prepared as unknown as PreparedLineBreakData

  // Warmup — walk all lines via streaming API
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    let cursor: LineBreakCursor = { segmentIndex: 0, graphemeIndex: 0 }
    let n = 0
    while (true) {
      const line = layoutNextLineRange(internalPrepared, cursor, maxWidth)
      if (line === null) break
      n++
      cursor = { segmentIndex: line.endSegmentIndex, graphemeIndex: line.endGraphemeIndex }
    }
    sink += n
  }

  // Measure — full-text streaming walk per iteration batch
  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let j = 0; j < 1000; j++) {
      let cursor: LineBreakCursor = { segmentIndex: 0, graphemeIndex: 0 }
      while (true) {
        const line = layoutNextLineRange(internalPrepared, cursor, maxWidth)
        if (line === null) break
        sink++
        cursor = { segmentIndex: line.endSegmentIndex, graphemeIndex: line.endGraphemeIndex }
      }
    }
    const elapsed = (performance.now() - t0) / 1000
    timings.push(elapsed * 1e6)
  }

  if (sink < 0) console.log(sink)

  // Count lines
  let lineCount = 0
  let cursor: LineBreakCursor = { segmentIndex: 0, graphemeIndex: 0 }
  while (true) {
    const line = layoutNextLineRange(internalPrepared, cursor, maxWidth)
    if (line === null) break
    lineCount++
    cursor = { segmentIndex: line.endSegmentIndex, graphemeIndex: line.endGraphemeIndex }
  }
  const med = median(timings)

  return {
    label,
    medianNs: med,
    p5Ns: percentile(timings, 5),
    p95Ns: percentile(timings, 95),
    opsPerSec: Math.round(1e9 / med),
    lineCount,
  }
}

console.log()
console.log()
console.log('pretext layoutNextLineRange() microbenchmark (streaming API)')
console.log('='.repeat(80))
console.log(`Node ${process.version} | ${ITERATIONS} iterations × 1000 calls | ${WARMUP} warmup batches`)
console.log()

// Simple-path streaming cases
const streamCases = [
  { label: 'Stream: Latin short (6w)', prepared: cases[0]!.prepared, maxWidth: cases[0]!.maxWidth },
  { label: 'Stream: Latin medium (25w)', prepared: cases[1]!.prepared, maxWidth: cases[1]!.maxWidth },
  { label: 'Stream: Latin long (100w)', prepared: cases[2]!.prepared, maxWidth: cases[2]!.maxWidth },
  { label: 'Stream: Corpus 500 segs', prepared: cases[6]!.prepared, maxWidth: cases[6]!.maxWidth },
  { label: 'Stream: Magazine 2k segs', prepared: cases[7]!.prepared, maxWidth: cases[7]!.maxWidth },
  { label: 'Stream: Mixed 10k segs', prepared: cases[11]!.prepared, maxWidth: cases[11]!.maxWidth },
  // Full-path streaming
  {
    label: 'Stream-F: 2k (SHY+HB)',
    prepared: makePreparedFull({ segmentCount: 2000, avgWordWidth: 42, spaceWidth: 4.4, maxWidth: 350, softHyphenRate: 0.1, hardBreakRate: 0.03 }),
    maxWidth: 350,
  },
  {
    label: 'Stream-F: 10k (mixed)',
    prepared: makePreparedFull({ segmentCount: 10000, avgWordWidth: 30, spaceWidth: 4, maxWidth: 300, softHyphenRate: 0.08, hardBreakRate: 0.02, breakableRatio: 0.3 }),
    maxWidth: 300,
  },
]

const streamResults: { label: string; medianNs: number; lineCount: number }[] = []

for (const c of streamCases) {
  const r = runStreamBenchmark(c.label, c.prepared, c.maxWidth, ITERATIONS, WARMUP)
  streamResults.push(r)
  console.log(
    `${r.label.padEnd(30)} ${(r.medianNs).toFixed(0).padStart(8)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(7)}ns p5 | ${r.p95Ns.toFixed(0).padStart(7)}ns p95 | ` +
    `${(r.opsPerSec / 1e6).toFixed(2).padStart(6)}M ops/s | ${r.lineCount} lines`
  )
}

console.log()
console.log('JSON summary (stream):')
console.log(JSON.stringify(streamResults.map(r => ({ label: r.label, medianNs: Math.round(r.medianNs), lineCount: r.lineCount })), null, 2))
