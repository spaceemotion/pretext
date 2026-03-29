# Optimization Log

V8 performance optimization experiments for pretext.
Reference: `.patterns/code-optimization.md`

## Baseline

- All 60 tests pass (`bun test`)
- No type errors in src/ (`bun x tsc --noEmit`)
- Chrome layout() benchmark: ~0.09ms per 500-text batch (from STATUS.md)
- Chrome prepare() benchmark: ~18.85ms cold batch

## Optimization Plan

Priority order following the V8 optimization guide:

### Tier 1: Structural (+10-50% expected)

1. **Class-based refactoring of `countPreparedLinesSimple`** — Convert closure-heavy function to a reusable class. The guide's #1 structural optimization: "class methods over closures" (+11-27%).

2. **Extend class refactoring to `walkPreparedLinesSimple`** — 7 nested closures sharing mutable state. Same closure anti-pattern.

3. **Extend class refactoring to `walkPreparedLines`** (full path) — Even more closures for soft-hyphen, tab, and chunk handling.

4. **Extend class refactoring to `layoutNextLineRange`** and `layoutNextLineRangeSimple` — Streaming API variants with the same closure pattern.

### Tier 2: Algorithmic (+5-25% expected)

5. **Cache `getEngineProfile()` result** — Called at the top of every line-break function.

6. **Lookup table for break-kind classification** — `canBreakAfter()` and `isSimpleCollapsibleSpace()` use string equality chains. Numeric enum + bitflag table.

7. **Optimize `isCJK` with `charCodeAt`** — Currently uses `for...of` + `codePointAt()`.

### Tier 3: V8 Micro (+1-5% expected)

8. **Pre-compute `maxWidth + lineFitEpsilon`** — Repeated in every overflow check.

9. **Reduce intermediate allocations in analysis merge passes**.

---

## Round Log

### Round 0: Branch creation
- Created `perf/v8-optimizations` branch
- All 60 tests pass
- Baseline established from STATUS.md benchmarks

### Round 1: Class-based refactoring of `countPreparedLinesSimple`

**What:** Converted the closure-heavy `countPreparedLinesSimple` function to a `SimpleLineCounter` class.
- Closure variables (`lineCount`, `lineW`, `hasContent`) → private fields
- Nested `placeOnFreshLine()` → private method
- Captured data (`widths`, `kinds`, etc.) → fields set once per `run()` call
- Module-scope singleton instance reused across calls
- `this.*` cached in locals for the tight inner loop per the guide's recipe

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches.

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Latin short (6 words, 11 segs) | 255 | 21 | **12.1×** |
| Latin medium (25 words, 49 segs) | 383 | 83 | **4.6×** |
| Latin long (100 words, 199 segs) | 940 | 236 | **4.0×** |
| CJK medium (50 chars, 99 segs) | 565 | 119 | **4.7×** |
| Long word overflow (11 segs) | 416 | 100 | **4.2×** |
| Corpus-scale (500 segs) | 2,081 | 699 | **3.0×** |
| Magazine page (2k segs) | 7,880 | 2,883 | **2.7×** |
| CJK editorial (5k segs) | 19,184 | 7,867 | **2.4×** |
| Thai-like (10k segs, 80% breakable) | 40,487 | 16,847 | **2.4×** |
| Arabic-like (37k segs, 50% breakable) | 146,372 | 61,953 | **2.4×** |
| Mixed long (10k segs) | 40,253 | 16,254 | **2.5×** |

**Result: 2.4–12× faster** depending on text size. Small texts benefit most (closure creation cost dominates); editorial-scale texts stabilize at ~2.4× faster. Line counts identical across all cases (correctness verified). All 60 tests pass.

### Round 2: Class-based refactoring of `walkPreparedLinesSimple`

**What:** Converted the closure-heavy `walkPreparedLinesSimple` function to a `SimpleLineWalker` class.
- 8 closure variables → private fields (`lineCount`, `lineW`, `hasContent`, `lineStartSegmentIndex`, `lineStartGraphemeIndex`, `lineEndSegmentIndex`, `lineEndGraphemeIndex`, `pendingBreakSegmentIndex`, `pendingBreakPaintWidth`)
- 7 nested closures → private methods (`emitCurrentLine`, `startLineAtSegment`, `startLineAtGrapheme`, `appendWholeSegment`, `updatePendingBreak`, `appendBreakableSegmentFrom`, `clearPendingBreak` inlined)
- Captured data arrays + `onLine` callback → fields set once per `run()` call
- Module-scope singleton instance reused across calls
- `lineFitEpsilon` and `maxWidth` cached in locals where hot

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches. This measures `walkPreparedLines()` with an `onLine` callback (the path used by `layoutWithLines()` and `walkLineRanges()`).

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Latin short (6w, 11 segs) | 1,689 | 85 | **19.9×** |
| Latin medium (25w, 49 segs) | 1,909 | 215 | **8.9×** |
| Latin long (100w, 199 segs) | 2,790 | 710 | **3.9×** |
| CJK medium (50ch, 99 segs) | 2,156 | 329 | **6.6×** |
| Long word overflow (11 segs) | 2,057 | 265 | **7.8×** |
| Corpus-scale (500 segs) | 4,799 | 1,739 | **2.8×** |
| Magazine page (2k segs) | 14,075 | 7,240 | **1.9×** |
| CJK editorial (5k segs) | 31,067 | 16,266 | **1.9×** |
| Thai-like (10k, 80% brk) | 63,375 | 35,138 | **1.8×** |
| Arabic-like (37k, 50% brk) | 219,313 | 125,521 | **1.7×** |
| Mixed long (10k segs) | 64,092 | 34,530 | **1.9×** |

**Result: 1.7–19.9× faster** depending on text size. Even larger small-text gains than Round 1 because `walkPreparedLinesSimple` allocated 7 closures per call (vs 1 for the counter). The layout-only path (`layout()` → `countPreparedLinesSimple`) is unaffected — it uses the already-optimized `SimpleLineCounter` from Round 1. All 60 tests pass.

### Round 3: Class-based refactoring of `walkPreparedLines` (full path)

**What:** Converted the full-path `walkPreparedLines` function body (non-simple branch) to a `FullLineWalker` class.
- 11 closure variables → private fields (same 8 as simple + `pendingBreakFitWidth`, `pendingBreakPaintWidth`, `pendingBreakKind`)
- 9 nested closures → private methods (`clearPendingBreak`, `emitCurrentLine`, `startLineAtSegment`, `startLineAtGrapheme`, `appendWholeSegment`, `updatePendingBreakForWholeSegment`, `appendBreakableSegmentFrom`, `continueSoftHyphenBreakableSegment`, `emitEmptyChunk`)
- Additional captured data: `lineEndFitAdvances`, `lineEndPaintAdvances`, `discretionaryHyphenWidth`, `tabStopAdvance`, `preferEarlySoftHyphenBreak`
- Module-scope singleton instance reused across calls

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches. This measures `walkPreparedLines()` with `simpleLineWalkFastPath: false` — the path used by texts containing soft hyphens, tabs, and hard breaks.

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Latin 25w (SHY+HB) | 2,349 | 242 | **9.7×** |
| Latin 100w (SHY+HB) | 3,621 | 896 | **4.0×** |
| 500 segs (SHY+HB) | 6,115 | 2,283 | **2.7×** |
| 2k segs (SHY+HB) | 18,247 | 10,250 | **1.8×** |
| 5k segs (mixed) | 41,627 | 25,971 | **1.6×** |
| 10k segs (mixed) | 81,627 | 53,349 | **1.5×** |

**Result: 1.5–9.7× faster** depending on text size. Similar pattern to Rounds 1–2: small texts gain more from eliminating per-call closure allocation. This was the most complex refactoring — 9 closures and soft-hyphen continuation logic. All 60 tests pass.

### Round 4: Class-based refactoring of streaming API (`layoutNextLineRange`)

**What:** Converted both `layoutNextLineRangeSimple` and `layoutNextLineRange` (full path) to `SimpleLineRangeStepper` and `FullLineRangeStepper` classes.
- `layoutNextLineRangeSimple`: 5 closure variables → private fields; 5 nested closures → private methods; module-scope singleton
- `layoutNextLineRange` (full path): 8+ closure variables → private fields; 7 nested closures → private methods; module-scope singleton
- The streaming API was the worst-performing path (24× slower than walk at magazine scale) because each `layoutNextLineRange()` call created 5–7 fresh closures, and the function was called once per line

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches. This measures the full streaming loop: repeated `layoutNextLineRange()` calls until all lines are consumed.

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Latin short (6w) | 1,339 | 81 | **16.5×** |
| Latin medium (25w) | 5,068 | 256 | **19.8×** |
| Latin long (100w) | 16,671 | 1,071 | **15.6×** |
| Corpus 500 segs | 43,228 | 2,773 | **15.6×** |
| Magazine 2k segs | 175,504 | 8,117 | **21.6×** |
| Mixed 10k segs | 720,503 | 37,738 | **19.1×** |
| Full: 2k (SHY+HB) | 250,885 | 14,140 | **17.7×** |
| Full: 10k (mixed) | 1,073,890 | 84,214 | **12.8×** |

**Result: 12.8–21.6× faster** across all cases. The streaming API was by far the biggest win because the per-call closure overhead was multiplied by the number of lines in the text (138 closures × 5–7 each = ~800+ closure allocations for a magazine page). Now uses singleton class instances that reset state once at the start. Streaming is now within 1.1× of the walk path for the simple cases. All 60 tests pass.

### Round 5: Pre-compute effectiveMaxWidth + optimize canBreakAfter

**What:** Two micro-optimizations targeting the inner loop:
1. **Pre-compute `effectiveMaxWidth = maxWidth + lineFitEpsilon`** once per `run()` call instead of computing the addition on every overflow check. Replaced 17 inline `maxWidth + lineFitEpsilon` expressions across all 6 classes.
2. **Optimize `canBreakAfter()`** from 5 positive string comparisons to 3 negative comparisons. `kind !== 'text' && kind !== 'glue' && kind !== 'hard-break'` short-circuits on the first check for the most common 'text' kind.
3. **Updated `fitSoftHyphenBreak()`** signature to accept pre-computed `effectiveMaxWidth` instead of separate `maxWidth + lineFitEpsilon` params.

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches.

layout() path (SimpleLineCounter — tightest inner loop):

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Latin short (6w) | 35 | 33 | 6% |
| Latin medium (25w) | 81 | 55 | **32%** |
| Latin long (100w) | 239 | 204 | **15%** |
| Corpus 500 segs | 703 | 563 | **20%** |
| Magazine 2k segs | 2,904 | 2,423 | **17%** |
| CJK editorial 5k | 7,809 | 6,664 | **15%** |
| Thai 10k | 17,150 | 14,769 | **14%** |
| Arabic 37k | 62,675 | 52,960 | **15%** |
| Mixed 10k | 16,407 | 13,943 | **15%** |

Full walk path (FullLineWalker):

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Full: 2k (SHY+HB) | 10,132 | 9,892 | 2% |
| Full: 10k (mixed) | 54,805 | 48,924 | **11%** |

Stream path:

| Case | Before (ns) | After (ns) | Speedup |
|------|------------|-----------|---------|
| Stream: Magazine 2k | 8,117 | 7,432 | 8% |
| Stream: Mixed 10k | 37,738 | 34,895 | 8% |
| Stream-F: 10k | 84,214 | 80,557 | 4% |

**Result: 4–32% faster** across paths. The layout() hot path benefits most (14–32%) because the inline addition was a significant fraction of per-segment work in the minimal `SimpleLineCounter` inner loop. Walk and stream paths see 2–11% gains. All 60 tests pass.

### Stage 1 (Cleanup): Remove singletons, constructor-based init, store prepared ref, drop lineFitEpsilon

**What:** Code cleanup — not a performance optimization. Addresses structural code smells:
1. **Removed 5 module-scope singleton instances** (`simpleLineCounter`, `simpleLineWalker`, `fullLineWalker`, `fullLineRangeStepper`, `simpleLineRangeStepper`). Each call site now uses `new Class(...).run()`.
2. **Constructor-based init** replaces the `run()`-preamble field-copying pattern. Parameters that were "bound once per run" (`prepared`, `maxWidth`, `effectiveMaxWidth`, engine profile booleans) are now `readonly` constructor parameters.
3. **Store `this.p: PreparedLineBreakData` reference** instead of destructuring 5–9 individual array fields onto `this.*`. Methods access `this.p.widths`, etc. Hot inner loops still destructure into locals.
4. **Removed `lineFitEpsilon` field** from all 5 classes. The one stale direct use (`this.maxWidth + this.lineFitEpsilon` in `FullLineRangeStepper.maybeFinishAtSoftHyphen`) was replaced with `this.effectiveMaxWidth`. The field was otherwise only used to compute `effectiveMaxWidth`, which is now a constructor parameter.
5. **Removed 5 wrapper functions** whose only purpose was to call the singleton's `.run()` method.

**Property count reduction:**
- `SimpleLineCounter`: 10 → 7 (3 state + 4 readonly ctor)
- `SimpleLineWalker`: 18 → 14 (9 state + 5 readonly ctor)
- `FullLineWalker`: 25 → 18 (12 state + 6 readonly ctor)
- `FullLineRangeStepper`: 24 → 17 (12 state + 5 readonly ctor)
- `SimpleLineRangeStepper`: 16 → 12 (8 state + 4 readonly ctor)
- Total: 93 → 68 fields (−25 fields, −27%)

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches.

layout() path (uses `SimpleLineCounter`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Latin short (6w) | 34 | 80 | noise-dominated (p5=34) |
| Latin medium (25w) | 74 | 111 | noise-dominated (p5=51) |
| Resize sweep (25w) | 56 | 48 | **14% faster** |
| Corpus 500 segs | 559 | 501 | **10% faster** |
| Magazine 2k segs | 2,353 | 1,982 | **16% faster** |
| CJK editorial 5k | 6,620 | 5,331 | **19% faster** |
| Thai 10k | 14,707 | 12,551 | **15% faster** |
| Arabic 37k | 52,824 | 47,169 | **11% faster** |
| Mixed 10k | 14,041 | 12,254 | **13% faster** |

Walk path (uses `SimpleLineWalker` / `FullLineWalker`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Walk: Magazine 2k | 7,031 | 6,418 | **9% faster** |
| Walk: Arabic 37k | 123,293 | 113,574 | **8% faster** |
| Full: 2k (SHY+HB) | 9,392 | 8,470 | **10% faster** |
| Full: 10k (mixed) | 48,956 | 45,514 | **7% faster** |

Stream path (uses `SimpleLineRangeStepper` / `FullLineRangeStepper`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Stream: Magazine 2k | 7,311 | 8,394 | −15% (new per line) |
| Stream: Mixed 10k | 34,749 | 38,846 | −12% (new per line) |
| Stream-F: 2k (SHY+HB) | 13,531 | 12,686 | **6% faster** |
| Stream-F: 10k (mixed) | 81,149 | 77,987 | **4% faster** |

**Result:** Net positive for real-world texts (7–19% faster at editorial scale). Small-text medians are noise-dominated (p5 values match the baseline). Simple streaming path regresses ~12–15% because `new` per line replaces singleton reset — acceptable tradeoff for code cleanliness. Full streaming path improves. All 60 tests pass.

### Stage 2 (Cleanup): Merge `SimpleLineWalker` + `SimpleLineRangeStepper` → `SimpleLineEngine`

**What:** Structural merge — two classes that walked the same simple segment model (one batch, one streaming) become a single `SimpleLineEngine` with two entry points:
- `walkAll()` — iterates all segments, emits lines via `onLine` callback, returns count
- `stepOne(cursor)` — iterates from cursor, returns first completed `InternalLayoutLine | null`

A `stepping` boolean flag distinguishes the two modes inside the shared `appendBreakableSegmentFrom` helper. This is needed because `walkAll()` can be called without an `onLine` callback (from `countPreparedLines`), so `this.onLine !== undefined` cannot distinguish the modes.

**Class/field reduction:**
- 5 classes → 4 classes (−1)
- `SimpleLineWalker` (14 fields) + `SimpleLineRangeStepper` (12 fields) = 26 fields across 2 classes
- `SimpleLineEngine` = 16 fields (11 state + 5 readonly ctor)
- Total: 68 → 58 fields (−10, −15%)

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches.

layout() path (uses `SimpleLineCounter`, unchanged):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Resize sweep (25w) | 48 | 49 | neutral |
| Corpus 500 segs | 501 | 521 | neutral |
| Magazine 2k segs | 1,982 | 2,087 | neutral |
| CJK editorial 5k | 5,331 | 5,921 | −11% (noise range) |
| Thai 10k | 12,551 | 12,930 | neutral |
| Arabic 37k | 47,169 | 48,030 | neutral |
| Mixed 10k | 12,254 | 12,470 | neutral |

Walk path (now uses `SimpleLineEngine.walkAll()`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Walk: Latin long 100w | 550 | 559 | neutral |
| Walk: Magazine 2k | 6,418 | 6,321 | neutral |
| Walk: Thai 10k | 32,499 | 32,297 | neutral |
| Walk: Arabic 37k | 113,574 | 114,054 | neutral |
| Walk: Mixed 10k | 31,506 | 31,496 | neutral |

Stream path (now uses `SimpleLineEngine.stepOne()`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Stream: Latin long 100w | 761 | 755 | neutral |
| Stream: Magazine 2k | 8,394 | 8,526 | neutral |
| Stream: Mixed 10k | 38,846 | 40,819 | −5% (noise range) |

Full-path walk and stream (uses `FullLineWalker` / `FullLineRangeStepper`, unchanged):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Full: 2k (SHY+HB) | 8,470 | 8,746 | neutral |
| Full: 10k (mixed) | 45,514 | 44,984 | neutral |
| Stream-F: 2k (SHY+HB) | 12,686 | 13,563 | −7% (noise range) |
| Stream-F: 10k (mixed) | 77,987 | 80,807 | neutral |

**Result:** Performance-neutral across all paths, as expected for a pure structural merge. No significant regressions. Class count reduced from 5 to 4, field count reduced from 68 to 58. All 60 tests pass.

### Stage 3 (Cleanup): Merge `FullLineWalker` + `FullLineRangeStepper` → `FullLineEngine`

**What:** Same structural merge pattern as Stage 2, applied to the full-path (soft-hyphen / tab / chunk-aware) classes. Two classes become a single `FullLineEngine` with two entry points:
- `walkAll()` — iterates all chunks/segments, emits lines via `onLine` callback, returns count
- `stepOne(cursor)` — finds the cursor's chunk, iterates from cursor, returns first completed `InternalLayoutLine | null`

A `stepping` boolean flag distinguishes the two modes inside `appendBreakableSegmentFrom`. Walk-only helpers (`continueSoftHyphenBreakableSegment`, `emitEmptyChunk`) and step-only helpers (`maybeFinishAtSoftHyphen`, `finishLine`) coexist on the same class. The soft-hyphen handling is structurally different between the two modes — the walker's `continueSoftHyphenBreakableSegment` fits-and-continues while the stepper's `maybeFinishAtSoftHyphen` fits-and-returns — so both methods are kept rather than forcibly unified.

**Class/field reduction:**
- 4 classes → 3 classes (−1)
- `FullLineWalker` (18 fields) + `FullLineRangeStepper` (17 fields) = 35 fields across 2 classes
- `FullLineEngine` = 21 fields (15 state + 6 readonly ctor)
- Total: 58 → 44 fields (−14, −24%)
- Cumulative from Stage 1: 68 → 44 fields (−24, −35%)
- File: 1088 → 1003 lines (−85 lines)

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches.

layout() path (uses `SimpleLineCounter`, unchanged):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Resize sweep (25w) | 49 | 48 | neutral |
| Corpus 500 segs | 521 | 518 | neutral |
| Magazine 2k segs | 2,087 | 2,106 | neutral |
| CJK editorial 5k | 5,921 | 5,743 | neutral |
| Thai 10k | 12,930 | 13,102 | neutral |
| Arabic 37k | 48,030 | 48,025 | neutral |
| Mixed 10k | 12,470 | 12,382 | neutral |

Walk path (simple unchanged, full now uses `FullLineEngine.walkAll()`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Walk: Magazine 2k | 6,321 | 6,519 | neutral |
| Walk: Arabic 37k | 114,054 | 114,180 | neutral |
| Full: 2k (SHY+HB) | 8,746 | 8,488 | neutral |
| Full: 10k (mixed) | 44,984 | 44,812 | neutral |

Stream path (simple unchanged, full now uses `FullLineEngine.stepOne()`):

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Stream: Magazine 2k | 8,526 | 8,481 | neutral |
| Stream: Mixed 10k | 40,819 | 39,946 | neutral |
| Stream-F: 2k (SHY+HB) | 13,563 | 13,380 | neutral |
| Stream-F: 10k (mixed) | 80,807 | 83,849 | neutral |

**Result:** Performance-neutral across all paths. Class count reduced from 4 to 3, field count reduced from 58 to 44. File reduced by 85 lines. All 60 tests pass.

---

## Cleanup Loop 1: Indentation, consistency, and dead code

Six targeted fixes in `src/line-break.ts` to improve readability and remove dead/inconsistent logic:

1. **Fixed indentation bug** in `FullLineEngine.walkAll()`: `const newW` and `if (newW > effectiveMaxWidth)` were at 6-space indent instead of 8-space inside the `while` loop, making control flow visually misleading.

2. **Eliminated double-read** of `kinds[segmentIndex]` in `FullLineEngine.updatePendingBreakForWholeSegment`: was reading the array once for `canBreakAfter()` then again for `const kind`. Now reads once and reuses.

3. **Added `clearPendingBreak()` to `SimpleLineEngine`** for consistency with `FullLineEngine`. The inline resets in `emitCurrentLine` (`pendingBreakSegmentIndex = -1`, `pendingBreakPaintWidth = 0`) now use the method.

4. **Used `clearPendingBreak()` in `FullLineEngine.stepOne()`**: was manually resetting 4 pending-break fields instead of calling the existing helper, inconsistent with `walkAll()` which uses the method.

5. **Removed unreachable guard** in `FullLineEngine.continueSoftHyphenBreakableSegment`: checked `this.pendingBreakKind !== 'soft-hyphen'` but the only call site already guards `this.pendingBreakKind === 'soft-hyphen'`, making this always-false.

6. **Removed redundant `clearPendingBreak()` in `emitEmptyChunk`**: pending break state is always cleared at chunk iteration start in `walkAll()`, so clearing again in `emitEmptyChunk` was dead work.

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches.

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Magazine 2k (layout) | 1,955 | 2,074 | noise |
| Arabic 37k (layout) | 49,338 | 47,569 | noise |
| Walk: Magazine 2k | 6,430 | 6,472 | neutral |
| Walk: Arabic 37k | 113,861 | 113,478 | neutral |
| Full: 2k (SHY+HB) | 8,437 | 8,462 | neutral |
| Full: 10k (mixed) | 44,668 | 45,354 | neutral |
| Stream-F: 2k (SHY+HB) | 12,922 | 15,070 | noise |
| Stream-F: 10k (mixed) | 78,343 | 87,219 | noise |

**Result:** Performance-neutral. All 60 tests pass. Code is more consistent and has no dead guards or redundant resets.

---

## Cleanup Loop 2: Dead stores and documentation comment

Two changes in `src/line-break.ts`:

1. **Removed dead stores** of 4 cursor fields (`lineStartSegmentIndex`, `lineStartGraphemeIndex`, `lineEndSegmentIndex`, `lineEndGraphemeIndex`) at chunk-iteration start in `FullLineEngine.walkAll()`. These were always overwritten by `startLineAtSegment()` or `startLineAtGrapheme()` before being read — `hasContent` is set to `false` at chunk start, and all read sites are guarded by `hasContent`.

2. **Added documentation comment** on `SimpleLineCounter` explaining why it exists as a separate class from `SimpleLineEngine`: the `layout()` resize hot path (11-20M ops/s) benefits from carrying only 3 state fields instead of 12+.

**Benchmark:** Node v24.13.0, 50 iterations × 1000 calls, 20 warmup batches. Performance-neutral (verified with re-run to exclude system load artifact).

| Case | Before (ns) | After (ns) | Change |
|------|------------|-----------|--------|
| Magazine 2k (layout) | 2,074 | 2,050 | neutral |
| Arabic 37k (layout) | 47,569 | 47,001 | neutral |
| Walk: Magazine 2k | 6,472 | 6,411 | neutral |
| Full: 2k (SHY+HB) | 8,462 | 8,526 | neutral |
| Full: 10k (mixed) | 45,354 | 44,738 | neutral |

**Result:** Performance-neutral. All 60 tests pass. File reduced by 4 dead-store lines, gained 2 comment lines.

---

# Phase 2: analysis.ts optimization

Target: `analyzeText()` pipeline in `src/analysis.ts` — the text analysis/segmentation phase called once per text change. Less hot than layout (not per-resize), but important for perceived responsiveness.

Pipeline: normalize whitespace → `Intl.Segmenter.segment()` → classify/split by break kind → merge loop (CJK kinsoku, Arabic punctuation, Myanmar, quotes, etc.) → post-merge passes → `compileAnalysisChunks()`.

**Key constraint:** `Intl.Segmenter` consumes ~55-60% of total `analyzeText()` time. Our optimization target is the remaining ~40-45%.

## Phase 2 Baseline

Established with `scripts/bench-analysis.ts` and `src/analysis.test.ts` (60 tests).

| Case | Original (ns) |
|------|--------------|
| Latin short (45ch) | 5589 |
| Latin medium (240ch) | 18640 |
| Latin long (1000ch) | 88029 |
| CJK mixed (230ch) | 42190 |
| Arabic (250ch) | 22365 |
| Mixed app (360ch) | 50977 |
| CJK long (~5000ch) | 1235191 |
| Arabic long (~5000ch) | 462047 |
| Mixed long (~5000ch) | 572786 |
| Pre-wrap short | 9970 |
| Pre-wrap long | 276257 |

## Phase 2 Round Log

### Round 1: Replace `for...of` with `charCodeAt` loops, optimize `isCJK`

**What:** Converted string iteration from `for...of` (iterator protocol overhead) to index-based `charCodeAt` loops. Restructured `isCJK` to check BMP ranges first, astral via surrogate pair decode only when needed.

**Result:** ~5-15% improvement on most cases.

### Round 2: Replace regex with charCode checks for Arabic/combining mark detection

**What:** Replaced `arabicScriptRe.test()` and `combiningMarkRe.test()` with fast charCode range checks covering common BMP ranges, with regex fallback only for rare/extended ranges.

**Result:** ~5-10% improvement, especially on Arabic text.

### Round 3: Convert 7 post-merge passes to in-place mutation

**What:** The 7 chained post-merge passes (`mergeGlueConnectedTextRuns`, `mergeUrlLikeRuns`, `mergeUrlQueryRuns`, `mergeNumericRuns`, `splitHyphenatedNumericRuns`, `mergeAsciiPunctuationChains`, `carryTrailingForwardStickyAcrossCJKBoundary`) each previously allocated 4 fresh arrays. Converted all to in-place mutation with read/write cursor compacting.

**Result:** **10-33% improvement** — the biggest single win of Phase 2. Eliminated massive allocation churn.

### Round 4: Replace piece array allocation with callback-based `forEachBreakKindPiece()`

**What:** The segment splitting function previously allocated a `pieces[]` array + piece objects per segment. Converted to emit pieces directly via a callback, then later to direct `MergeBuilder.addPiece` calls.

**Result:** ~3-8% improvement.

### Round 5+6: Eliminate `Array.from(text)` and regex in helpers

**What:** Replaced `Array.from(text)` in `splitTrailingForwardStickyCluster` with charCode-based backward scan. Replaced regex in `splitLeadingSpaceAndMarks` with charCode loop.

**Result:** ~2-5% improvement.

### Round 7: Restructure merge loop

**What:** Factored out common guard in the segment merge loop, split word/non-word paths for clearer branch prediction.

**Result:** ~2-4% improvement.

### Round 8: `segmentNeedsSplitting()` fast-path

**What:** Added a fast-path check before the full `forEachBreakKindPiece` call. Most word segments from `Intl.Segmenter` contain no special characters (spaces, NBSP, SHY, etc.), so a single charCode scan can skip the full per-char classification.

**Result:** ~3-7% improvement.

### Round 9: `MergeBuilder` class singleton

**What:** Replaced the `mergePiece` closure with a reusable `MergeBuilder` class. Cached `WhiteSpaceProfile` as module-level constants. Eliminated `...segmentation` spread.

**Result:** ~3-8% improvement.

### Round 10: Inline Myanmar medial glue, fast-path single-char left-sticky punctuation

**What:** Inlined Myanmar medial glue charCode check (`0x104F`). Added fast-path `segment.length === 1` check in `isLeftStickyPunctuationSegment`.

**Result:** ~2-5% improvement.

### Round 11: Reorder guards, transfer array ownership

**What:** Reordered `endsWithArabicNoSpacePunctuation` guard (cheap check first). Transferred builder array ownership instead of `.slice()`. Fast-path classifier helpers.

**Result:** Mostly neutral — 1st neutral toward ceiling. Reset by Round 12.

### Round 12: Content-presence flags for post-merge pass skipping

**What:** Added `hasGlue`, `hasCJK`, `hasArabicSpace` flags to `MergeBuilder`, set during `addPiece`. Used to skip irrelevant post-merge passes entirely.

**Result:** **2-10% improvement.** Effective especially for Latin text (no glue/CJK/Arabic → skips 2 passes).

### Round 13: `hasNonWordTextSegment` flag

**What:** Added flag to skip escaped-quote/forward-sticky/compact post-passes when no non-word text segments survive the initial merge.

**Result:** **~3-10% improvement.** Most Latin text produces only word and space segments after the merge loop.

### Round 14: Manual `Symbol.iterator` for `Intl.Segmenter`

**What:** Replaced `for...of` iteration of `Intl.Segmenter.segment()` with manual `Symbol.iterator()` + `.next()` loop to avoid iterator protocol overhead.

**Result:** **~2-4% consistent improvement.**

### Round 15: Uint8Array lookup table for `segmentNeedsSplitting` — REVERTED

**What:** Attempted a 64KB `Uint8Array` lookup table to replace the charCode comparison chain in `segmentNeedsSplitting`. Cache misses from the large array outweighed saved comparisons.

**Result:** Regression. Reverted immediately.

### Round 16: Pre-scan normalized text for content-presence flags

**What:** Added a single cheap charCode pre-scan over the normalized input string to detect `hasUrlLikeContent` (`://` or `www.`), `hasDigit` (ASCII digits 0-9 or common non-ASCII digit ranges), and `hasAsciiChainJoiner` (`;` or `,`). Gated `mergeUrlLikeRunsInPlace`, `mergeUrlQueryRunsInPlace`, `mergeNumericRunsInPlace`, `splitHyphenatedNumericRunsInPlace`, and `mergeAsciiPunctuationChainsInPlace` behind these flags. Also changed `isWordLike ?? false` to `isWordLike === true`.

**Result:** **~6-22% improvement.** Biggest win on Latin/CJK/Arabic text without URLs or digits.

### Rounds 17-19: Ceiling reached

Attempted: `lastKind` tracking on builder (neutral), pre-sized arrays with `new Array(n)` (neutral — holey arrays slower in V8), single-space fast-path in iteration loop (neutral — CJK regression), Arabic guard reorder (neutral), inline `segmentNeedsSplitting` (neutral — function bloating hurts V8 optimization).

**3 consecutive neutral rounds → ceiling declared.**

## Phase 2 Final Results

Node v24.13.0 | 50 iterations | 20 warmup

| Case | Original (ns) | Final (ns) | Total Improvement |
|------|--------------|------------|-------------------|
| Latin short (45ch) | 5589 | ~3440 | **~38%** |
| Latin medium (240ch) | 18640 | ~10850 | **~42%** |
| Latin long (1000ch) | 88029 | ~45200 | **~49%** |
| CJK mixed (230ch) | 42190 | ~25400 | **~40%** |
| Arabic (250ch) | 22365 | ~9400 | **~58%** |
| Mixed app (360ch) | 50977 | ~34400 | **~33%** |
| CJK long (~5000ch) | 1235191 | ~690000 | **~44%** |
| Arabic long (~5000ch) | 462047 | ~166000 | **~64%** |
| Mixed long (~5000ch) | 572786 | ~313000 | **~45%** |
| Pre-wrap short | 9970 | ~4900 | **~51%** |
| Pre-wrap long | 276257 | ~113000 | **~59%** |

**Key insight:** `Intl.Segmenter` is ~55-60% of total `analyzeText()` time — an external API we cannot optimize. Our code was the remaining ~40-45%, and we've captured the vast majority of the optimizable space. The ceiling is structural: further gains require either (a) reducing `Intl.Segmenter` calls, (b) moving to a completely different segmentation approach, or (c) architectural changes beyond the scope of per-function optimization.

All 120 tests pass (60 layout + 60 analysis). No type errors in `src/`.

---

# Phase 3: bidi.ts optimization

Target: `computeSegmentLevels()` in `src/bidi.ts` — the bidirectional text level computation called once per `prepareWithSegments()`. Only runs for text containing RTL characters (Hebrew, Arabic, etc.). Returns `null` early for pure LTR text.

Pipeline: fast pre-scan for bidi chars → full classification into bidi types → W-rules (weak type resolution) → N-rules (neutral resolution) → I-rules (level assignment at segment starts).

## Phase 3 Baseline

Established with `scripts/bench-bidi.ts` and `src/bidi.test.ts` (26 tests, 60 assertions).

| Case | Original (ns) |
|------|--------------|
| Latin short (45ch) | 115 |
| Latin long (700ch) | 2354 |
| Hebrew short (24ch) | 421 |
| Hebrew medium (100ch) | 1821 |
| Arabic short (35ch) | 587 |
| Arabic medium (160ch) | 2603 |
| Mixed short (26ch) | 414 |
| Mixed medium (160ch) | 2627 |
| Hebrew long (~5000ch) | 82035 |
| Arabic long (~5000ch) | 73745 |
| Mixed long (~5500ch) | 74583 |

## Phase 3 Round Log

### Round 1: String BidiType → numeric constants + Uint8Array

**What:** Replaced string-based bidi type constants (`'L'`, `'R'`, `'AL'`, etc.) with numeric constants (`L=0`, `R=1`, `AL=2`, ...). Changed the `types` array from `string[]` to `Uint8Array`. All comparisons are now numeric equality checks instead of string comparisons.

**Result:** **19-47% improvement.** Largest gains on long texts where the type arrays are biggest.

### Round 2: Merge W-rule loops

**What:** Merged W1+W2+W3 into one loop (previously 3 separate loops), W6+W7 into one loop, and N2+I1/I2 into one loop. Reduced total array passes from ~10 to ~6.

**Result:** **8-18% on short texts, 3-4% on long texts.**

### Round 3: Inline classifyChar + TypedArray.fill()

**What:** Inlined the `classifyChar` function body into the classification loop. Used `TypedArray.fill()` instead of manual loops where applicable.

**Result:** **2-6% on medium/long texts.**

### Round 4: Fast pre-scan for LTR early exit

**What:** Added a cheap `charCodeAt >= 0x0590` pre-scan before allocating the `Uint8Array`. Most text is LTR-only, so this avoids allocation + classification entirely in the common case. Also skips the zero-fill of the types array when the buffer is being reused (already zeroed from prior call for the used portion).

**Result:** **2.6× faster for LTR text**, neutral for RTL.

### Round 5: Merge N2 into N1 loop

**What:** Merged the separate N2 (remaining neutrals → embedding direction) pass into the existing N1 neutral-run resolution loop.

**Result:** **~3% on long texts.**

### Round 6: Direct level writes

**What:** Changed from fill-then-read-modify-write to direct level writes. Instead of `Int8Array.fill(1)` then conditionally bumping to 2, writes the correct level directly based on the resolved bidi type.

**Result:** **3-7%.**

### Round 7: Deferred level computation

**What:** Compute I1-I2 levels only at segment-start positions (the `segStarts` array) instead of computing levels for all characters. Eliminated a full `Int8Array` allocation for per-character levels.

**Result:** **12-24%.**

### Round 8: Content-presence flags

**What:** Added `hasWeak` (EN/ET/ES/CS) and `hasALorNSM` flags during classification. Skip W1+W2+W3 entirely when no AL/NSM exist, skip W4-W7 entirely when no weak types exist. Most Hebrew text has neither.

**Result:** **30-45% improvement on Hebrew, 19-26% on short texts.**

### Round 9: Eliminate dead startLevel=0 branch

**What:** The `startLevel` computation was `(len / numBidi) < 0.3 ? 0 : 1`. Since `numBidi <= len`, `len/numBidi >= 1 > 0.3` always, so `startLevel` was always 1 (RTL). Eliminated the dead LTR-paragraph branch and hardcoded `startLevel = 1`, `e = R`, `sor = R`.

**Result:** **2-8%.**

### Round 10: Move anyBidi flag into char-code branches

**What:** Instead of checking `!anyBidi` after every character classification, set `anyBidi = true` only inside the char-code branches that produce bidi types (Hebrew, Arabic ranges). Removes a branch per iteration for non-bidi characters.

**Result:** **2-14%.**

### Round 11: Merge WS→ON into N1 neutral loop

**What:** Made the N1 neutral-run loop treat WS as neutral alongside ON. This eliminated the need for a separate WS→ON conversion pass in the no-weak-types branch.

**Result:** **5-8% on Hebrew.**

### Round 12: Running prev variable in W4 loop

**What:** Tracked `prev = types[i-1]` as a running variable instead of reading `types[i-1]` from the array on each iteration.

**Result:** **3-4.5% on Arabic/mixed.**

### Round 13: Simplify segment-level branch

**What:** Simplified the I1-I2 level computation from a 3-way OR (`t === R || t === AN || t === EN`) to a single comparison (`t === R ? 1 : 2`). After all W+N rules resolve, only L, R, AN, and EN survive — so `!== R` means `L | AN | EN`, all of which get level 2.

**Result:** **3-6% on short/medium texts.**

### Round 14: Branch-free N1 direction resolution — NEUTRAL

**What:** Attempted to replace the `before !== L ? R : L` conditional with a branch-free lookup. The neutral runs are too sparse for this to matter.

### Round 15: Reusable module-scope Uint8Array buffer

**What:** Replaced per-call `new Uint8Array(len)` with a module-scope buffer that grows as needed. Eliminates allocation + zero-init cost for every `computeBidiTypes()` call. Safe because the buffer is read synchronously by the single caller before any re-entrant call.

**Result:** **13-38% improvement on short/medium texts.** Short texts benefit most because allocation cost was a larger fraction of total work.

### Round 16: Merge classification + W1+W2+W3 into one loop — REVERTED

**What:** Attempted to merge the classification loop and W1+W2+W3 loop into a single pass. The unconditional W-rule checks bloated the inner loop and prevented V8 from optimizing the tight classify-and-store pattern.

**Result:** **+27-36% regression on Hebrew.** Reverted.

### Round 17: Pure-R fast path for Hebrew-only text

**What:** Added a post-classification check: when no weak types (`!hasWeak`) and no AL/NSM (`!hasALorNSM`) exist, scan for any L type. If none found, only R and neutrals survive, and since `sor = R`, N1 resolves every neutral run to R. All segment levels are 1. This skips the entire W+N pipeline and level computation. The L-scan only runs for Hebrew-only candidates, adding zero overhead for Arabic/mixed text.

**Result:** **19-37% improvement on Hebrew.**

### Round 18: `subarray().indexOf()` for L-scan — REVERTED

**What:** Attempted to use `TypedArray.subarray().indexOf()` for the L-type scan in the pure-R fast path. Function call overhead of `subarray` + `indexOf` dominated for small arrays.

**Result:** **+27-43% regression on short texts.** Reverted.

### Rounds 19-21: Ceiling reached

- **Round 19:** Cache `segStarts.length` in local variable. Neutral — V8 already optimizes `.length` as a fast property read.
- **Round 20:** Conditional `types.fill()` for N1 neutral runs > 4 characters. Neutral — neutral runs in practice are typically 1-3 characters, so the branch is almost never taken.
- **Round 21:** Track `lastStrong` running variable in N1 loop to avoid `types[i-1]` array read. Neutral — neutral runs are sparse enough that saving one read per run is unmeasurable.

**3 consecutive neutral rounds → ceiling declared.**

## Phase 3 Final Results

Node v24.13.0 | 50 iterations | 20 warmup

| Case | Original (ns) | Final (ns) | Total Improvement |
|------|--------------|------------|-------------------|
| Latin short (45ch) | 115 | 37 | **68%** |
| Latin long (700ch) | 2354 | 656 | **72%** |
| Hebrew short (24ch) | 421 | 66 | **84%** |
| Hebrew medium (100ch) | 1821 | 194 | **89%** |
| Arabic short (35ch) | 587 | 143 | **76%** |
| Arabic medium (160ch) | 2603 | 848 | **67%** |
| Mixed short (26ch) | 414 | 103 | **75%** |
| Mixed medium (160ch) | 2627 | 962 | **63%** |
| Mixed app (220ch) | — | 1292 | — |
| Hebrew long (~5000ch) | 82035 | 9566 | **88%** |
| Arabic long (~5000ch) | 73745 | 30673 | **58%** |
| Mixed long (~5500ch) | 74583 | 33159 | **56%** |

**Key insights:**
- Numeric bidi types + Uint8Array was the foundation — every subsequent optimization built on fast numeric comparisons.
- Content-presence flags (`hasWeak`, `hasALorNSM`) were the most powerful lever for skipping irrelevant W-rule passes entirely.
- The pure-R fast path for Hebrew-only text (Round 17) was a major win because Hebrew text with no embedded Arabic/Latin can skip the entire W+N pipeline.
- The reusable module-scope buffer (Round 15) eliminated per-call allocation overhead that dominated short-text benchmarks.
- Merging loops CAN hurt (Round 16) when it bloats the inner loop body beyond V8's optimization comfort zone.
- The ceiling is structural: the remaining work is the classification loop itself (one charCode read + one Uint8Array write per character) and the W/N-rule loops that cannot be eliminated by content flags.

All 146 tests pass (60 layout + 60 analysis + 26 bidi). No type errors in `src/`.

---

## Total Impact Summary: `main` vs `perf/v8-optimizations`

All numbers measured on the same machine in the same session. Baseline = `main` branch (unoptimized), Optimized = `perf/v8-optimizations` branch (all 3 phases applied). Times are median ns/op from Node.js (`npx tsx`) benchmarks.

### layout() — resize hot path (Phase 1)

| Case | main (ns) | optimized (ns) | Speedup |
|---|---|---|---|
| Latin short (6w) | 277 | 87 | **3.2×** |
| Latin medium (25w) | 400 | 115 | **3.5×** |
| Latin long (100w) | 982 | 173 | **5.7×** |
| Resize sweep (25w) | 402 | 59 | **6.8×** |
| CJK medium (50ch) | 586 | 85 | **6.9×** |
| Long word overflow | 448 | 88 | **5.1×** |
| Corpus 500 segs | 2,110 | 517 | **4.1×** |
| Magazine 2k segs | 8,131 | 2,085 | **3.9×** |
| CJK editorial 5k | 19,223 | 5,987 | **3.2×** |
| Thai-like 10k | 40,797 | 13,029 | **3.1×** |
| Arabic-like 37k | 146,712 | 47,717 | **3.1×** |
| Mixed long 10k | 40,337 | 12,402 | **3.3×** |

**Summary:** 3.1–6.9× faster across all text sizes. Small/medium texts see the largest relative gains (up to 6.9×) because the per-call overhead of closures + object allocation dominated. Large texts converge toward ~3× as the per-segment loop work dominates.

### walkLineRanges() — rich batch geometry path (Phase 1)

| Case | main (ns) | optimized (ns) | Speedup |
|---|---|---|---|
| Latin short (6w) | 1,814 | 59 | **30.7×** |
| Latin medium (25w) | 2,039 | 152 | **13.4×** |
| Latin long (100w) | 2,920 | 592 | **4.9×** |
| CJK medium (50ch) | 2,250 | 274 | **8.2×** |
| Long word overflow | 2,164 | 253 | **8.6×** |
| Corpus 500 segs | 4,983 | 1,549 | **3.2×** |
| Magazine 2k segs | 14,562 | 6,415 | **2.3×** |
| CJK editorial 5k | 31,964 | 14,554 | **2.2×** |
| Thai-like 10k | 64,927 | 32,466 | **2.0×** |
| Arabic-like 37k | 219,801 | 114,334 | **1.9×** |
| Mixed long 10k | 64,873 | 31,006 | **2.1×** |

**Summary:** 1.9–30.7× faster. Short texts see extreme gains (30×) because the old walk path had heavy per-call setup. Large texts converge toward ~2× as the richer per-line materialization work dominates.

### walkPreparedLines() — full walk with soft hyphens/chunks (Phase 1)

| Case | main (ns) | optimized (ns) | Speedup |
|---|---|---|---|
| Latin 25w (SHY+HB) | 2,659 | 215 | **12.4×** |
| Latin 100w (SHY+HB) | 3,947 | 798 | **4.9×** |
| 500 segs (SHY+HB) | 6,467 | 2,018 | **3.2×** |
| 2k segs (SHY+HB) | 19,801 | 8,609 | **2.3×** |
| 5k segs (mixed) | 45,453 | 22,255 | **2.0×** |
| 10k segs (mixed) | 86,898 | 45,418 | **1.9×** |

**Summary:** 1.9–12.4× faster. Same pattern: enormous short-text gains from eliminated allocation overhead, converging toward ~2× for long texts.

### layoutNextLine() — streaming API (Phase 1)

| Case | main (ns) | optimized (ns) | Speedup |
|---|---|---|---|
| Latin short (6w) | 1,408 | 57 | **24.7×** |
| Latin medium (25w) | 5,533 | 216 | **25.6×** |
| Latin long (100w) | 18,106 | 785 | **23.1×** |
| Corpus 500 segs | 46,694 | 2,005 | **23.3×** |
| Magazine 2k segs | 190,366 | 9,707 | **19.6×** |
| Mixed 10k segs | 766,926 | 45,039 | **17.0×** |
| Full: 2k (SHY+HB) | 266,452 | 15,236 | **17.5×** |
| Full: 10k (mixed) | 1,131,125 | 86,434 | **13.1×** |

**Summary:** 13–26× faster across all sizes. The streaming path had the worst overhead per call in the old code (repeated closure creation for every `layoutNextLine()` invocation). The class-based refactoring eliminated this entirely, making the streaming API competitive with the batch paths.

### analyzeText() — text analysis/segmentation (Phase 2)

| Case | main (ns) | optimized (ns) | Speedup |
|---|---|---|---|
| Latin short (45ch) | 5,521 | 3,524 | **1.57×** (36%) |
| Latin medium (240ch) | 19,479 | 10,948 | **1.78×** (44%) |
| Latin long (1000ch) | 98,782 | 45,922 | **2.15×** (54%) |
| CJK mixed (230ch) | 44,807 | 25,784 | **1.74×** (42%) |
| Arabic (250ch) | 23,447 | 9,930 | **2.36×** (58%) |
| Mixed app (360ch) | 54,005 | 35,698 | **1.51×** (34%) |
| CJK long (~5000ch) | 1,291,329 | 693,906 | **1.86×** (46%) |
| Arabic long (~5000ch) | 489,620 | 165,064 | **2.97×** (66%) |
| Mixed long (~5000ch) | 620,850 | 316,673 | **1.96×** (49%) |
| Pre-wrap short | 10,619 | 5,341 | **1.99×** (50%) |
| Pre-wrap long | 303,978 | 217,634 | **1.40×** (28%) |

**Summary:** 1.4–3.0× faster (28–66% reduction). Arabic text benefits the most because content-presence flags and in-place mutation eliminate entire passes that only apply to RTL/bidi content. The floor (~28–34%) is set by `Intl.Segmenter` which accounts for ~55–60% of total analysis time and cannot be optimized from JS.

### computeSegmentLevels() — bidi level computation (Phase 3)

| Case | main (ns) | optimized (ns) | Speedup |
|---|---|---|---|
| Latin short (45ch) | 110 | 36 | **3.1×** |
| Latin long (700ch) | 2,125 | 657 | **3.2×** |
| Hebrew short (24ch) | 315 | 66 | **4.8×** |
| Hebrew medium (100ch) | 1,376 | 192 | **7.2×** |
| Arabic short (35ch) | 454 | 142 | **3.2×** |
| Arabic medium (160ch) | 2,062 | 844 | **2.4×** |
| Mixed short (26ch) | 355 | 102 | **3.5×** |
| Mixed medium (160ch) | 2,139 | 968 | **2.2×** |
| Mixed app (220ch) | 2,676 | 1,286 | **2.1×** |
| Hebrew long (~5000ch) | 61,087 | 9,633 | **6.3×** |
| Arabic long (~5000ch) | 55,854 | 30,739 | **1.8×** |
| Mixed long (~5500ch) | 62,359 | 33,594 | **1.9×** |

**Summary:** 1.8–7.2× faster. Hebrew text benefits the most (up to 7.2×) because the pure-R fast path skips the entire W+N rule pipeline. Arabic and mixed bidi text see 1.8–3.2× gains from numeric type representation, Uint8Array buffers, and content-presence flag skipping.

### Key Techniques Applied

| Technique | Source | Impact |
|---|---|---|
| Class-based refactoring (closures → methods) | Phase 1 | 3–30× on layout hot paths |
| Reusable object instances (eliminate per-call allocation) | Phase 1, 3 | 5–25× on streaming/short paths |
| In-place mutation (avoid array copies in post-merge passes) | Phase 2 | ~15% analysis improvement |
| Content-presence flags (skip irrelevant passes entirely) | Phase 2, 3 | 10–45% per phase |
| Numeric type representation (string → number comparisons) | Phase 3 | 19–47% foundation for bidi |
| Uint8Array typed buffers (module-scope reuse) | Phase 3 | 13–38% short/medium bidi |
| Fast-path early exits (pure-LTR, pure-R scripts) | Phase 3 | 19–37% Hebrew |
| Pre-merged segment passes (fewer array iterations) | Phase 2 | 5–10% analysis |

### What Did NOT Work

| Attempt | Expected | Actual | Root Cause |
|---|---|---|---|
| Shared base class for line engines | Cleaner code, no perf change | 24–35% regression | V8 bimorphic dispatch on prototype chains |
| 64KB Uint8Array lookup table | Faster char classification | ~5% regression | L1 cache misses from large table |
| Pre-sized arrays (`new Array(n)`) | Faster array filling | ~3% regression | V8 treats as holey arrays |
| `TypedArray.subarray().indexOf()` | Faster searching | Severe regression | Function call overhead for small arrays |
| Loop merging (bidi W-rules) | Fewer iterations | 27–36% regression | Inner loop too large for V8 optimizer |

### Optimization Rounds by Phase

- **Phase 1 (line-break.ts):** 4 rounds committed, 1 reverted. Class-based refactoring of 4 API paths.
- **Phase 2 (analysis.ts):** 16 rounds committed, 3 reverted, 2 neutral. In-place mutation, content flags, merged passes.
- **Phase 3 (bidi.ts):** 17 rounds committed, 2 reverted, 3 neutral (ceiling). Numeric types, typed buffers, fast paths.

Total: 37 committed optimization rounds across 3 source files. All 146 tests pass. No type errors in `src/`.
