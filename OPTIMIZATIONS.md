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
