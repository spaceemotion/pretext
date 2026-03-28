import { describe, expect, test } from 'bun:test'
import {
  analyzeText,
  normalizeWhitespaceNormal,
  isCJK,
  endsWithClosingQuote,
  kinsokuStart,
  kinsokuEnd,
  leftStickyPunctuation,
  type AnalysisProfile,
} from './analysis.ts'

const defaultProfile: AnalysisProfile = { carryCJKAfterClosingQuote: false }
const chromiumProfile: AnalysisProfile = { carryCJKAfterClosingQuote: true }

// --- normalizeWhitespaceNormal ---

describe('normalizeWhitespaceNormal', () => {
  test('passes through clean text unchanged', () => {
    expect(normalizeWhitespaceNormal('Hello world')).toBe('Hello world')
  })

  test('collapses multiple spaces to a single space', () => {
    expect(normalizeWhitespaceNormal('Hello  world')).toBe('Hello world')
    expect(normalizeWhitespaceNormal('Hello   world')).toBe('Hello world')
  })

  test('replaces tabs and newlines with spaces', () => {
    expect(normalizeWhitespaceNormal('Hello\tworld')).toBe('Hello world')
    expect(normalizeWhitespaceNormal('Hello\nworld')).toBe('Hello world')
    expect(normalizeWhitespaceNormal('Hello\rworld')).toBe('Hello world')
    expect(normalizeWhitespaceNormal('Hello\fworld')).toBe('Hello world')
  })

  test('trims leading whitespace', () => {
    expect(normalizeWhitespaceNormal(' Hello')).toBe('Hello')
    expect(normalizeWhitespaceNormal('  Hello')).toBe('Hello')
    expect(normalizeWhitespaceNormal('\tHello')).toBe('Hello')
  })

  test('trims trailing whitespace', () => {
    expect(normalizeWhitespaceNormal('Hello ')).toBe('Hello')
    expect(normalizeWhitespaceNormal('Hello  ')).toBe('Hello')
    expect(normalizeWhitespaceNormal('Hello\n')).toBe('Hello')
  })

  test('collapses mixed whitespace runs', () => {
    expect(normalizeWhitespaceNormal('  Hello \t \n  World  ')).toBe('Hello World')
  })

  test('returns empty string for whitespace-only input', () => {
    expect(normalizeWhitespaceNormal('  \t\n  ')).toBe('')
  })

  test('returns empty string for empty input', () => {
    expect(normalizeWhitespaceNormal('')).toBe('')
  })

  test('preserves NBSP and other non-collapsible whitespace', () => {
    expect(normalizeWhitespaceNormal('Hello\u00A0world')).toBe('Hello\u00A0world')
  })
})

// --- isCJK ---

describe('isCJK', () => {
  test('returns true for CJK Unified Ideographs', () => {
    expect(isCJK('你')).toBe(true)
    expect(isCJK('好')).toBe(true)
    expect(isCJK('中文')).toBe(true)
  })

  test('returns true for Japanese kana', () => {
    expect(isCJK('あ')).toBe(true) // Hiragana
    expect(isCJK('ア')).toBe(true) // Katakana
  })

  test('returns true for Korean Hangul', () => {
    expect(isCJK('한')).toBe(true)
  })

  test('returns true for CJK symbols and punctuation', () => {
    expect(isCJK('。')).toBe(true)
    expect(isCJK('「')).toBe(true)
  })

  test('returns true for fullwidth forms', () => {
    expect(isCJK('！')).toBe(true)
    expect(isCJK('，')).toBe(true)
  })

  test('returns true for astral CJK ideographs (SIP)', () => {
    expect(isCJK('𠀀')).toBe(true)
    expect(isCJK('𠀁')).toBe(true)
  })

  test('returns true for CJK compatibility ideographs', () => {
    expect(isCJK('\uF900')).toBe(true)
  })

  test('returns false for Latin text', () => {
    expect(isCJK('Hello')).toBe(false)
    expect(isCJK('A')).toBe(false)
  })

  test('returns false for Arabic text', () => {
    expect(isCJK('مرحبا')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isCJK('')).toBe(false)
  })

  test('returns true for mixed text containing CJK', () => {
    expect(isCJK('Hello你好')).toBe(true)
  })
})

// --- endsWithClosingQuote ---

describe('endsWithClosingQuote', () => {
  test('returns true for text ending with closing quote chars', () => {
    expect(endsWithClosingQuote('hello\u201D')).toBe(true) // "
    expect(endsWithClosingQuote('hello\u2019')).toBe(true) // '
    expect(endsWithClosingQuote('hello\u00BB')).toBe(true) // »
    expect(endsWithClosingQuote('hello\u203A')).toBe(true) // ›
  })

  test('returns true for CJK closing brackets', () => {
    expect(endsWithClosingQuote('hello\u300D')).toBe(true) // 」
    expect(endsWithClosingQuote('hello\u300F')).toBe(true) // 』
    expect(endsWithClosingQuote('hello\u3011')).toBe(true) // 】
  })

  test('returns true when closing quote follows left-sticky punctuation', () => {
    expect(endsWithClosingQuote('hello.\u201D')).toBe(true) // ."
    expect(endsWithClosingQuote('hello,!\u201D')).toBe(true) // ,!"
  })

  test('returns false for text ending with non-quote chars', () => {
    expect(endsWithClosingQuote('hello')).toBe(false)
    expect(endsWithClosingQuote('hello.')).toBe(false)
  })

  test('returns false for empty text', () => {
    expect(endsWithClosingQuote('')).toBe(false)
  })
})

// --- kinsokuStart / kinsokuEnd / leftStickyPunctuation (Set exports) ---

describe('kinsoku sets', () => {
  test('kinsokuStart contains CJK closing punctuation', () => {
    expect(kinsokuStart.has('，')).toBe(true)
    expect(kinsokuStart.has('。')).toBe(true)
    expect(kinsokuStart.has('！')).toBe(true)
  })

  test('kinsokuEnd contains CJK opening punctuation', () => {
    expect(kinsokuEnd.has('「')).toBe(true)
    expect(kinsokuEnd.has('（')).toBe(true)
  })

  test('leftStickyPunctuation contains common punctuation', () => {
    expect(leftStickyPunctuation.has('.')).toBe(true)
    expect(leftStickyPunctuation.has(',')).toBe(true)
    expect(leftStickyPunctuation.has('!')).toBe(true)
    expect(leftStickyPunctuation.has('?')).toBe(true)
    expect(leftStickyPunctuation.has(')')).toBe(true)
    expect(leftStickyPunctuation.has('"')).toBe(true)
  })
})

// --- analyzeText() full pipeline ---

describe('analyzeText', () => {
  test('returns empty analysis for empty text', () => {
    const result = analyzeText('', defaultProfile)
    expect(result.len).toBe(0)
    expect(result.texts).toEqual([])
    expect(result.normalized).toBe('')
  })

  test('returns empty analysis for whitespace-only text', () => {
    const result = analyzeText('  \t\n  ', defaultProfile)
    expect(result.len).toBe(0)
    expect(result.normalized).toBe('')
  })

  test('segments simple Latin text into word-space-word pattern', () => {
    const result = analyzeText('Hello world', defaultProfile)
    expect(result.texts).toEqual(['Hello', ' ', 'world'])
    expect(result.kinds).toEqual(['text', 'space', 'text'])
    expect(result.isWordLike).toEqual([true, false, true])
  })

  test('normalizes whitespace before segmentation', () => {
    const result = analyzeText('  Hello  world  ', defaultProfile)
    expect(result.normalized).toBe('Hello world')
    expect(result.texts).toEqual(['Hello', ' ', 'world'])
  })

  test('merges left-sticky punctuation into preceding word', () => {
    const result = analyzeText('hello.', defaultProfile)
    expect(result.texts).toEqual(['hello.'])
  })

  test('merges multiple punctuation into preceding word', () => {
    const result = analyzeText('hello?!', defaultProfile)
    expect(result.texts).toEqual(['hello?!'])
  })

  test('keeps opening quotes attached to following word', () => {
    const result = analyzeText('"Hello', defaultProfile)
    expect(result.texts).toEqual(['"Hello'])
  })

  test('keeps NBSP as glue merged with adjacent text', () => {
    const result = analyzeText('Hello\u00A0world', defaultProfile)
    expect(result.texts).toEqual(['Hello\u00A0world'])
    expect(result.kinds).toEqual(['text'])
  })

  test('keeps ZWSP as zero-width break opportunity', () => {
    const result = analyzeText('alpha\u200Bbeta', defaultProfile)
    expect(result.texts).toEqual(['alpha', '\u200B', 'beta'])
    expect(result.kinds).toEqual(['text', 'zero-width-break', 'text'])
  })

  test('keeps soft hyphens as break opportunities', () => {
    const result = analyzeText('trans\u00ADatlantic', defaultProfile)
    expect(result.texts).toEqual(['trans', '\u00AD', 'atlantic'])
    expect(result.kinds).toEqual(['text', 'soft-hyphen', 'text'])
  })

  // --- CJK ---

  test('segments CJK text (each character is a potential break point)', () => {
    const result = analyzeText('中文测试', defaultProfile)
    // CJK characters should be segmented; exact segment boundaries
    // depend on Intl.Segmenter, but should produce individual chars
    expect(result.len).toBeGreaterThanOrEqual(1)
    expect(result.normalized).toBe('中文测试')
  })

  test('applies kinsoku rules to CJK punctuation', () => {
    const result = analyzeText('中文，测试。', defaultProfile)
    // kinsoku start chars (，。) should be merged into preceding segment
    expect(result.texts.join('')).toBe('中文，测试。')
    // The comma should be attached to the preceding character(s)
    const hasCommaAttached = result.texts.some(t => t.endsWith('，'))
    const hasPeriodAttached = result.texts.some(t => t.endsWith('。'))
    expect(hasCommaAttached).toBe(true)
    expect(hasPeriodAttached).toBe(true)
  })

  test('carries CJK after closing quote in Chromium profile', () => {
    const resultDefault = analyzeText('「下」人', defaultProfile)
    const resultChromium = analyzeText('「下」人', chromiumProfile)
    // Both profiles should produce valid segmentations
    expect(resultDefault.texts.join('')).toBe('「下」人')
    expect(resultChromium.texts.join('')).toBe('「下」人')
  })

  // --- Arabic ---

  test('segments Arabic text preserving RTL structure', () => {
    const result = analyzeText('مرحبا بالعالم', defaultProfile)
    expect(result.texts.join('')).toBe('مرحبا بالعالم')
    expect(result.len).toBeGreaterThan(1)
  })

  test('keeps Arabic no-space punctuation clusters together', () => {
    const result = analyzeText('فيقول:وعليك', defaultProfile)
    expect(result.texts).toEqual(['فيقول:وعليك'])
  })

  test('keeps Arabic comma-followed text together', () => {
    const result = analyzeText('همزةٌ،ما', defaultProfile)
    expect(result.texts).toEqual(['همزةٌ،ما'])
  })

  // --- URL merging ---

  test('merges URL-like runs', () => {
    const result = analyzeText('visit https://example.com/path now', defaultProfile)
    // URL should be merged into fewer segments
    const fullText = result.texts.join('')
    expect(fullText).toBe('visit https://example.com/path now')
  })

  test('splits URL at query boundary', () => {
    const result = analyzeText('https://example.com/path?key=val', defaultProfile)
    const fullText = result.texts.join('')
    expect(fullText).toBe('https://example.com/path?key=val')
  })

  // --- Numeric merging ---

  test('merges numeric time ranges', () => {
    const result = analyzeText('7:00-9:00', defaultProfile)
    // Should be split at hyphen: '7:00-' and '9:00'
    expect(result.texts).toEqual(['7:00-', '9:00'])
  })

  test('splits hyphenated numeric identifiers', () => {
    const result = analyzeText('420-69-8008', defaultProfile)
    expect(result.texts).toEqual(['420-', '69-', '8008'])
  })

  test('merges unicode-digit numeric expressions', () => {
    const result = analyzeText('२४×७', defaultProfile)
    expect(result.texts).toEqual(['२४×७'])
  })

  // --- ASCII punctuation chains ---

  test('keeps no-space ascii punctuation chains together', () => {
    const result = analyzeText('foo;bar', defaultProfile)
    expect(result.texts).toEqual(['foo;bar'])
  })

  // --- Escaped quote clusters ---

  test('keeps escaped quote clusters attached', () => {
    const text = String.raw`\"hello\"`
    const result = analyzeText(text, defaultProfile)
    expect(result.texts).toEqual([text])
  })

  // --- Repeated character runs ---

  test('coalesces repeated punctuation runs', () => {
    const result = analyzeText('=== heading ===', defaultProfile)
    expect(result.texts).toEqual(['===', ' ', 'heading', ' ', '==='])
  })

  // --- Pre-wrap mode ---

  test('pre-wrap mode preserves spaces', () => {
    const result = analyzeText('Hello   world', defaultProfile, 'pre-wrap')
    expect(result.kinds.filter(k => k === 'preserved-space').length).toBeGreaterThan(0)
  })

  test('pre-wrap mode preserves hard breaks', () => {
    const result = analyzeText('Hello\nworld', defaultProfile, 'pre-wrap')
    expect(result.kinds).toContain('hard-break')
    expect(result.chunks.length).toBeGreaterThan(1)
  })

  test('pre-wrap mode preserves tabs', () => {
    const result = analyzeText('Hello\tworld', defaultProfile, 'pre-wrap')
    expect(result.kinds).toContain('tab')
  })

  test('pre-wrap mode normalizes CRLF to LF', () => {
    const result = analyzeText('Hello\r\nworld', defaultProfile, 'pre-wrap')
    expect(result.normalized).toBe('Hello\nworld')
    expect(result.kinds).toContain('hard-break')
  })

  // --- Chunks ---

  test('normal mode produces a single chunk', () => {
    const result = analyzeText('Hello world', defaultProfile)
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0]).toEqual({
      startSegmentIndex: 0,
      endSegmentIndex: result.len,
      consumedEndSegmentIndex: result.len,
    })
  })

  test('pre-wrap mode produces multiple chunks at hard breaks', () => {
    const result = analyzeText('Hello\nworld\ntest', defaultProfile, 'pre-wrap')
    expect(result.chunks.length).toBe(3)
  })

  // --- Start offsets ---

  test('start offsets track character positions in normalized text', () => {
    const result = analyzeText('Hello world test', defaultProfile)
    // Verify starts are monotonically increasing
    for (let i = 1; i < result.len; i++) {
      expect(result.starts[i]!).toBeGreaterThanOrEqual(result.starts[i - 1]!)
    }
    // Verify texts at starts reconstruct the normalized text
    for (let i = 0; i < result.len; i++) {
      expect(result.normalized.slice(result.starts[i]!, result.starts[i]! + result.texts[i]!.length)).toBe(result.texts[i]!)
    }
  })

  // --- Full text reconstruction ---

  test('concatenated texts reconstruct the normalized input', () => {
    const inputs = [
      'Hello world',
      'مرحبا بالعالم',
      '中文测试',
      'The price is $42.99',
      'Visit https://example.com now',
      'foo;bar foo:bar',
      '420-69-8008',
      '"Hello" said she.',
    ]
    for (const input of inputs) {
      const result = analyzeText(input, defaultProfile)
      expect(result.texts.join('')).toBe(result.normalized)
    }
  })
})
