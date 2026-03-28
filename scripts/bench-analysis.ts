/**
 * Node.js microbenchmark for the analyzeText() pipeline in analysis.ts.
 *
 * Exercises the full text-analysis path: whitespace normalization,
 * Intl.Segmenter segmentation, break-kind classification, merge loop,
 * and all post-merge passes (glue, URL, numeric, CJK, etc.).
 *
 * Usage: npx tsx scripts/bench-analysis.ts
 */

import {
  analyzeText,
  normalizeWhitespaceNormal,
  isCJK,
  endsWithClosingQuote,
  type AnalysisProfile,
  type WhiteSpaceMode,
} from '../src/analysis.ts'

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

// Default profile in Node (no navigator → Chromium defaults)
const profile: AnalysisProfile = {
  carryCJKAfterClosingQuote: false,
}

const LATIN_SHORT = 'The quick brown fox jumps over the lazy dog.'

const LATIN_MEDIUM = `Just tried the new update and it's so much better. The performance improvements are really noticeable, especially on older devices. Does anyone know if this works with the latest version? I've been having some issues since the upgrade.`

// ~2000 chars of realistic paragraph-length Latin text
const LATIN_LONG = `In the heart of every great software project lies a careful balance between correctness and performance. When we first started building this text layout engine, we knew that the measurement phase would be the bottleneck. Traditional DOM-based approaches force synchronous layout reflows, and when components independently measure text, each measurement triggers a reflow of the entire document. This creates read-write interleaving that can cost thirty milliseconds or more per frame for five hundred text blocks. The solution is a two-phase measurement centered around canvas measureText. The first phase segments text via Intl.Segmenter, measures each word via canvas, caches widths, and does one cached DOM calibration read per font when emoji correction is needed. The second phase walks cached word widths with pure arithmetic to count lines and compute height. The key insight is that word widths are independent of container width, so a single prepare call enables unlimited relayouts. This gives us sub-microsecond layout times even for magazine-page-length text blocks.`

const CJK_TEXT = '这是一段中文文本，用于测试文本布局库对中日韩字符的支持。每个字符之间都可以断行。性能测试显示，新的文本测量方法比传统方法快了将近一千五百倍。これはテキストレイアウトライブラリのテストです。日本語のテキストを正しく処理できるか確認します。パフォーマンスは非常に重要です。'

const ARABIC_TEXT = 'هذا النص باللغة العربية لاختبار دعم الاتجاه من اليمين إلى اليسار في مكتبة تخطيط النص. مرحبا بالعالم، هذه تجربة لقياس النص العربي وكسر الأسطر بشكل صحيح. همزةٌ،ما كان فيقول:وعليك السلام وحوارى بكشء،ٍ من قولهم'

const MIXED_APP_TEXT = `Hello مرحبا שלום 你好 こんにちは 안녕하세요 สวัสดี! Visit https://example.com/reports/q3?lang=ar&mode=full for details. The price is $42.99 (approximately ٤٢٫٩٩ ريال). SSN 420-69-8008. Window 7:00-9:00 only. Said "hello" and she replied \"goodbye\" quickly. foo;bar foo:bar as;lkdfjals;k. Version 3.2.1 של התוכנה was released.`

const PRE_WRAP_TEXT = 'Hello   World\n\nThis is a\ttest\twith\ttabs.\n  Indented line.\r\nCRLF normalized.\n\n\nMultiple breaks.'

// Long magazine-page CJK (~5000 chars)
const CJK_LONG = CJK_TEXT.repeat(30)

// Long Arabic prose (~5000 chars)
const ARABIC_LONG = ARABIC_TEXT.repeat(20)

// Long mixed app text (~5000 chars)
const MIXED_LONG = MIXED_APP_TEXT.repeat(15)

// --- Benchmark runner ---

type BenchResult = {
  label: string
  medianNs: number
  p5Ns: number
  p95Ns: number
  opsPerSec: number
  segmentCount: number
}

function runAnalysisBenchmark(
  label: string,
  text: string,
  whiteSpace: WhiteSpaceMode,
  iterations: number,
  warmup: number,
  batchSize: number,
): BenchResult {
  // Warmup
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    const r = analyzeText(text, profile, whiteSpace)
    sink += r.len
  }

  // Measure
  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let j = 0; j < batchSize; j++) {
      const r = analyzeText(text, profile, whiteSpace)
      sink += r.len
    }
    const elapsed = (performance.now() - t0) / batchSize // ms per single call
    timings.push(elapsed * 1e6) // convert to nanoseconds
  }

  // Prevent dead code elimination
  if (sink < 0) console.log(sink)

  const result = analyzeText(text, profile, whiteSpace)
  const med = median(timings)

  return {
    label,
    medianNs: med,
    p5Ns: percentile(timings, 5),
    p95Ns: percentile(timings, 95),
    opsPerSec: Math.round(1e9 / med),
    segmentCount: result.len,
  }
}

// --- Helper benchmarks ---

function runHelperBenchmark(
  label: string,
  fn: () => unknown,
  iterations: number,
  warmup: number,
  batchSize: number,
): { label: string; medianNs: number; p5Ns: number; p95Ns: number; opsPerSec: number } {
  let sink: unknown = 0
  for (let i = 0; i < warmup; i++) {
    sink = fn()
  }

  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let j = 0; j < batchSize; j++) {
      sink = fn()
    }
    const elapsed = (performance.now() - t0) / batchSize
    timings.push(elapsed * 1e6)
  }

  if ((sink as number) < -Infinity) console.log(sink)

  const med = median(timings)
  return {
    label,
    medianNs: med,
    p5Ns: percentile(timings, 5),
    p95Ns: percentile(timings, 95),
    opsPerSec: Math.round(1e9 / med),
  }
}

// =============================================================================
// Main benchmark suite
// =============================================================================

const ITERATIONS = 50
const WARMUP = 20

console.log('pretext analyzeText() microbenchmark')
console.log('='.repeat(90))
console.log(`Node ${process.version} | ${ITERATIONS} iterations | ${WARMUP} warmup`)
console.log()

// --- analyzeText() full pipeline ---

console.log('analyzeText() full pipeline — normal mode')
console.log('-'.repeat(90))

const analysisCases: Array<{
  label: string
  text: string
  whiteSpace: WhiteSpaceMode
  batchSize: number
}> = [
  { label: 'Latin short (45ch)', text: LATIN_SHORT, whiteSpace: 'normal', batchSize: 1000 },
  { label: 'Latin medium (240ch)', text: LATIN_MEDIUM, whiteSpace: 'normal', batchSize: 500 },
  { label: 'Latin long (1000ch)', text: LATIN_LONG, whiteSpace: 'normal', batchSize: 200 },
  { label: 'CJK mixed (230ch)', text: CJK_TEXT, whiteSpace: 'normal', batchSize: 500 },
  { label: 'Arabic (250ch)', text: ARABIC_TEXT, whiteSpace: 'normal', batchSize: 500 },
  { label: 'Mixed app (360ch)', text: MIXED_APP_TEXT, whiteSpace: 'normal', batchSize: 200 },
  { label: 'CJK long (~5000ch)', text: CJK_LONG, whiteSpace: 'normal', batchSize: 50 },
  { label: 'Arabic long (~5000ch)', text: ARABIC_LONG, whiteSpace: 'normal', batchSize: 50 },
  { label: 'Mixed long (~5000ch)', text: MIXED_LONG, whiteSpace: 'normal', batchSize: 50 },
]

const analysisResults: BenchResult[] = []

for (const c of analysisCases) {
  const r = runAnalysisBenchmark(c.label, c.text, c.whiteSpace, ITERATIONS, WARMUP, c.batchSize)
  analysisResults.push(r)
  console.log(
    `${r.label.padEnd(28)} ${r.medianNs.toFixed(0).padStart(10)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(9)}ns p5 | ${r.p95Ns.toFixed(0).padStart(9)}ns p95 | ` +
    `${(r.opsPerSec / 1e3).toFixed(1).padStart(8)}K ops/s | ${r.segmentCount} segs`
  )
}

// --- pre-wrap mode ---

console.log()
console.log('analyzeText() — pre-wrap mode')
console.log('-'.repeat(90))

const preWrapCases: Array<{
  label: string
  text: string
  whiteSpace: WhiteSpaceMode
  batchSize: number
}> = [
  { label: 'Pre-wrap short', text: PRE_WRAP_TEXT, whiteSpace: 'pre-wrap', batchSize: 500 },
  { label: 'Pre-wrap long', text: PRE_WRAP_TEXT.repeat(30), whiteSpace: 'pre-wrap', batchSize: 50 },
]

for (const c of preWrapCases) {
  const r = runAnalysisBenchmark(c.label, c.text, c.whiteSpace, ITERATIONS, WARMUP, c.batchSize)
  analysisResults.push(r)
  console.log(
    `${r.label.padEnd(28)} ${r.medianNs.toFixed(0).padStart(10)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(9)}ns p5 | ${r.p95Ns.toFixed(0).padStart(9)}ns p95 | ` +
    `${(r.opsPerSec / 1e3).toFixed(1).padStart(8)}K ops/s | ${r.segmentCount} segs`
  )
}

// --- Helper function benchmarks ---

console.log()
console.log('Helper functions — hot-path micro')
console.log('-'.repeat(90))

const HELPER_BATCH = 10000

const helperCases = [
  {
    label: 'normalizeWS (clean)',
    fn: () => normalizeWhitespaceNormal('Hello world this is clean text'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'normalizeWS (dirty)',
    fn: () => normalizeWhitespaceNormal('  Hello \t world  \n this  is  dirty  '),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'isCJK (latin)',
    fn: () => isCJK('Hello'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'isCJK (cjk)',
    fn: () => isCJK('你好'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'isCJK (mixed)',
    fn: () => isCJK('Hello你好'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'isCJK (astral)',
    fn: () => isCJK('𠀀'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'endsWithClosingQuote (y)',
    fn: () => endsWithClosingQuote('hello"'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'endsWithClosingQuote (n)',
    fn: () => endsWithClosingQuote('hello'),
    batchSize: HELPER_BATCH,
  },
  {
    label: 'normalizeWS (long clean)',
    fn: () => normalizeWhitespaceNormal(LATIN_LONG),
    batchSize: 5000,
  },
  {
    label: 'normalizeWS (long dirty)',
    fn: () => normalizeWhitespaceNormal(LATIN_LONG.replace(/\./g, '.\n ')),
    batchSize: 5000,
  },
]

for (const c of helperCases) {
  const r = runHelperBenchmark(c.label, c.fn, ITERATIONS, WARMUP, c.batchSize)
  console.log(
    `${r.label.padEnd(28)} ${r.medianNs.toFixed(0).padStart(10)}ns median | ` +
    `${r.p5Ns.toFixed(0).padStart(9)}ns p5 | ${r.p95Ns.toFixed(0).padStart(9)}ns p95 | ` +
    `${r.opsPerSec > 1e6 ? (r.opsPerSec / 1e6).toFixed(2).padStart(8) + 'M ops/s' : (r.opsPerSec / 1e3).toFixed(1).padStart(8) + 'K ops/s'}`
  )
}

// --- JSON summary ---

console.log()
console.log('JSON summary (analyzeText):')
console.log(JSON.stringify(
  analysisResults.map(r => ({
    label: r.label,
    medianNs: Math.round(r.medianNs),
    segmentCount: r.segmentCount,
  })),
  null,
  2,
))
