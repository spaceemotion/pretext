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
  return (
    kind === 'space' ||
    kind === 'preserved-space' ||
    kind === 'tab' ||
    kind === 'zero-width-break' ||
    kind === 'soft-hyphen'
  )
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
  maxWidth: number,
  lineFitEpsilon: number,
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
    if (nextLineWidth > maxWidth + lineFitEpsilon) break
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
    this.preferPrefixWidths = engineProfile.preferPrefixWidthsForBreakableRuns
    this.lineCount = 0
    this.lineW = 0
    this.hasContent = false

    // Cache this.* in locals for the tight inner loop
    let lineW = 0
    let lineCount = 0
    let hasContent = false
    const lineFitEpsilon = this.lineFitEpsilon

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
      if (newW > maxWidth + lineFitEpsilon) {
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
      const lineFitEpsilon = this.lineFitEpsilon
      const preferPrefixWidths = this.preferPrefixWidths
      let lineW = 0
      let lineCount = this.lineCount
      for (let g = 0; g < gWidths.length; g++) {
        const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)
        if (lineW > 0 && lineW + gw > maxWidth + lineFitEpsilon) {
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

    const lineFitEpsilon = this.lineFitEpsilon

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
      if (newW > maxWidth + lineFitEpsilon) {
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
    const maxWidth = this.maxWidth
    const lineFitEpsilon = this.lineFitEpsilon
    const preferPrefixWidths = this.preferPrefixWidths

    for (let g = startGraphemeIdx; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(gWidths, gPrefixWidths, g, preferPrefixWidths)

      if (!this.hasContent) {
        this.startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (this.lineW + gw > maxWidth + lineFitEpsilon) {
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

export function walkPreparedLines(
  prepared: PreparedLineBreakData,
  maxWidth: number,
  onLine?: (line: InternalLayoutLine) => void,
): number {
  if (prepared.simpleLineWalkFastPath) {
    return walkPreparedLinesSimple(prepared, maxWidth, onLine)
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
    chunks,
  } = prepared
  if (widths.length === 0 || chunks.length === 0) return 0

  const engineProfile = getEngineProfile()
  const lineFitEpsilon = engineProfile.lineFitEpsilon

  let lineCount = 0
  let lineW = 0
  let hasContent = false
  let lineStartSegmentIndex = 0
  let lineStartGraphemeIndex = 0
  let lineEndSegmentIndex = 0
  let lineEndGraphemeIndex = 0
  let pendingBreakSegmentIndex = -1
  let pendingBreakFitWidth = 0
  let pendingBreakPaintWidth = 0
  let pendingBreakKind: SegmentBreakKind | null = null

  function clearPendingBreak(): void {
    pendingBreakSegmentIndex = -1
    pendingBreakFitWidth = 0
    pendingBreakPaintWidth = 0
    pendingBreakKind = null
  }

  function emitCurrentLine(
    endSegmentIndex = lineEndSegmentIndex,
    endGraphemeIndex = lineEndGraphemeIndex,
    width = lineW,
  ): void {
    lineCount++
    onLine?.({
      startSegmentIndex: lineStartSegmentIndex,
      startGraphemeIndex: lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    })
    lineW = 0
    hasContent = false
    clearPendingBreak()
  }

  function startLineAtSegment(segmentIndex: number, width: number): void {
    hasContent = true
    lineStartSegmentIndex = segmentIndex
    lineStartGraphemeIndex = 0
    lineEndSegmentIndex = segmentIndex + 1
    lineEndGraphemeIndex = 0
    lineW = width
  }

  function startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    hasContent = true
    lineStartSegmentIndex = segmentIndex
    lineStartGraphemeIndex = graphemeIndex
    lineEndSegmentIndex = segmentIndex
    lineEndGraphemeIndex = graphemeIndex + 1
    lineW = width
  }

  function appendWholeSegment(segmentIndex: number, width: number): void {
    if (!hasContent) {
      startLineAtSegment(segmentIndex, width)
      return
    }
    lineW += width
    lineEndSegmentIndex = segmentIndex + 1
    lineEndGraphemeIndex = 0
  }

  function updatePendingBreakForWholeSegment(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(kinds[segmentIndex]!)) return
    const fitAdvance = kinds[segmentIndex] === 'tab' ? 0 : lineEndFitAdvances[segmentIndex]!
    const paintAdvance = kinds[segmentIndex] === 'tab' ? segmentWidth : lineEndPaintAdvances[segmentIndex]!
    pendingBreakSegmentIndex = segmentIndex + 1
    pendingBreakFitWidth = lineW - segmentWidth + fitAdvance
    pendingBreakPaintWidth = lineW - segmentWidth + paintAdvance
    pendingBreakKind = kinds[segmentIndex]!
  }

  function appendBreakableSegment(segmentIndex: number): void {
    appendBreakableSegmentFrom(segmentIndex, 0)
  }

  function appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIndex: number): void {
    const gWidths = breakableWidths[segmentIndex]!
    const gPrefixWidths = breakablePrefixWidths[segmentIndex] ?? null
    for (let g = startGraphemeIndex; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(
        gWidths,
        gPrefixWidths,
        g,
        engineProfile.preferPrefixWidthsForBreakableRuns,
      )

      if (!hasContent) {
        startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (lineW + gw > maxWidth + lineFitEpsilon) {
        emitCurrentLine()
        startLineAtGrapheme(segmentIndex, g, gw)
      } else {
        lineW += gw
        lineEndSegmentIndex = segmentIndex
        lineEndGraphemeIndex = g + 1
      }
    }

    if (hasContent && lineEndSegmentIndex === segmentIndex && lineEndGraphemeIndex === gWidths.length) {
      lineEndSegmentIndex = segmentIndex + 1
      lineEndGraphemeIndex = 0
    }
  }

  function continueSoftHyphenBreakableSegment(segmentIndex: number): boolean {
    if (pendingBreakKind !== 'soft-hyphen') return false
    const gWidths = breakableWidths[segmentIndex]!
    if (gWidths === null) return false
    const fitWidths = engineProfile.preferPrefixWidthsForBreakableRuns
      ? breakablePrefixWidths[segmentIndex] ?? gWidths
      : gWidths
    const usesPrefixWidths = fitWidths !== gWidths
    const { fitCount, fittedWidth } = fitSoftHyphenBreak(
      fitWidths,
      lineW,
      maxWidth,
      lineFitEpsilon,
      discretionaryHyphenWidth,
      usesPrefixWidths,
    )
    if (fitCount === 0) return false

    lineW = fittedWidth
    lineEndSegmentIndex = segmentIndex
    lineEndGraphemeIndex = fitCount
    clearPendingBreak()

    if (fitCount === gWidths.length) {
      lineEndSegmentIndex = segmentIndex + 1
      lineEndGraphemeIndex = 0
      return true
    }

    emitCurrentLine(
      segmentIndex,
      fitCount,
      fittedWidth + discretionaryHyphenWidth,
    )
    appendBreakableSegmentFrom(segmentIndex, fitCount)
    return true
  }

  function emitEmptyChunk(chunk: { startSegmentIndex: number, consumedEndSegmentIndex: number }): void {
    lineCount++
    onLine?.({
      startSegmentIndex: chunk.startSegmentIndex,
      startGraphemeIndex: 0,
      endSegmentIndex: chunk.consumedEndSegmentIndex,
      endGraphemeIndex: 0,
      width: 0,
    })
    clearPendingBreak()
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]!
    if (chunk.startSegmentIndex === chunk.endSegmentIndex) {
      emitEmptyChunk(chunk)
      continue
    }

    hasContent = false
    lineW = 0
    lineStartSegmentIndex = chunk.startSegmentIndex
    lineStartGraphemeIndex = 0
    lineEndSegmentIndex = chunk.startSegmentIndex
    lineEndGraphemeIndex = 0
    clearPendingBreak()

    let i = chunk.startSegmentIndex
    while (i < chunk.endSegmentIndex) {
      const kind = kinds[i]!
      const w = kind === 'tab' ? getTabAdvance(lineW, tabStopAdvance) : widths[i]!

      if (kind === 'soft-hyphen') {
        if (hasContent) {
          lineEndSegmentIndex = i + 1
          lineEndGraphemeIndex = 0
          pendingBreakSegmentIndex = i + 1
          pendingBreakFitWidth = lineW + discretionaryHyphenWidth
          pendingBreakPaintWidth = lineW + discretionaryHyphenWidth
          pendingBreakKind = kind
        }
        i++
        continue
      }

      if (!hasContent) {
        if (w > maxWidth && breakableWidths[i] !== null) {
          appendBreakableSegment(i)
        } else {
          startLineAtSegment(i, w)
        }
        updatePendingBreakForWholeSegment(i, w)
        i++
        continue
      }

      const newW = lineW + w
      if (newW > maxWidth + lineFitEpsilon) {
        const currentBreakFitWidth = lineW + (kind === 'tab' ? 0 : lineEndFitAdvances[i]!)
        const currentBreakPaintWidth = lineW + (kind === 'tab' ? w : lineEndPaintAdvances[i]!)

        if (
          pendingBreakKind === 'soft-hyphen' &&
          engineProfile.preferEarlySoftHyphenBreak &&
          pendingBreakFitWidth <= maxWidth + lineFitEpsilon
        ) {
          emitCurrentLine(pendingBreakSegmentIndex, 0, pendingBreakPaintWidth)
          continue
        }

        if (pendingBreakKind === 'soft-hyphen' && continueSoftHyphenBreakableSegment(i)) {
          i++
          continue
        }

        if (canBreakAfter(kind) && currentBreakFitWidth <= maxWidth + lineFitEpsilon) {
          appendWholeSegment(i, w)
          emitCurrentLine(i + 1, 0, currentBreakPaintWidth)
          i++
          continue
        }

        if (pendingBreakSegmentIndex >= 0 && pendingBreakFitWidth <= maxWidth + lineFitEpsilon) {
          emitCurrentLine(pendingBreakSegmentIndex, 0, pendingBreakPaintWidth)
          continue
        }

        if (w > maxWidth && breakableWidths[i] !== null) {
          emitCurrentLine()
          appendBreakableSegment(i)
          i++
          continue
        }

        emitCurrentLine()
        continue
      }

      appendWholeSegment(i, w)
      updatePendingBreakForWholeSegment(i, w)
      i++
    }

    if (hasContent) {
      const finalPaintWidth =
        pendingBreakSegmentIndex === chunk.consumedEndSegmentIndex
          ? pendingBreakPaintWidth
          : lineW
      emitCurrentLine(chunk.consumedEndSegmentIndex, 0, finalPaintWidth)
    }
  }

  return lineCount
}

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
  const lineFitEpsilon = engineProfile.lineFitEpsilon

  let lineW = 0
  let hasContent = false
  const lineStartSegmentIndex = normalizedStart.segmentIndex
  const lineStartGraphemeIndex = normalizedStart.graphemeIndex
  let lineEndSegmentIndex = lineStartSegmentIndex
  let lineEndGraphemeIndex = lineStartGraphemeIndex
  let pendingBreakSegmentIndex = -1
  let pendingBreakFitWidth = 0
  let pendingBreakPaintWidth = 0
  let pendingBreakKind: SegmentBreakKind | null = null

  function clearPendingBreak(): void {
    pendingBreakSegmentIndex = -1
    pendingBreakFitWidth = 0
    pendingBreakPaintWidth = 0
    pendingBreakKind = null
  }

  function finishLine(
    endSegmentIndex = lineEndSegmentIndex,
    endGraphemeIndex = lineEndGraphemeIndex,
    width = lineW,
  ): InternalLayoutLine | null {
    if (!hasContent) return null

    return {
      startSegmentIndex: lineStartSegmentIndex,
      startGraphemeIndex: lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    }
  }

  function startLineAtSegment(segmentIndex: number, width: number): void {
    hasContent = true
    lineEndSegmentIndex = segmentIndex + 1
    lineEndGraphemeIndex = 0
    lineW = width
  }

  function startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    hasContent = true
    lineEndSegmentIndex = segmentIndex
    lineEndGraphemeIndex = graphemeIndex + 1
    lineW = width
  }

  function appendWholeSegment(segmentIndex: number, width: number): void {
    if (!hasContent) {
      startLineAtSegment(segmentIndex, width)
      return
    }
    lineW += width
    lineEndSegmentIndex = segmentIndex + 1
    lineEndGraphemeIndex = 0
  }

  function updatePendingBreakForWholeSegment(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(kinds[segmentIndex]!)) return
    const fitAdvance = kinds[segmentIndex] === 'tab' ? 0 : lineEndFitAdvances[segmentIndex]!
    const paintAdvance = kinds[segmentIndex] === 'tab' ? segmentWidth : lineEndPaintAdvances[segmentIndex]!
    pendingBreakSegmentIndex = segmentIndex + 1
    pendingBreakFitWidth = lineW - segmentWidth + fitAdvance
    pendingBreakPaintWidth = lineW - segmentWidth + paintAdvance
    pendingBreakKind = kinds[segmentIndex]!
  }

  function appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIndex: number): InternalLayoutLine | null {
    const gWidths = breakableWidths[segmentIndex]!
    const gPrefixWidths = breakablePrefixWidths[segmentIndex] ?? null
    for (let g = startGraphemeIndex; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(
        gWidths,
        gPrefixWidths,
        g,
        engineProfile.preferPrefixWidthsForBreakableRuns,
      )

      if (!hasContent) {
        startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (lineW + gw > maxWidth + lineFitEpsilon) {
        return finishLine()
      }

      lineW += gw
      lineEndSegmentIndex = segmentIndex
      lineEndGraphemeIndex = g + 1
    }

    if (hasContent && lineEndSegmentIndex === segmentIndex && lineEndGraphemeIndex === gWidths.length) {
      lineEndSegmentIndex = segmentIndex + 1
      lineEndGraphemeIndex = 0
    }
    return null
  }

  function maybeFinishAtSoftHyphen(segmentIndex: number): InternalLayoutLine | null {
    if (pendingBreakKind !== 'soft-hyphen' || pendingBreakSegmentIndex < 0) return null

    const gWidths = breakableWidths[segmentIndex] ?? null
    if (gWidths !== null) {
      const fitWidths = engineProfile.preferPrefixWidthsForBreakableRuns
        ? breakablePrefixWidths[segmentIndex] ?? gWidths
        : gWidths
      const usesPrefixWidths = fitWidths !== gWidths
      const { fitCount, fittedWidth } = fitSoftHyphenBreak(
        fitWidths,
        lineW,
        maxWidth,
        lineFitEpsilon,
        discretionaryHyphenWidth,
        usesPrefixWidths,
      )

      if (fitCount === gWidths.length) {
        lineW = fittedWidth
        lineEndSegmentIndex = segmentIndex + 1
        lineEndGraphemeIndex = 0
        clearPendingBreak()
        return null
      }

      if (fitCount > 0) {
        return finishLine(
          segmentIndex,
          fitCount,
          fittedWidth + discretionaryHyphenWidth,
        )
      }
    }

    if (pendingBreakFitWidth <= maxWidth + lineFitEpsilon) {
      return finishLine(pendingBreakSegmentIndex, 0, pendingBreakPaintWidth)
    }

    return null
  }

  for (let i = normalizedStart.segmentIndex; i < chunk.endSegmentIndex; i++) {
    const kind = kinds[i]!
    const startGraphemeIndex = i === normalizedStart.segmentIndex ? normalizedStart.graphemeIndex : 0
    const w = kind === 'tab' ? getTabAdvance(lineW, tabStopAdvance) : widths[i]!

    if (kind === 'soft-hyphen' && startGraphemeIndex === 0) {
      if (hasContent) {
        lineEndSegmentIndex = i + 1
        lineEndGraphemeIndex = 0
        pendingBreakSegmentIndex = i + 1
        pendingBreakFitWidth = lineW + discretionaryHyphenWidth
        pendingBreakPaintWidth = lineW + discretionaryHyphenWidth
        pendingBreakKind = kind
      }
      continue
    }

    if (!hasContent) {
      if (startGraphemeIndex > 0) {
        const line = appendBreakableSegmentFrom(i, startGraphemeIndex)
        if (line !== null) return line
      } else if (w > maxWidth && breakableWidths[i] !== null) {
        const line = appendBreakableSegmentFrom(i, 0)
        if (line !== null) return line
      } else {
        startLineAtSegment(i, w)
      }
      updatePendingBreakForWholeSegment(i, w)
      continue
    }

    const newW = lineW + w
    if (newW > maxWidth + lineFitEpsilon) {
      const currentBreakFitWidth = lineW + (kind === 'tab' ? 0 : lineEndFitAdvances[i]!)
      const currentBreakPaintWidth = lineW + (kind === 'tab' ? w : lineEndPaintAdvances[i]!)

      if (
        pendingBreakKind === 'soft-hyphen' &&
        engineProfile.preferEarlySoftHyphenBreak &&
        pendingBreakFitWidth <= maxWidth + lineFitEpsilon
      ) {
        return finishLine(pendingBreakSegmentIndex, 0, pendingBreakPaintWidth)
      }

      const softBreakLine = maybeFinishAtSoftHyphen(i)
      if (softBreakLine !== null) return softBreakLine

      if (canBreakAfter(kind) && currentBreakFitWidth <= maxWidth + lineFitEpsilon) {
        appendWholeSegment(i, w)
        return finishLine(i + 1, 0, currentBreakPaintWidth)
      }

      if (pendingBreakSegmentIndex >= 0 && pendingBreakFitWidth <= maxWidth + lineFitEpsilon) {
        return finishLine(pendingBreakSegmentIndex, 0, pendingBreakPaintWidth)
      }

      if (w > maxWidth && breakableWidths[i] !== null) {
        const currentLine = finishLine()
        if (currentLine !== null) return currentLine
        const line = appendBreakableSegmentFrom(i, 0)
        if (line !== null) return line
      }

      return finishLine()
    }

    appendWholeSegment(i, w)
    updatePendingBreakForWholeSegment(i, w)
  }

  if (pendingBreakSegmentIndex === chunk.consumedEndSegmentIndex && lineEndGraphemeIndex === 0) {
    return finishLine(chunk.consumedEndSegmentIndex, 0, pendingBreakPaintWidth)
  }

  return finishLine(chunk.consumedEndSegmentIndex, 0, lineW)
}

function layoutNextLineRangeSimple(
  prepared: PreparedLineBreakData,
  normalizedStart: LineBreakCursor,
  maxWidth: number,
): InternalLayoutLine | null {
  const { widths, kinds, breakableWidths, breakablePrefixWidths } = prepared
  const engineProfile = getEngineProfile()
  const lineFitEpsilon = engineProfile.lineFitEpsilon

  let lineW = 0
  let hasContent = false
  const lineStartSegmentIndex = normalizedStart.segmentIndex
  const lineStartGraphemeIndex = normalizedStart.graphemeIndex
  let lineEndSegmentIndex = lineStartSegmentIndex
  let lineEndGraphemeIndex = lineStartGraphemeIndex
  let pendingBreakSegmentIndex = -1
  let pendingBreakPaintWidth = 0

  function finishLine(
    endSegmentIndex = lineEndSegmentIndex,
    endGraphemeIndex = lineEndGraphemeIndex,
    width = lineW,
  ): InternalLayoutLine | null {
    if (!hasContent) return null

    return {
      startSegmentIndex: lineStartSegmentIndex,
      startGraphemeIndex: lineStartGraphemeIndex,
      endSegmentIndex,
      endGraphemeIndex,
      width,
    }
  }

  function startLineAtSegment(segmentIndex: number, width: number): void {
    hasContent = true
    lineEndSegmentIndex = segmentIndex + 1
    lineEndGraphemeIndex = 0
    lineW = width
  }

  function startLineAtGrapheme(segmentIndex: number, graphemeIndex: number, width: number): void {
    hasContent = true
    lineEndSegmentIndex = segmentIndex
    lineEndGraphemeIndex = graphemeIndex + 1
    lineW = width
  }

  function appendWholeSegment(segmentIndex: number, width: number): void {
    if (!hasContent) {
      startLineAtSegment(segmentIndex, width)
      return
    }
    lineW += width
    lineEndSegmentIndex = segmentIndex + 1
    lineEndGraphemeIndex = 0
  }

  function updatePendingBreak(segmentIndex: number, segmentWidth: number): void {
    if (!canBreakAfter(kinds[segmentIndex]!)) return
    pendingBreakSegmentIndex = segmentIndex + 1
    pendingBreakPaintWidth = lineW - segmentWidth
  }

  function appendBreakableSegmentFrom(segmentIndex: number, startGraphemeIndex: number): InternalLayoutLine | null {
    const gWidths = breakableWidths[segmentIndex]!
    const gPrefixWidths = breakablePrefixWidths[segmentIndex] ?? null
    for (let g = startGraphemeIndex; g < gWidths.length; g++) {
      const gw = getBreakableAdvance(
        gWidths,
        gPrefixWidths,
        g,
        engineProfile.preferPrefixWidthsForBreakableRuns,
      )

      if (!hasContent) {
        startLineAtGrapheme(segmentIndex, g, gw)
        continue
      }

      if (lineW + gw > maxWidth + lineFitEpsilon) {
        return finishLine()
      }

      lineW += gw
      lineEndSegmentIndex = segmentIndex
      lineEndGraphemeIndex = g + 1
    }

    if (hasContent && lineEndSegmentIndex === segmentIndex && lineEndGraphemeIndex === gWidths.length) {
      lineEndSegmentIndex = segmentIndex + 1
      lineEndGraphemeIndex = 0
    }
    return null
  }

  for (let i = normalizedStart.segmentIndex; i < widths.length; i++) {
    const w = widths[i]!
    const kind = kinds[i]!
    const startGraphemeIndex = i === normalizedStart.segmentIndex ? normalizedStart.graphemeIndex : 0

    if (!hasContent) {
      if (startGraphemeIndex > 0) {
        const line = appendBreakableSegmentFrom(i, startGraphemeIndex)
        if (line !== null) return line
      } else if (w > maxWidth && breakableWidths[i] !== null) {
        const line = appendBreakableSegmentFrom(i, 0)
        if (line !== null) return line
      } else {
        startLineAtSegment(i, w)
      }
      updatePendingBreak(i, w)
      continue
    }

    const newW = lineW + w
    if (newW > maxWidth + lineFitEpsilon) {
      if (canBreakAfter(kind)) {
        appendWholeSegment(i, w)
        return finishLine(i + 1, 0, lineW - w)
      }

      if (pendingBreakSegmentIndex >= 0) {
        return finishLine(pendingBreakSegmentIndex, 0, pendingBreakPaintWidth)
      }

      if (w > maxWidth && breakableWidths[i] !== null) {
        const currentLine = finishLine()
        if (currentLine !== null) return currentLine
        const line = appendBreakableSegmentFrom(i, 0)
        if (line !== null) return line
      }

      return finishLine()
    }

    appendWholeSegment(i, w)
    updatePendingBreak(i, w)
  }

  return finishLine()
}
