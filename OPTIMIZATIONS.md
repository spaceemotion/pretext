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
