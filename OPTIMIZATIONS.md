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

1. **Eliminate closure helpers in `countPreparedLinesSimple`** — The hottest path (`layout()` calls this). Currently has a nested `placeOnFreshLine()` closure that V8 compiles in the parent's context. Inline it.

2. **Eliminate closure helpers in `walkPreparedLinesSimple`** — 7 nested closures (`clearPendingBreak`, `emitCurrentLine`, `startLineAtSegment`, `startLineAtGrapheme`, `appendWholeSegment`, `updatePendingBreak`, `appendBreakableSegment/From`). All share mutable state via closure variables. This is the exact anti-pattern from the guide: "15-20 functions inside a large outer function" where V8 treats them as a single compilation context.

3. **Eliminate closure helpers in `walkPreparedLines`** (full path) — Same pattern as above but with even more closures for soft-hyphen and tab handling.

4. **Eliminate closure helpers in `layoutNextLineRange`** and `layoutNextLineRangeSimple` — Streaming API variants with the same closure pattern.

### Tier 2: Algorithmic (+5-25% expected)

5. **Cache `getEngineProfile()` result** — Called at the top of every line-break function. The profile is effectively a singleton after first access, but V8 still pays function-call overhead each time.

6. **Lookup table for break-kind classification** — `canBreakAfter()` and `isSimpleCollapsibleSpace()` use string equality chains. A numeric enum + bitflag table would be a single array lookup.

7. **Optimize `isCJK` with `charCodeAt`** — Currently uses `for...of` + `codePointAt()`. For BMP CJK (most common), `charCodeAt` avoids iterator overhead.

### Tier 3: V8 Micro (+1-5% expected)

8. **Pre-compute `maxWidth + lineFitEpsilon`** — Currently computed as `maxWidth + lineFitEpsilon` on every overflow check in inner loops.

9. **Uniform object shapes for `createEmptyPrepared`** — Currently two code paths with different shapes (with/without `segments`).

10. **Reduce intermediate allocations in analysis merge passes** — Multiple `mergeXxxRuns()` functions create fresh arrays. Could mutate in place.

---

## Round Log

### Round 0: Branch creation
- Created `perf/v8-optimizations` branch
- All 60 tests pass
- Baseline established from STATUS.md benchmarks
