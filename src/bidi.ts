// Simplified bidi metadata helper for the rich prepareWithSegments() path,
// forked from pdf.js via Sebastian's text-layout. It classifies characters
// into bidi types, computes embedding levels, and maps them onto prepared
// segments for custom rendering. The line-breaking engine does not consume
// these levels.

// Numeric bidi type constants — avoids string comparisons in hot loops
const L   = 0
const R   = 1
const AL  = 2
const AN  = 3
const EN  = 4
const ES  = 5
const ET  = 6
const CS  = 7
const ON  = 8
const BN  = 9
const B   = 10
const S   = 11
const WS  = 12
const NSM = 13

const baseTypes = new Uint8Array([
  BN,BN,BN,BN,BN,BN,BN,BN,BN,S,B,S,WS,
  B,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,
  BN,BN,B,B,B,S,WS,ON,ON,ET,ET,ET,ON,
  ON,ON,ON,ON,ON,CS,ON,CS,ON,EN,EN,EN,
  EN,EN,EN,EN,EN,EN,EN,ON,ON,ON,ON,ON,
  ON,ON,L,L,L,L,L,L,L,L,L,L,L,L,L,
  L,L,L,L,L,L,L,L,L,L,L,L,L,ON,ON,
  ON,ON,ON,ON,L,L,L,L,L,L,L,L,L,L,
  L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,
  L,ON,ON,ON,ON,BN,BN,BN,BN,BN,BN,B,BN,
  BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,
  BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,BN,
  BN,CS,ON,ET,ET,ET,ET,ON,ON,ON,ON,L,ON,
  ON,ON,ON,ON,ET,ET,EN,EN,ON,L,ON,ON,ON,
  EN,L,ON,ON,ON,ON,ON,L,L,L,L,L,L,L,
  L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,
  L,ON,L,L,L,L,L,L,L,L,L,L,L,L,L,
  L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,
  L,L,L,ON,L,L,L,L,L,L,L,L
])

const arabicTypes = new Uint8Array([
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  CS,AL,ON,ON,NSM,NSM,NSM,NSM,NSM,NSM,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,NSM,NSM,NSM,NSM,NSM,NSM,NSM,
  NSM,NSM,NSM,NSM,NSM,NSM,NSM,AL,AL,AL,AL,
  AL,AL,AL,AN,AN,AN,AN,AN,AN,AN,AN,AN,
  AN,ET,AN,AN,AL,AL,AL,NSM,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,NSM,NSM,NSM,NSM,NSM,NSM,NSM,NSM,NSM,NSM,
  NSM,NSM,NSM,NSM,NSM,NSM,NSM,NSM,NSM,ON,NSM,
  NSM,NSM,NSM,AL,AL,AL,AL,AL,AL,AL,AL,AL,
  AL,AL,AL,AL,AL,AL,AL,AL,AL
])

// Module-level slot for passing startLevel from computeBidiTypes to
// computeSegmentLevels without allocating a wrapper object. Safe because
// the two functions are always called in immediate sequence, single-threaded.
let _startLevel = 0

function computeBidiTypes(str: string): Uint8Array | null {
  const len = str.length
  if (len === 0) return null

  // Fast pre-scan: check if any bidi characters exist before allocating.
  // Most text is LTR-only, so this avoids a Uint8Array allocation in the
  // common case. Only chars >= 0x0590 can be R/AL/AN.
  let hasBidi = false
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) >= 0x0590) {
      hasBidi = true
      break
    }
  }

  if (!hasBidi) return null

  // Full classification pass (only reached when bidi chars are present)
  const types = new Uint8Array(len)
  let numBidi = 0
  let hasWeak = false    // EN/ET/ES/CS exist → W4-W7 needed
  let hasALorNSM = false // AL or NSM exist → W1+W2+W3 needed
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i)
    let t: number
    if (c <= 0x00ff) {
      t = baseTypes[c]!
      // Weak types only come from the base table; check inside this branch
      if (!hasWeak && (t === EN || t === ET || t === ES || t === CS)) hasWeak = true
    }
    else if (0x0590 <= c && c <= 0x05f4) t = R
    else if (0x0600 <= c && c <= 0x06ff) {
      t = arabicTypes[c & 0xff]!
      hasALorNSM = true  // Arabic block always has AL or NSM
    }
    else if (0x0700 <= c && c <= 0x08AC) {
      t = AL
      hasALorNSM = true
    }
    else t = L
    if (t === R || t === AL || t === AN) numBidi++
    types[i] = t
  }

  if (numBidi === 0) return null

  _startLevel = (len / numBidi) < 0.3 ? 0 : 1

  const e = (_startLevel & 1) ? R : L
  const sor = e

  // W1 + W2 + W3: resolve NSM, convert EN after AL, and AL→R.
  // Skip entirely for pure Hebrew (no AL, no NSM, no weak types).
  if (hasALorNSM || hasWeak) {
    let w1Last = sor
    let w2Last = sor
    for (let i = 0; i < len; i++) {
      let t = types[i]!
      if (t === NSM) {
        t = w1Last
        types[i] = t
      }
      w1Last = t
      if (t === EN) {
        if (w2Last === AL) {
          types[i] = AN
        }
      } else if (t === R || t === L || t === AL) {
        if (t === AL) {
          types[i] = R
        }
        w2Last = t
      }
    }
  }

  // W4-W7: weak type resolution. Skip when no EN/ET/ES/CS exist.
  if (hasWeak) {
    // W4-W5: ES between EN→EN, CS between EN/AN matching
    for (let i = 1; i < len - 1; i++) {
      if (types[i] === ES && types[i - 1] === EN && types[i + 1] === EN) {
        types[i] = EN
      }
      if (
        types[i] === CS &&
        (types[i - 1] === EN || types[i - 1] === AN) &&
        types[i + 1] === types[i - 1]
      ) {
        types[i] = types[i - 1]!
      }
    }

    // W5: ET adjacent to EN → EN
    for (let i = 0; i < len; i++) {
      if (types[i] !== EN) continue
      let j
      for (j = i - 1; j >= 0 && types[j] === ET; j--) types[j] = EN
      for (j = i + 1; j < len && types[j] === ET; j++) types[j] = EN
    }

    // W6 + W7 merged: neutralize weak types and resolve EN after L
    let w7Last = sor  // W7: tracks previous strong type (R/L only)
    for (let i = 0; i < len; i++) {
      let t = types[i]!
      // W6: remaining weak types → ON
      if (t === WS || t === ES || t === ET || t === CS) {
        types[i] = ON
      } else if (t === EN) {
        // W7: EN after L → L
        types[i] = w7Last === L ? L : EN
      } else if (t === R || t === L) {
        w7Last = t
      }
    }
  } else {
    // No weak types, but WS still needs to become ON for N1 to resolve it.
    for (let i = 0; i < len; i++) {
      if (types[i] === WS) types[i] = ON
    }
  }

  // N1: resolve neutral (ON) runs based on surrounding strong types
  for (let i = 0; i < len; i++) {
    if (types[i] !== ON) continue
    let end = i + 1
    while (end < len && types[end] === ON) end++
    const before = i > 0 ? types[i - 1]! : sor
    const after = end < len ? types[end]! : sor
    const bDir = before !== L ? R : L
    const aDir = after !== L ? R : L
    // N1: if directions agree, use that direction; N2: otherwise use embedding
    const resolved = bDir === aDir ? bDir : e
    for (let j = i; j < end; j++) types[j] = resolved
    i = end - 1
  }

  return types
}

export function computeSegmentLevels(normalized: string, segStarts: number[]): Int8Array | null {
  const resolvedTypes = computeBidiTypes(normalized)
  if (resolvedTypes === null) return null

  // Compute I1-I2 levels only for segment-start positions, avoiding a
  // full-length Int8Array allocation + loop over every character.
  // _startLevel was set by computeBidiTypes() just above.
  const segLevels = new Int8Array(segStarts.length)
  if (_startLevel === 0) {
    // Even startLevel: R→1, AN/EN→2, L→0 (default from zero-init)
    for (let i = 0; i < segStarts.length; i++) {
      const t = resolvedTypes[segStarts[i]!]!
      if (t === R) segLevels[i] = 1
      else if (t === AN || t === EN) segLevels[i] = 2
    }
  } else {
    // Odd startLevel (1): L/AN/EN→2, R→1
    for (let i = 0; i < segStarts.length; i++) {
      const t = resolvedTypes[segStarts[i]!]!
      if (t === L || t === AN || t === EN) segLevels[i] = 2
      else segLevels[i] = 1
    }
  }
  return segLevels
}
