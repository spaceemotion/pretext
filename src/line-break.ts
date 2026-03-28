import type { SegmentBreakKind } from './analysis.ts'
import { getEngineProfile } from './measurement.ts'

export type LineBreakCursor = {
  segmentIndex: number
  graphemeIndex: number
}

export type PreparedLineBreakData = {
  widths: number[]
  lineEndFitAdvances: number[]
  lineEndPaintAdvances: number[]
  kinds: SegmentBreakKind[]
  simpleLineWalkFastPath: boolean
  breakableWidths: (number[] | null)[]
  breakablePrefixWidths: (number[] | null)[]
  discretionaryHyphenWidth: number
  tabStopAdvance: number
  chunks: {
    startSegmentIndex: number
    endSegmentIndex: number
    consumedEndSegmentIndex: number
  }[]
}

export type InternalLayoutLine = {
  startSegmentIndex: number
  startGraphemeIndex: number
  endSegmentIndex: number
  endGraphemeIndex: number
  width: number
}

function canBreakAfter(kind: SegmentBreakKind): boolean {
  // Negative check: 3 comparisons instead of 5.
  // 'text' is the most common kind, so it short-circuits first.
  return kind !== 'text' && kind !== 'glue' && kind !== 'hard-break'
}


function getTabAdvance(lineWidth: number, tabStopAdvance: number): number {
  if (tabStopAdvance <= 0) return 0

  const remainder = lineWidth % tabStopAdvance
  if (Math.abs(remainder) <= 1e-6) return tabStopAdvance
  return tabStopAdvance - remainder
}

function getBreakableAdvance(
  graphemeWidths: number[],
  graphemePrefixWidths: number[] | null,
  graphemeIndex: number,
  preferPrefixWidths: boolean,
): number {
  if (!preferPrefixWidths || graphemePrefixWidths === null) {
    return graphemeWidths[graphemeIndex]!
  }
  return graphemePrefixWidths[graphemeIndex]! - (graphemeIndex > 0 ? graphemePrefixWidths[graphemeIndex - 1]! : 0)
}

function fitSoftHyphenBreak(
  graphemeWidths: number[],
  initialWidth: number,
  effectiveMaxWidth: number,
  discretionaryHyphenWidth: number,
  cumulativeWidths: boolean,
): { fitCount: number, fittedWidth: number } {
  let fitCount = 0
  let fittedWidth = initialWidth

  while (fitCount < graphemeWidths.length) {
    const nextWidth = cumulativeWidths
      ? initialWidth + graphemeWidths[fitCount]!
      : fittedWidth + graphemeWidths[fitCount]!
    const nextLineWidth = fitCount + 1 < graphemeWidths.length
      ? nextWidth + discretionaryHyphenWidth
      : nextWidth
    if (nextLineWidth > effectiveMaxWidth) break
    fittedWidth = nextWidth
    fitCount++
  }

  return { fitCount, fittedWidth }
}

function findChunkIndexForStart(prepared: PreparedLineBreakData, segmentIndex: number): number {
  for (let i = 0; i < prepared.chunks.length; i++) {
    const chunk = prepared.chunks[i]!
    if (segmentIndex < chunk.consumedEndSegmentIndex) return i
  }
  return -1
}

export function normalizeLineStart(
  prepared: PreparedLineBreakData,
  start: LineBreakCursor,
): LineBreakCursor | null {
  let segmentIndex = start.segmentIndex
  const graphemeIndex = start.graphemeIndex

  if (segmentIndex >= prepared.widths.length) return null
  if (graphemeIndex > 0) return start

  const chunkIndex = findChunkIndexForStart(prepared, segmentIndex)
  if (chunkIndex < 0) return null

  const chunk = prepared.chunks[chunkIndex]!
  if (chunk.startSegmentIndex === chunk.endSegmentIndex && segmentIndex === chunk.startSegmentIndex) {
    return { segmentIndex, graphemeIndex: 0 }
  }

  if (segmentIndex < chunk.startSegmentIndex) segmentIndex = chunk.startSegmentIndex
  while (segmentIndex < chunk.endSegmentIndex) {
    const kind = prepared.kinds[segmentIndex]!
    if (kind !== 'space' && kind !== 'zero-width-break' && kind !== 'soft-hyphen') {
      return { segmentIndex, graphemeIndex: 0 }
    }
    segmentIndex++
  }

  if (chunk.consumedEndSegmentIndex >= prepared.widths.length) return null
  return { segmentIndex: chunk.consumedEndSegmentIndex, graphemeIndex: 0 }
}

export function countPreparedLines(prepared: PreparedLineBreakData, maxWidth: number): number {
  if (prepared.simpleLineWalkFastPath) {
    return countPreparedLinesSimple(prepared, maxWidth)
  }
  return walkPreparedLines(prepared, maxWidth)
}

class SimpleLineCounter {
  private lineCount = 0
  private lineW = 0
  private hasContent = false

  // Bound once per run — avoids repeated property access in tight loops
  private widths!: number[]
  private breakableWidths!: (number[] | null)[]
  private breakablePrefixWidths!: (number[] | null)[]
  private maxWidth = 0
  private lineFitEpsilon = 0
  private effectiveMaxWidth = 0
  private preferPrefixWidths = false

  run(prepared: PreparedLineBreakData, maxWidth: number): number {
    const { widths, kinds, breakableWidths, breakablePrefixWidths } = prepared
    if (widths.length === 0) return 0

    const engineProfile = getEngineProfile()

    this.widths = widths
    this.breakableWidths = breakableWidths
    this.breakablePrefixWidths = breakablePrefixWidths
    this.maxWidth = maxWidth
    this.lineFitEpsilon = engineProfile.lineFitEpsilon
    this.effectiveMaxWidth = maxWidth + engineProfile.lineFitEpsilon
    this.preferPrefixWidths = engineProfile.preferPrefixWidthsForBreakableRuns
    this.lineCount = 0
    this.lineW = 0
    this.hasContent = false

    // Cache this.* in locals for the tight inner loop
    let lineW = 0
    let lineCount = 0
    let hasContent = false
    const effectiveMaxWidth = this.effectiveMaxWidth

    for (let i = 0; i < widths.length; i++) {
      const w = widths[i]!
      const kind = kinds[i]!

      if (!hasContent) {
        // Sync state for placeOnFreshLine
        this.lineW = lineW
        this.lineCount = lineCount
        this.hasContent = hasContent
        this.placeOnFreshLine(i)
        // Sync back
        lineW = this.lineW
        lineCount = this.lineCount
        hasContent = this.hasContent
        continue
      }

      const newW = lineW + w
      if (newW > effectiveMaxWidth) {
        if (kind === 'space') continue
        lineW = 0
        hasContent = false
        // Sync state for placeOnFreshLine
        this.lineW = lineW
        this.lineCount = lineCount
        this.hasContent = hasContent
        this.placeOnFreshLine(i)
        // Sync back
        lineW = this.lineW
        lineCount = this.lineCount
        hasContent = this.hasContent
        continue
      }

      lineW = newW
    }

    if (!hasContent) return lineCount + 1
    return lineCount
  }

  private placeOnFreshLine(segmentIndex: number): void {
    const w = this.widths[segmentIndex]!
    const maxWidth = this.maxWidth
    if (w > maxWidth && this.breakableWidths[segmentIndex] !== null) {
      const gWidths = this.breakableWidths[segmentIndex]!
      const gPrefixWidths = this.breakablePrefixWidths[segmentIndex] ?? null
      const effectiveMaxWidth = this.effectiveMaxWidth
      const preferPrefixWidths = this.preferPrefixWidths
      let lineW = 0
      let lineCount = this.lineCount
      for (let g = 0; g < gWidths.length; g++) {
        const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)
        if (lineW > 0 && lineW + gw > effectiveMaxWidth) {
          lineCount++
          lineW = gw
        } else {
          if (lineW === 0) lineCount++
          lineW += gw
        }
      }
      this.lineW = lineW
      this.lineCount = lineCount
    } else {
      this.lineW = w
      this.lineCount++
    }
    this.hasContent = true
  }
}

const simpleLineCounter = new SimpleLineCounter()

function countPreparedLinesSimple(prepared: PreparedLineBreakData, maxWidth: number): number {
  return simpleLineCounter.run(prepared, maxWidth)
}

class SimpleLineWalker {
  // Per-run state
  private lineCount = 0
  private lineW = 0
  private hasContent = false
  private lineStartSegmentIndex = 0
  private lineStartGraphemeIndex = 0
  private lineEndSegmentIndex = 0
  private lineEndGraphemeIndex = 0
  private pendingBreakSegmentIndex = -1
  private pendingBreakPaintWidth = 0

  // Bound once per run
  private widths!: number[]
  private kinds!: SegmentBreakKind[]
  private breakableWidths!: (number[] | null)[]
  private breakablePrefixWidths!: (number[] | null)[]
  private maxWidth = 0
  private lineFitEpsilon = 0
  private effectiveMaxWidth = 0
  private preferPrefixWidths = false
  private onLine: ((line: InternalLayoutLine) => void) | undefined = undefined

  run(
    prepared: PreparedLineBreakData,
    maxWidth: number,
    onLine?: (line: InternalLayoutLine) => void,
  ): number {
    const { widths, kinds, breakableWidths, breakablePrefixWidths } = prepared
    if (widths.length === 0) return 0

    const engineProfile = getEngineProfile()

    this.widths = widths
    this.kinds = kinds
    this.breakableWidths = breakableWidths
    this.breakablePrefixWidths = breakablePrefixWidths
    this.maxWidth = maxWidth
    this.lineFitEpsilon = engineProfile.lineFitEpsilon
    this.effectiveMaxWidth = maxWidth + engineProfile.lineFitEpsilon
    this.preferPrefixWidths = engineProfile.preferPrefixWidthsForBreakableRuns
    this.onLine = onLine
    this.lineCount = 0
    this.lineW = 0
    this.hasContent = false
    this.lineStartSegmentIndex = 0
    this.lineStartGraphemeIndex = 0
    this.lineEndSegmentIndex = 0
    this.lineEndGraphemeIndex = 0
    this.pendingBreakSegmentIndex = -1
    this.pendingBreakPaintWidth = 0

    const effectiveMaxWidth = this.effectiveMaxWidth

    let i = 0
    while (i < widths.length) {
      const w = widths[i]!
      const kind = kinds[i]!

      if (!this.hasContent) {
        if (w > maxWidth && breakableWidths[i] !== null) {
          this.appendBreakableSegmentFrom(i, 0)
        } else {
          this.startLineAtSegment(i, w)
        }
        this.updatePendingBreak(i, w)
        i++
        continue
      }

      const newW = this.lineW + w
      if (newW > effectiveMaxWidth) {
        if (canBreakAfter(kind)) {
          this.appendWholeSegment(i, w)
          this.emitCurrentLine(i + 1, 0, this.lineW - w)
          i++
          continue
        }

        if (this.pendingBreakSegmentIndex >= 0) {
          this.emitCurrentLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
          continue
        }

        if (w > maxWidth && breakableWidths[i] !== null) {
          this.emitCurrentLine()
          this.appendBreakableSegmentFrom(i, 0)
          i++
          continue
        }

        this.emitCurrentLine()
        continue
      }

      this.appendWholeSegment(i, w)
      this.updatePendingBreak(i, w)
      i++
    }

    if (this.hasContent) this.emitCurrentLine()
    return this.lineCount
  }

  private emitCurrentLine(
    endSegmentIndex = this.lineEndSegmentIndex,
    endGraphemeIndex = this.lineEndGraphemeIndex,
    width = this.lineW,
  ): void {
    this.lineCount++
    this.onLine?.({
      startSegmentIndex: this.lineStartSegmentIndex,
      startGraphemeIndex: this.lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    })
    this.lineW = 0
    this.hasContent = false
    this.pendingBreakSegmentIndex = -1
    this.pendingBreakPaintWidth = 0
  }

  private startLineAtSegment(segmentIndex: number, width: number): void {
    this.hasContent = true
    this.lineStartSegmentIndex = segmentIndex
    this.lineStartGraphemeIndex = 0
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
    this.lineW = width
  }

  private startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    this.hasContent = true
    this.lineStartSegmentIndex = segmentIndex
    this.lineStartGraphemeIndex = graphemeIndex
    this.lineEndSegmentIndex = segmentIndex
    this.lineEndGraphemeIndex = graphemeIndex + 1
    this.lineW = width
  }

  private appendWholeSegment(segmentIndex: number, width: number): void {
    if (!this.hasContent) {
      this.startLineAtSegment(segmentIndex, width)
      return
    }
    this.lineW += width
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
  }

  private updatePendingBreak(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(this.kinds[segmentIndex]!)) return
    this.pendingBreakSegmentIndex = segmentIndex + 1
    this.pendingBreakPaintWidth = this.lineW - segmentWidth
  }

  private appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIdx: number): void {
    const gWidths = this.breakableWidths[segmentIndex]!
    const gPrefixWidths = this.breakablePrefixWidths[segmentIndex] ?? null
    const effectiveMaxWidth = this.effectiveMaxWidth
    const preferPrefixWidths = this.preferPrefixWidths

    for (let g = startGraphemeIdx; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)

      if (!this.hasContent) {
        this.startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (this.lineW + gw > effectiveMaxWidth) {
        this.emitCurrentLine()
        this.startLineAtGrapheme(segmentIndex, g, gw)
      } else {
        this.lineW += gw
        this.lineEndSegmentIndex = segmentIndex
        this.lineEndGraphemeIndex = g + 1
      }
    }

    if (this.hasContent && this.lineEndSegmentIndex === segmentIndex && this.lineEndGraphemeIndex === gWidths.length) {
      this.lineEndSegmentIndex = segmentIndex + 1
      this.lineEndGraphemeIndex = 0
    }
  }
}

const simpleLineWalker = new SimpleLineWalker()

function walkPreparedLinesSimple(
  prepared: PreparedLineBreakData,
  maxWidth: number,
  onLine?: (line: InternalLayoutLine) => void,
): number {
  return simpleLineWalker.run(prepared, maxWidth, onLine)
}

class FullLineWalker {
  // Per-run state
  private lineCount = 0
  private lineW = 0
  private hasContent = false
  private lineStartSegmentIndex = 0
  private lineStartGraphemeIndex = 0
  private lineEndSegmentIndex = 0
  private lineEndGraphemeIndex = 0
  private pendingBreakSegmentIndex = -1
  private pendingBreakFitWidth = 0
  private pendingBreakPaintWidth = 0
  private pendingBreakKind: SegmentBreakKind | null = null

  // Bound once per run
  private widths!: number[]
  private lineEndFitAdvances!: number[]
  private lineEndPaintAdvances!: number[]
  private kinds!: SegmentBreakKind[]
  private breakableWidths!: (number[] | null)[]
  private breakablePrefixWidths!: (number[] | null)[]
  private discretionaryHyphenWidth = 0
  private tabStopAdvance = 0
  private maxWidth = 0
  private lineFitEpsilon = 0
  private effectiveMaxWidth = 0
  private preferPrefixWidths = false
  private preferEarlySoftHyphenBreak = false
  private onLine: ((line: InternalLayoutLine) => void) | undefined = undefined

  run(
    prepared: PreparedLineBreakData,
    maxWidth: number,
    onLine?: (line: InternalLayoutLine) => void,
  ): number {
    const {
      widths,
      lineEndFitAdvances,
      lineEndPaintAdvances,
      kinds,
      breakableWidths,
      breakablePrefixWidths,
      discretionaryHyphenWidth,
      tabStopAdvance,
      chunks,
    } = prepared
    if (widths.length === 0 || chunks.length === 0) return 0

    const engineProfile = getEngineProfile()

    this.widths = widths
    this.lineEndFitAdvances = lineEndFitAdvances
    this.lineEndPaintAdvances = lineEndPaintAdvances
    this.kinds = kinds
    this.breakableWidths = breakableWidths
    this.breakablePrefixWidths = breakablePrefixWidths
    this.discretionaryHyphenWidth = discretionaryHyphenWidth
    this.tabStopAdvance = tabStopAdvance
    this.maxWidth = maxWidth
    this.lineFitEpsilon = engineProfile.lineFitEpsilon
    this.effectiveMaxWidth = maxWidth + engineProfile.lineFitEpsilon
    this.preferPrefixWidths = engineProfile.preferPrefixWidthsForBreakableRuns
    this.preferEarlySoftHyphenBreak = engineProfile.preferEarlySoftHyphenBreak
    this.onLine = onLine
    this.lineCount = 0

    const effectiveMaxWidth = this.effectiveMaxWidth

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex]!
      if (chunk.startSegmentIndex === chunk.endSegmentIndex) {
        this.emitEmptyChunk(chunk)
        continue
      }

      this.hasContent = false
      this.lineW = 0
      this.lineStartSegmentIndex = chunk.startSegmentIndex
      this.lineStartGraphemeIndex = 0
      this.lineEndSegmentIndex = chunk.startSegmentIndex
      this.lineEndGraphemeIndex = 0
      this.clearPendingBreak()

      let i = chunk.startSegmentIndex
      while (i < chunk.endSegmentIndex) {
        const kind = kinds[i]!
        const w = kind === 'tab' ? getTabAdvance(this.lineW, tabStopAdvance) : widths[i]!

        if (kind === 'soft-hyphen') {
          if (this.hasContent) {
            this.lineEndSegmentIndex = i + 1
            this.lineEndGraphemeIndex = 0
            this.pendingBreakSegmentIndex = i + 1
            this.pendingBreakFitWidth = this.lineW + discretionaryHyphenWidth
            this.pendingBreakPaintWidth = this.lineW + discretionaryHyphenWidth
            this.pendingBreakKind = kind
          }
          i++
          continue
        }

        if (!this.hasContent) {
          if (w > maxWidth && breakableWidths[i] !== null) {
            this.appendBreakableSegmentFrom(i, 0)
          } else {
            this.startLineAtSegment(i, w)
          }
          this.updatePendingBreakForWholeSegment(i, w)
          i++
          continue
        }

      const newW = this.lineW + w
      if (newW > effectiveMaxWidth) {
          const currentBreakFitWidth = this.lineW + (kind === 'tab' ? 0 : lineEndFitAdvances[i]!)
          const currentBreakPaintWidth = this.lineW + (kind === 'tab' ? w : lineEndPaintAdvances[i]!)

          if (
            this.pendingBreakKind === 'soft-hyphen' &&
            this.preferEarlySoftHyphenBreak &&
            this.pendingBreakFitWidth <= effectiveMaxWidth
          ) {
            this.emitCurrentLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
            continue
          }

          if (this.pendingBreakKind === 'soft-hyphen' && this.continueSoftHyphenBreakableSegment(i)) {
            i++
            continue
          }

          if (canBreakAfter(kind) && currentBreakFitWidth <= effectiveMaxWidth) {
            this.appendWholeSegment(i, w)
            this.emitCurrentLine(i + 1, 0, currentBreakPaintWidth)
            i++
            continue
          }

          if (this.pendingBreakSegmentIndex >= 0 && this.pendingBreakFitWidth <= effectiveMaxWidth) {
            this.emitCurrentLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
            continue
          }

          if (w > maxWidth && breakableWidths[i] !== null) {
            this.emitCurrentLine()
            this.appendBreakableSegmentFrom(i, 0)
            i++
            continue
          }

          this.emitCurrentLine()
          continue
        }

        this.appendWholeSegment(i, w)
        this.updatePendingBreakForWholeSegment(i, w)
        i++
      }

      if (this.hasContent) {
        const finalPaintWidth =
          this.pendingBreakSegmentIndex === chunk.consumedEndSegmentIndex
            ? this.pendingBreakPaintWidth
            : this.lineW
        this.emitCurrentLine(chunk.consumedEndSegmentIndex, 0, finalPaintWidth)
      }
    }

    return this.lineCount
  }

  private clearPendingBreak(): void {
    this.pendingBreakSegmentIndex = -1
    this.pendingBreakFitWidth = 0
    this.pendingBreakPaintWidth = 0
    this.pendingBreakKind = null
  }

  private emitCurrentLine(
    endSegmentIndex = this.lineEndSegmentIndex,
    endGraphemeIndex = this.lineEndGraphemeIndex,
    width = this.lineW,
  ): void {
    this.lineCount++
    this.onLine?.({
      startSegmentIndex: this.lineStartSegmentIndex,
      startGraphemeIndex: this.lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    })
    this.lineW = 0
    this.hasContent = false
    this.clearPendingBreak()
  }

  private startLineAtSegment(segmentIndex: number, width: number): void {
    this.hasContent = true
    this.lineStartSegmentIndex = segmentIndex
    this.lineStartGraphemeIndex = 0
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
    this.lineW = width
  }

  private startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    this.hasContent = true
    this.lineStartSegmentIndex = segmentIndex
    this.lineStartGraphemeIndex = graphemeIndex
    this.lineEndSegmentIndex = segmentIndex
    this.lineEndGraphemeIndex = graphemeIndex + 1
    this.lineW = width
  }

  private appendWholeSegment(segmentIndex: number, width: number): void {
    if (!this.hasContent) {
      this.startLineAtSegment(segmentIndex, width)
      return
    }
    this.lineW += width
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
  }

  private updatePendingBreakForWholeSegment(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(this.kinds[segmentIndex]!)) return
    const kind = this.kinds[segmentIndex]!
    const fitAdvance = kind === 'tab' ? 0 : this.lineEndFitAdvances[segmentIndex]!
    const paintAdvance = kind === 'tab' ? segmentWidth : this.lineEndPaintAdvances[segmentIndex]!
    this.pendingBreakSegmentIndex = segmentIndex + 1
    this.pendingBreakFitWidth = this.lineW - segmentWidth + fitAdvance
    this.pendingBreakPaintWidth = this.lineW - segmentWidth + paintAdvance
    this.pendingBreakKind = kind
  }

  private appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIdx: number): void {
    const gWidths = this.breakableWidths[segmentIndex]!
    const gPrefixWidths = this.breakablePrefixWidths[segmentIndex] ?? null
    const effectiveMaxWidth = this.effectiveMaxWidth
    const preferPrefixWidths = this.preferPrefixWidths

    for (let g = startGraphemeIdx; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)

      if (!this.hasContent) {
        this.startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (this.lineW + gw > effectiveMaxWidth) {
        this.emitCurrentLine()
        this.startLineAtGrapheme(segmentIndex, g, gw)
      } else {
        this.lineW += gw
        this.lineEndSegmentIndex = segmentIndex
        this.lineEndGraphemeIndex = g + 1
      }
    }

    if (this.hasContent && this.lineEndSegmentIndex === segmentIndex && this.lineEndGraphemeIndex === gWidths.length) {
      this.lineEndSegmentIndex = segmentIndex + 1
      this.lineEndGraphemeIndex = 0
    }
  }

  private continueSoftHyphenBreakableSegment(segmentIndex: number): boolean {
    if (this.pendingBreakKind !== 'soft-hyphen') return false
    const gWidths = this.breakableWidths[segmentIndex]!
    if (gWidths === null) return false
    const fitWidths = this.preferPrefixWidths
      ? this.breakablePrefixWidths[segmentIndex] ?? gWidths
      : gWidths
    const usesPrefixWidths = fitWidths !== gWidths
    const { fitCount, fittedWidth } = fitSoftHyphenBreak(
      fitWidths,
      this.lineW,
      this.effectiveMaxWidth,
      this.discretionaryHyphenWidth,
      usesPrefixWidths,
    )
    if (fitCount === 0) return false

    this.lineW = fittedWidth
    this.lineEndSegmentIndex = segmentIndex
    this.lineEndGraphemeIndex = fitCount
    this.clearPendingBreak()

    if (fitCount === gWidths.length) {
      this.lineEndSegmentIndex = segmentIndex + 1
      this.lineEndGraphemeIndex = 0
      return true
    }

    this.emitCurrentLine(
      segmentIndex,
      fitCount,
      fittedWidth + this.discretionaryHyphenWidth,
    )
    this.appendBreakableSegmentFrom(segmentIndex, fitCount)
    return true
  }

  private emitEmptyChunk(chunk: { startSegmentIndex: number, consumedEndSegmentIndex: number }): void {
    this.lineCount++
    this.onLine?.({
      startSegmentIndex: chunk.startSegmentIndex,
      startGraphemeIndex: 0,
      endSegmentIndex: chunk.consumedEndSegmentIndex,
      endGraphemeIndex: 0,
      width: 0,
    })
    this.clearPendingBreak()
  }
}

const fullLineWalker = new FullLineWalker()

export function walkPreparedLines(
  prepared: PreparedLineBreakData,
  maxWidth: number,
  onLine?: (line: InternalLayoutLine) => void,
): number {
  if (prepared.simpleLineWalkFastPath) {
    return walkPreparedLinesSimple(prepared, maxWidth, onLine)
  }
  return fullLineWalker.run(prepared, maxWidth, onLine)
}

class FullLineRangeStepper {
  // Per-run state
  private lineW = 0
  private hasContent = false
  private lineStartSegmentIndex = 0
  private lineStartGraphemeIndex = 0
  private lineEndSegmentIndex = 0
  private lineEndGraphemeIndex = 0
  private pendingBreakSegmentIndex = -1
  private pendingBreakFitWidth = 0
  private pendingBreakPaintWidth = 0
  private pendingBreakKind: SegmentBreakKind | null = null

  // Bound once per run
  private widths!: number[]
  private lineEndFitAdvances!: number[]
  private lineEndPaintAdvances!: number[]
  private kinds!: SegmentBreakKind[]
  private breakableWidths!: (number[] | null)[]
  private breakablePrefixWidths!: (number[] | null)[]
  private discretionaryHyphenWidth = 0
  private tabStopAdvance = 0
  private maxWidth = 0
  private lineFitEpsilon = 0
  private effectiveMaxWidth = 0
  private preferPrefixWidths = false
  private preferEarlySoftHyphenBreak = false

  run(
    prepared: PreparedLineBreakData,
    normalizedStart: LineBreakCursor,
    maxWidth: number,
  ): InternalLayoutLine | null {
    const chunkIndex = findChunkIndexForStart(prepared, normalizedStart.segmentIndex)
    if (chunkIndex < 0) return null

    const chunk = prepared.chunks[chunkIndex]!
    if (chunk.startSegmentIndex === chunk.endSegmentIndex) {
      return {
        startSegmentIndex: chunk.startSegmentIndex,
        startGraphemeIndex: 0,
        endSegmentIndex: chunk.consumedEndSegmentIndex,
        endGraphemeIndex: 0,
        width: 0,
      }
    }

    const {
      widths,
      lineEndFitAdvances,
      lineEndPaintAdvances,
      kinds,
      breakableWidths,
      breakablePrefixWidths,
      discretionaryHyphenWidth,
      tabStopAdvance,
    } = prepared
    const engineProfile = getEngineProfile()

    this.widths = widths
    this.lineEndFitAdvances = lineEndFitAdvances
    this.lineEndPaintAdvances = lineEndPaintAdvances
    this.kinds = kinds
    this.breakableWidths = breakableWidths
    this.breakablePrefixWidths = breakablePrefixWidths
    this.discretionaryHyphenWidth = discretionaryHyphenWidth
    this.tabStopAdvance = tabStopAdvance
    this.maxWidth = maxWidth
    this.lineFitEpsilon = engineProfile.lineFitEpsilon
    this.effectiveMaxWidth = maxWidth + engineProfile.lineFitEpsilon
    this.preferPrefixWidths = engineProfile.preferPrefixWidthsForBreakableRuns
    this.preferEarlySoftHyphenBreak = engineProfile.preferEarlySoftHyphenBreak
    this.lineW = 0
    this.hasContent = false
    this.lineStartSegmentIndex = normalizedStart.segmentIndex
    this.lineStartGraphemeIndex = normalizedStart.graphemeIndex
    this.lineEndSegmentIndex = normalizedStart.segmentIndex
    this.lineEndGraphemeIndex = normalizedStart.graphemeIndex
    this.pendingBreakSegmentIndex = -1
    this.pendingBreakFitWidth = 0
    this.pendingBreakPaintWidth = 0
    this.pendingBreakKind = null

    const effectiveMaxWidth = this.effectiveMaxWidth

    for (let i = normalizedStart.segmentIndex; i < chunk.endSegmentIndex; i++) {
      const kind = kinds[i]!
      const startGraphemeIndex = i === normalizedStart.segmentIndex ? normalizedStart.graphemeIndex : 0
      const w = kind === 'tab' ? getTabAdvance(this.lineW, tabStopAdvance) : widths[i]!

      if (kind === 'soft-hyphen' && startGraphemeIndex === 0) {
        if (this.hasContent) {
          this.lineEndSegmentIndex = i + 1
          this.lineEndGraphemeIndex = 0
          this.pendingBreakSegmentIndex = i + 1
          this.pendingBreakFitWidth = this.lineW + discretionaryHyphenWidth
          this.pendingBreakPaintWidth = this.lineW + discretionaryHyphenWidth
          this.pendingBreakKind = kind
        }
        continue
      }

      if (!this.hasContent) {
        if (startGraphemeIndex > 0) {
          const line = this.appendBreakableSegmentFrom(i, startGraphemeIndex)
          if (line !== null) return line
        } else if (w > maxWidth && breakableWidths[i] !== null) {
          const line = this.appendBreakableSegmentFrom(i, 0)
          if (line !== null) return line
        } else {
          this.startLineAtSegment(i, w)
        }
        this.updatePendingBreakForWholeSegment(i, w)
        continue
      }

      const newW = this.lineW + w
      if (newW > effectiveMaxWidth) {
        const currentBreakFitWidth = this.lineW + (kind === 'tab' ? 0 : lineEndFitAdvances[i]!)
        const currentBreakPaintWidth = this.lineW + (kind === 'tab' ? w : lineEndPaintAdvances[i]!)

        if (
          this.pendingBreakKind === 'soft-hyphen' &&
          this.preferEarlySoftHyphenBreak &&
          this.pendingBreakFitWidth <= effectiveMaxWidth
        ) {
          return this.finishLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
        }

        const softBreakLine = this.maybeFinishAtSoftHyphen(i)
        if (softBreakLine !== null) return softBreakLine

        if (canBreakAfter(kind) && currentBreakFitWidth <= effectiveMaxWidth) {
          this.appendWholeSegment(i, w)
          return this.finishLine(i + 1, 0, currentBreakPaintWidth)
        }

        if (this.pendingBreakSegmentIndex >= 0 && this.pendingBreakFitWidth <= effectiveMaxWidth) {
          return this.finishLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
        }

        if (w > maxWidth && breakableWidths[i] !== null) {
          const currentLine = this.finishLine()
          if (currentLine !== null) return currentLine
          const line = this.appendBreakableSegmentFrom(i, 0)
          if (line !== null) return line
        }

        return this.finishLine()
      }

      this.appendWholeSegment(i, w)
      this.updatePendingBreakForWholeSegment(i, w)
    }

    if (this.pendingBreakSegmentIndex === chunk.consumedEndSegmentIndex && this.lineEndGraphemeIndex === 0) {
      return this.finishLine(chunk.consumedEndSegmentIndex, 0, this.pendingBreakPaintWidth)
    }

    return this.finishLine(chunk.consumedEndSegmentIndex, 0, this.lineW)
  }

  private clearPendingBreak(): void {
    this.pendingBreakSegmentIndex = -1
    this.pendingBreakFitWidth = 0
    this.pendingBreakPaintWidth = 0
    this.pendingBreakKind = null
  }

  private finishLine(
    endSegmentIndex = this.lineEndSegmentIndex,
    endGraphemeIndex = this.lineEndGraphemeIndex,
    width = this.lineW,
  ): InternalLayoutLine | null {
    if (!this.hasContent) return null
    return {
      startSegmentIndex: this.lineStartSegmentIndex,
      startGraphemeIndex: this.lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    }
  }

  private startLineAtSegment(segmentIndex: number, width: number): void {
    this.hasContent = true
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
    this.lineW = width
  }

  private startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    this.hasContent = true
    this.lineEndSegmentIndex = segmentIndex
    this.lineEndGraphemeIndex = graphemeIndex + 1
    this.lineW = width
  }

  private appendWholeSegment(segmentIndex: number, width: number): void {
    if (!this.hasContent) {
      this.startLineAtSegment(segmentIndex, width)
      return
    }
    this.lineW += width
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
  }

  private updatePendingBreakForWholeSegment(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(this.kinds[segmentIndex]!)) return
    const kind = this.kinds[segmentIndex]!
    const fitAdvance = kind === 'tab' ? 0 : this.lineEndFitAdvances[segmentIndex]!
    const paintAdvance = kind === 'tab' ? segmentWidth : this.lineEndPaintAdvances[segmentIndex]!
    this.pendingBreakSegmentIndex = segmentIndex + 1
    this.pendingBreakFitWidth = this.lineW - segmentWidth + fitAdvance
    this.pendingBreakPaintWidth = this.lineW - segmentWidth + paintAdvance
    this.pendingBreakKind = kind
  }

  private appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIdx: number): InternalLayoutLine | null {
    const gWidths = this.breakableWidths[segmentIndex]!
    const gPrefixWidths = this.breakablePrefixWidths[segmentIndex] ?? null
    const effectiveMaxWidth = this.effectiveMaxWidth
    const preferPrefixWidths = this.preferPrefixWidths

    for (let g = startGraphemeIdx; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)

      if (!this.hasContent) {
        this.startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (this.lineW + gw > effectiveMaxWidth) {
        return this.finishLine()
      }

      this.lineW += gw
      this.lineEndSegmentIndex = segmentIndex
      this.lineEndGraphemeIndex = g + 1
    }

    if (this.hasContent && this.lineEndSegmentIndex === segmentIndex && this.lineEndGraphemeIndex === gWidths.length) {
      this.lineEndSegmentIndex = segmentIndex + 1
      this.lineEndGraphemeIndex = 0
    }
    return null
  }

  private maybeFinishAtSoftHyphen(segmentIndex: number): InternalLayoutLine | null {
    if (this.pendingBreakKind !== 'soft-hyphen' || this.pendingBreakSegmentIndex < 0) return null

    const gWidths = this.breakableWidths[segmentIndex] ?? null
    if (gWidths !== null) {
      const fitWidths = this.preferPrefixWidths
        ? this.breakablePrefixWidths[segmentIndex] ?? gWidths
        : gWidths
      const usesPrefixWidths = fitWidths !== gWidths
      const { fitCount, fittedWidth } = fitSoftHyphenBreak(
        fitWidths,
        this.lineW,
        this.effectiveMaxWidth,
        this.discretionaryHyphenWidth,
        usesPrefixWidths,
      )

      if (fitCount === gWidths.length) {
        this.lineW = fittedWidth
        this.lineEndSegmentIndex = segmentIndex + 1
        this.lineEndGraphemeIndex = 0
        this.clearPendingBreak()
        return null
      }

      if (fitCount > 0) {
        return this.finishLine(
          segmentIndex,
          fitCount,
          fittedWidth + this.discretionaryHyphenWidth,
        )
      }
    }

    if (this.pendingBreakFitWidth <= this.maxWidth + this.lineFitEpsilon) {
      return this.finishLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
    }

    return null
  }
}

const fullLineRangeStepper = new FullLineRangeStepper()

export function layoutNextLineRange(
  prepared: PreparedLineBreakData,
  start: LineBreakCursor,
  maxWidth: number,
): InternalLayoutLine | null {
  const normalizedStart = normalizeLineStart(prepared, start)
  if (normalizedStart === null) return null

  if (prepared.simpleLineWalkFastPath) {
    return layoutNextLineRangeSimple(prepared, normalizedStart, maxWidth)
  }
  return fullLineRangeStepper.run(prepared, normalizedStart, maxWidth)
}

class SimpleLineRangeStepper {
  // Per-run state
  private lineW = 0
  private hasContent = false
  private lineStartSegmentIndex = 0
  private lineStartGraphemeIndex = 0
  private lineEndSegmentIndex = 0
  private lineEndGraphemeIndex = 0
  private pendingBreakSegmentIndex = -1
  private pendingBreakPaintWidth = 0

  // Bound once per run
  private widths!: number[]
  private kinds!: SegmentBreakKind[]
  private breakableWidths!: (number[] | null)[]
  private breakablePrefixWidths!: (number[] | null)[]
  private maxWidth = 0
  private lineFitEpsilon = 0
  private effectiveMaxWidth = 0
  private preferPrefixWidths = false

  run(
    prepared: PreparedLineBreakData,
    normalizedStart: LineBreakCursor,
    maxWidth: number,
  ): InternalLayoutLine | null {
    const { widths, kinds, breakableWidths, breakablePrefixWidths } = prepared
    const engineProfile = getEngineProfile()

    this.widths = widths
    this.kinds = kinds
    this.breakableWidths = breakableWidths
    this.breakablePrefixWidths = breakablePrefixWidths
    this.maxWidth = maxWidth
    this.lineFitEpsilon = engineProfile.lineFitEpsilon
    this.effectiveMaxWidth = maxWidth + engineProfile.lineFitEpsilon
    this.preferPrefixWidths = engineProfile.preferPrefixWidthsForBreakableRuns
    this.lineW = 0
    this.hasContent = false
    this.lineStartSegmentIndex = normalizedStart.segmentIndex
    this.lineStartGraphemeIndex = normalizedStart.graphemeIndex
    this.lineEndSegmentIndex = normalizedStart.segmentIndex
    this.lineEndGraphemeIndex = normalizedStart.graphemeIndex
    this.pendingBreakSegmentIndex = -1
    this.pendingBreakPaintWidth = 0

    const effectiveMaxWidth = this.effectiveMaxWidth

    for (let i = normalizedStart.segmentIndex; i < widths.length; i++) {
      const w = widths[i]!
      const kind = kinds[i]!
      const startGraphemeIndex = i === normalizedStart.segmentIndex ? normalizedStart.graphemeIndex : 0

      if (!this.hasContent) {
        if (startGraphemeIndex > 0) {
          const line = this.appendBreakableSegmentFrom(i, startGraphemeIndex)
          if (line !== null) return line
        } else if (w > maxWidth && breakableWidths[i] !== null) {
          const line = this.appendBreakableSegmentFrom(i, 0)
          if (line !== null) return line
        } else {
          this.startLineAtSegment(i, w)
        }
        this.updatePendingBreak(i, w)
        continue
      }

      const newW = this.lineW + w
      if (newW > effectiveMaxWidth) {
        if (canBreakAfter(kind)) {
          this.appendWholeSegment(i, w)
          return this.finishLine(i + 1, 0, this.lineW - w)
        }

        if (this.pendingBreakSegmentIndex >= 0) {
          return this.finishLine(this.pendingBreakSegmentIndex, 0, this.pendingBreakPaintWidth)
        }

        if (w > maxWidth && breakableWidths[i] !== null) {
          const currentLine = this.finishLine()
          if (currentLine !== null) return currentLine
          const line = this.appendBreakableSegmentFrom(i, 0)
          if (line !== null) return line
        }

        return this.finishLine()
      }

      this.appendWholeSegment(i, w)
      this.updatePendingBreak(i, w)
    }

    return this.finishLine()
  }

  private finishLine(
    endSegmentIndex = this.lineEndSegmentIndex,
    endGraphemeIndex = this.lineEndGraphemeIndex,
    width = this.lineW,
  ): InternalLayoutLine | null {
    if (!this.hasContent) return null
    return {
      startSegmentIndex: this.lineStartSegmentIndex,
      startGraphemeIndex: this.lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    }
  }

  private startLineAtSegment(segmentIndex: number, width: number): void {
    this.hasContent = true
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
    this.lineW = width
  }

  private startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    this.hasContent = true
    this.lineEndSegmentIndex = segmentIndex
    this.lineEndGraphemeIndex = graphemeIndex + 1
    this.lineW = width
  }

  private appendWholeSegment(segmentIndex: number, width: number): void {
    if (!this.hasContent) {
      this.startLineAtSegment(segmentIndex, width)
      return
    }
    this.lineW += width
    this.lineEndSegmentIndex = segmentIndex + 1
    this.lineEndGraphemeIndex = 0
  }

  private updatePendingBreak(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(this.kinds[segmentIndex]!)) return
    this.pendingBreakSegmentIndex = segmentIndex + 1
    this.pendingBreakPaintWidth = this.lineW - segmentWidth
  }

  private appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIdx: number): InternalLayoutLine | null {
    const gWidths = this.breakableWidths[segmentIndex]!
    const gPrefixWidths = this.breakablePrefixWidths[segmentIndex] ?? null
    const effectiveMaxWidth = this.effectiveMaxWidth
    const preferPrefixWidths = this.preferPrefixWidths

    for (let g = startGraphemeIdx; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)

      if (!this.hasContent) {
        this.startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (this.lineW + gw > effectiveMaxWidth) {
        return this.finishLine()
      }

      this.lineW += gw
      this.lineEndSegmentIndex = segmentIndex
      this.lineEndGraphemeIndex = g + 1
    }

    if (this.hasContent && this.lineEndSegmentIndex === segmentIndex && this.lineEndGraphemeIndex === gWidths.length) {
      this.lineEndSegmentIndex = segmentIndex + 1
      this.lineEndGraphemeIndex = 0
    }
    return null
  }
}

const simpleLineRangeStepper = new SimpleLineRangeStepper()

function layoutNextLineRangeSimple(
  prepared: PreparedLineBreakData,
  normalizedStart: LineBreakCursor,
  maxWidth: number,
): InternalLayoutLine | null {
  return simpleLineRangeStepper.run(prepared, normalizedStart, maxWidth)
}
