/**
 * Node.js microbenchmark for the bidi algorithm in bidi.ts.
 *
 * Exercises computeSegmentLevels() across different text profiles:
 * - Pure Latin (early exit — null return)
 * - Pure Hebrew RTL
 * - Pure Arabic RTL
 * - Mixed LTR/RTL
 * - Long texts (~5000 chars)
 *
 * Usage: npx tsx scripts/bench-bidi.ts
 */

import { computeSegmentLevels } from '../src/bidi.ts'

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

// --- Test corpus ---

// Pure Latin — should early-exit (null)
const LATIN_SHORT = 'The quick brown fox jumps over the lazy dog.'
const LATIN_LONG = 'In the heart of every great software project lies a careful balance between correctness and performance. When we first started building this text layout engine, we knew that the measurement phase would be the bottleneck. Traditional DOM-based approaches force synchronous layout reflows, and when components independently measure text, each measurement triggers a reflow of the entire document. This creates read-write interleaving that can cost thirty milliseconds or more per frame for five hundred text blocks. The solution is a two-phase measurement centered around canvas measureText. The first phase segments text via Intl.Segmenter, measures each word via canvas, caches widths, and does one cached DOM calibration read per font when emoji correction is needed. The second phase walks cached word widths with pure arithmetic to count lines and compute height.'

// Pure Hebrew RTL
const HEBREW_SHORT = 'שלום עולם זה טקסט בעברית'
const HEBREW_MEDIUM = 'בראשית ברא אלהים את השמים ואת הארץ והארץ היתה תהו ובהו וחשך על פני תהום ורוח אלהים מרחפת על פני המים'

// Pure Arabic RTL
const ARABIC_SHORT = 'مرحبا بالعالم هذا نص باللغة العربية'
const ARABIC_MEDIUM = 'هذا النص باللغة العربية لاختبار دعم الاتجاه من اليمين إلى اليسار في مكتبة تخطيط النص. مرحبا بالعالم، هذه تجربة لقياس النص العربي وكسر الأسطر بشكل صحيح'

// Mixed LTR/RTL
const MIXED_SHORT = 'Hello שלום world עולם test'
const MIXED_MEDIUM = 'The price is $42.99 (approximately ٤٢٫٩٩ ريال). Visit the website for more details. هذه صفحة تجريبية with English and Arabic mixed content for testing.'
const MIXED_APP = 'Hello مرحبا שלום 你好 こんにちは 안녕하세요 สวัสดี! Visit https://example.com/reports/q3?lang=ar&mode=full for details. The price is $42.99 (approximately ٤٢٫٩٩ ريال). Version 3.2.1 של התוכנה was released.'

// Long texts (~5000 chars)
const HEBREW_LONG = HEBREW_MEDIUM.repeat(50)
const ARABIC_LONG = ARABIC_MEDIUM.repeat(30)
const MIXED_LONG = MIXED_APP.repeat(25)

// Build segment starts for a text (simple: every word boundary)
function buildSegStarts(text: string): number[] {
  const starts: number[] = [0]
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const p = text.charCodeAt(i - 1)
    // Break at space boundaries
    if (c === 0x20 || p === 0x20) {
      starts.push(i)
    }
  }
  return starts
}

// Pre-compute segment starts for all corpora
const corpora = {
  'Latin short (45ch)': { text: LATIN_SHORT, segStarts: buildSegStarts(LATIN_SHORT) },
  'Latin long (700ch)': { text: LATIN_LONG, segStarts: buildSegStarts(LATIN_LONG) },
  'Hebrew short (24ch)': { text: HEBREW_SHORT, segStarts: buildSegStarts(HEBREW_SHORT) },
  'Hebrew medium (100ch)': { text: HEBREW_MEDIUM, segStarts: buildSegStarts(HEBREW_MEDIUM) },
  'Arabic short (35ch)': { text: ARABIC_SHORT, segStarts: buildSegStarts(ARABIC_SHORT) },
  'Arabic medium (160ch)': { text: ARABIC_MEDIUM, segStarts: buildSegStarts(ARABIC_MEDIUM) },
  'Mixed short (26ch)': { text: MIXED_SHORT, segStarts: buildSegStarts(MIXED_SHORT) },
  'Mixed medium (160ch)': { text: MIXED_MEDIUM, segStarts: buildSegStarts(MIXED_MEDIUM) },
  'Mixed app (220ch)': { text: MIXED_APP, segStarts: buildSegStarts(MIXED_APP) },
  'Hebrew long (~5000ch)': { text: HEBREW_LONG, segStarts: buildSegStarts(HEBREW_LONG) },
  'Arabic long (~5000ch)': { text: ARABIC_LONG, segStarts: buildSegStarts(ARABIC_LONG) },
  'Mixed long (~5500ch)': { text: MIXED_LONG, segStarts: buildSegStarts(MIXED_LONG) },
} as const

type BenchResult = {
  label: string
  medianNs: number
  p5Ns: number
  p95Ns: number
  opsPerSec: number
  textLen: number
  segCount: number
  returnsNull: boolean
}

function runBidiBenchmark(
  label: string,
  text: string,
  segStarts: number[],
  iterations: number,
  warmup: number,
  batchSize: number,
): BenchResult {
  // Warmup
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    const r = computeSegmentLevels(text, segStarts)
    sink += (r === null ? 0 : r.length)
  }

  // Measure
  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let j = 0; j < batchSize; j++) {
      const r = computeSegmentLevels(text, segStarts)
      sink += (r === null ? 0 : r.length)
    }
    const elapsed = (performance.now() - t0) / batchSize // ms per call
    timings.push(elapsed * 1e6) // ns
  }

  if (sink < 0) console.log(sink)

  const result = computeSegmentLevels(text, segStarts)
  const med = median(timings)

  return {
    label,
    medianNs: med,
    p5Ns: percentile(timings, 5),
    p95Ns: percentile(timings, 95),
    opsPerSec: Math.round(1e9 / med),
    textLen: text.length,
    segCount: segStarts.length,
    returnsNull: result === null,
  }
}

// --- Main ---

const ITERATIONS = 50
const WARMUP = 20

console.log('pretext computeSegmentLevels() microbenchmark')
console.log('='.repeat(100))
console.log(`Node ${process.version} | ${ITERATIONS} iterations | ${WARMUP} warmup`)
console.log()

// Determine batch sizes based on text length
function batchFor(len: number): number {
  if (len < 100) return 50000
  if (len < 500) return 10000
  if (len < 2000) return 2000
  return 500
}

console.log('computeSegmentLevels() — full pipeline')
console.log('-'.repeat(100))

const results: BenchResult[] = []

for (const [label, { text, segStarts }] of Object.entries(corpora)) {
  const batch = batchFor(text.length)
  const r = runBidiBenchmark(label, text, segStarts, ITERATIONS, WARMUP, batch)
  results.push(r)
  const nullTag = r.returnsNull ? ' [null]' : ''
  console.log(
    `${r.label.padEnd(24)} ${r.medianNs.toFixed(0).padStart(10)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(9)}ns p5 | ${r.p95Ns.toFixed(0).padStart(9)}ns p95 | ` +
    `${r.opsPerSec > 1e6 ? (r.opsPerSec / 1e6).toFixed(2).padStart(8) + 'M ops/s' : (r.opsPerSec / 1e3).toFixed(1).padStart(8) + 'K ops/s'}` +
    ` | ${String(r.textLen).padStart(5)}ch ${String(r.segCount).padStart(4)}segs${nullTag}`
  )
}

console.log()
console.log('JSON summary:')
console.log(JSON.stringify(
  results.map(r => ({
    label: r.label,
    medianNs: Math.round(r.medianNs),
    textLen: r.textLen,
    segCount: r.segCount,
    returnsNull: r.returnsNull,
  })),
  null,
  2,
))
