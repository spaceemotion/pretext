import { describe, expect, test } from 'bun:test'
import { computeSegmentLevels } from './bidi.ts'

// --- Pure LTR text (should return null — early exit) ---

describe('computeSegmentLevels — LTR early exit', () => {
  test('returns null for empty string', () => {
    expect(computeSegmentLevels('', [0])).toBe(null)
  })

  test('returns null for pure ASCII text', () => {
    expect(computeSegmentLevels('Hello world', [0, 5, 6])).toBe(null)
  })

  test('returns null for Latin extended text', () => {
    expect(computeSegmentLevels('Héllo wörld café', [0, 6, 7, 13, 14])).toBe(null)
  })

  test('returns null for CJK text (classified as L)', () => {
    expect(computeSegmentLevels('你好世界', [0, 1, 2, 3])).toBe(null)
  })
})

// --- Pure RTL text ---

describe('computeSegmentLevels — pure RTL', () => {
  test('Hebrew text has RTL levels (odd)', () => {
    // Hebrew characters are 'R' type (0x0590-0x05F4)
    const text = 'שלום עולם'
    const segStarts = [0, 4, 5] // "שלום", " ", "עולם"
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // In RTL paragraph (startLevel=1), R stays at 1
    expect(levels![0]).toBe(1)
    expect(levels![2]).toBe(1)
  })

  test('Arabic text has RTL levels (odd)', () => {
    // Arabic characters are 'AL' type (0x0600-0x06FF)
    const text = 'مرحبا بالعالم'
    const segStarts = [0, 5, 6] // "مرحبا", " ", "بالعالم"
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels![0]).toBe(1)
    expect(levels![2]).toBe(1)
  })
})

// --- Mixed LTR/RTL text ---
// Note: The simplified bidi algorithm uses (len / numBidi) < 0.3 for paragraph
// direction. Since numBidi <= len, len/numBidi >= 1 > 0.3 always, so startLevel
// is always 1 (RTL paragraph) when any bidi chars exist. This means:
// - RTL chars get level 1 (I2: odd level, R/AN/EN → level++)
// - LTR chars get level 2 (I1: even level check fails since level is 1/odd,
//   but I2 applies: L on odd level → level++)

describe('computeSegmentLevels — mixed bidi', () => {
  test('mixed Latin and Hebrew', () => {
    const text = 'Hello שלום world'
    // segStarts at: "Hello", " ", "שלום", " ", "world"
    const segStarts = [0, 5, 6, 10, 11]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // startLevel=1 (RTL paragraph)
    // Latin (L) on odd level → I2 bumps to 2
    expect(levels![0]).toBe(2) // "Hello"
    expect(levels![4]).toBe(2) // "world"
    // Hebrew (R) stays at 1
    expect(levels![2]).toBe(1) // "שלום"
  })

  test('mixed Latin and Arabic', () => {
    const text = 'Hello مرحبا world'
    const segStarts = [0, 5, 6, 11, 12]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // Latin on odd level → 2
    expect(levels![0]).toBe(2) // "Hello"
    expect(levels![4]).toBe(2) // "world"
    // Arabic (AL→R after W3) stays at 1
    expect(levels![2]).toBe(1) // "مرحبا"
  })

  test('single Hebrew char in Latin text', () => {
    // Even with few bidi chars, startLevel is always 1
    const text = 'abc א xyz'
    const segStarts = [0, 3, 4, 5, 6]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // L on odd level → 2
    expect(levels![0]).toBe(2) // "abc"
    expect(levels![4]).toBe(2) // "xyz"
    // R stays at 1
    expect(levels![2]).toBe(1) // "א"
  })
})

// --- Arabic numeral handling (AN type) ---

describe('computeSegmentLevels — Arabic numerals', () => {
  test('Arabic-Indic digits get bidi levels', () => {
    // Arabic-Indic digits ١٢٣ are AN type in arabicTypes
    const text = 'العدد ١٢٣'
    const segStarts = [0, 5, 6]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // AN on odd level → I2: L/AN/EN → level++, so 2
    expect(levels![1]).toBeGreaterThanOrEqual(1)
  })
})

// --- Segment levels map correctly ---

describe('computeSegmentLevels — segment mapping', () => {
  test('returns correct number of levels for segments', () => {
    const text = 'Hello שלום world'
    const segStarts = [0, 5, 6, 10, 11]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels!.length).toBe(5)
  })

  test('single segment covering whole string', () => {
    const text = 'שלום'
    const segStarts = [0]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels!.length).toBe(1)
    expect(levels![0]).toBe(1)
  })

  test('returns Int8Array', () => {
    const text = 'Hello שלום'
    const segStarts = [0, 5, 6]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).toBeInstanceOf(Int8Array)
  })
})

// --- Edge cases ---

describe('computeSegmentLevels — edge cases', () => {
  test('single character Hebrew', () => {
    const text = 'א'
    const segStarts = [0]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels!.length).toBe(1)
    expect(levels![0]).toBe(1)
  })

  test('single character Latin — returns null', () => {
    const text = 'A'
    const segStarts = [0]
    expect(computeSegmentLevels(text, segStarts)).toBe(null)
  })

  test('spaces between RTL words', () => {
    const text = 'שלום עולם טוב'
    const segStarts = [0, 4, 5, 9, 10]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels!.length).toBe(5)
    // All segments in RTL paragraph
    expect(levels![0]).toBe(1) // "שלום"
    expect(levels![2]).toBe(1) // "עולם"
    expect(levels![4]).toBe(1) // "טוב"
  })

  test('numbers in mixed context', () => {
    // European numbers (EN type) in RTL paragraph
    const text = 'Price 42 שקל'
    const segStarts = [0, 5, 6, 8, 9]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // "Price" is L on odd level → 2
    expect(levels![0]).toBe(2)
    // "שקל" is R → stays at 1
    expect(levels![4]).toBe(1)
  })

  test('punctuation between RTL text', () => {
    // ON type punctuation should resolve based on surrounding context
    const text = 'שלום, עולם'
    const segStarts = [0, 4, 5, 6]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels!.length).toBe(4)
  })

  test('long RTL text with embedded LTR', () => {
    // Mostly RTL → startLevel = 1
    const text = 'הנה כמה מילים בעברית עם English ובחזרה לעברית שוב'
    const segStarts = [0, 4, 5, 9, 10, 15, 16, 22, 23, 25, 26, 33, 34, 41, 42, 48, 49]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels!.length).toBe(segStarts.length)
  })
})

// --- NSM (Non-spacing mark) handling ---

describe('computeSegmentLevels — NSM marks', () => {
  test('Arabic text with diacritics', () => {
    // Arabic diacritics (0x064B-0x065F) are NSM in arabicTypes
    const text = 'كَتَبَ'
    const segStarts = [0]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels![0]).toBe(1)
  })
})

// --- W-rule effects ---

describe('computeSegmentLevels — W rules', () => {
  test('W1: NSM inherits preceding type', () => {
    // NSM after R should become R
    // Using Hebrew char followed by combining mark
    const text = 'אְב' // Hebrew with sheva mark
    const segStarts = [0]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels![0]).toBe(1)
  })

  test('W3: AL becomes R', () => {
    // After W3, AL characters should behave like R
    const text = 'عربي'
    const segStarts = [0]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    expect(levels![0]).toBe(1) // AL→R, R on odd level stays 1
  })
})

// --- Snapshot tests for regression detection ---

describe('computeSegmentLevels — regression snapshots', () => {
  test('snapshot: Hello שלום world', () => {
    const text = 'Hello שלום world'
    const segStarts = [0, 5, 6, 10, 11]
    const levels = computeSegmentLevels(text, segStarts)
    expect(Array.from(levels!)).toEqual([2, 1, 1, 1, 2])
  })

  test('snapshot: pure Hebrew', () => {
    const text = 'שלום עולם'
    const segStarts = [0, 4, 5]
    const levels = computeSegmentLevels(text, segStarts)
    expect(Array.from(levels!)).toEqual([1, 1, 1])
  })

  test('snapshot: Arabic sentence', () => {
    const text = 'مرحبا بالعالم'
    const segStarts = [0, 5, 6]
    const levels = computeSegmentLevels(text, segStarts)
    expect(Array.from(levels!)).toEqual([1, 1, 1])
  })

  test('snapshot: mixed with numbers', () => {
    const text = 'Item 42 של מחיר'
    const segStarts = [0, 4, 5, 7, 8, 10, 11]
    const levels = computeSegmentLevels(text, segStarts)
    expect(levels).not.toBe(null)
    // Capture actual levels for regression
    const arr = Array.from(levels!)
    expect(arr.length).toBe(7)
    // L segments get 2, R segments get 1
    expect(arr[0]).toBe(2) // "Item"
    expect(arr[4]).toBe(1) // "של"
    expect(arr[6]).toBe(1) // "מחיר"
  })
})
