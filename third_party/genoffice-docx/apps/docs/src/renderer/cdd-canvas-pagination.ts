// Adapted from GenOffice apps/docs/src/renderer/App.tsx (header/footer heights 3296–3470, note metrics 3150–3260,
// footnote areas 612–760 and 3469–3540, canvas pagination effect 3688–5060, gap-strip editing 6141–6200 at commit
// 8ab58a5), Copyright 2026 Mainfunc, Inc., Apache-2.0 — see ../../../../LICENSE. Reduced by coredotdocs
// (설계 문서 04 §12 D3, 02 §18.5·§18.7): measure the flow → slice it into pages per section with the engine → draw a page
// gap before each page-leading block (or inside the paragraph/table that crosses the boundary), carrying the previous
// page's footnotes and footer and the next page's header; the first page's header and the last page's footer/footnotes
// sit at the canvas edges. Keep rules (keepNext/keepLines/widow, table row flags, footnote space) come from the parsed
// blocks; multi-column sections are painted per block into their column slot (the original's "mixed" mode, used for
// every columned document); split rows, page-relative floats and oversize lines get the engine's patches.
// Dropped from the original: the fast path and resume logic, TOC page numbers, mirrored margins, vertical text,
// vAlign, per-section width/grid specs, floating header images, the page-color phantom paragraph, endnote slicing
// (endnotes are listed after the body).
import type { Editor } from '@tiptap/core'
import type { Block, HeaderFooter, HfImage, NoteInfo, ParsedDoc, SectionInfo, SectionSettings } from '@genoffice/docx-engine'
import { hfVariantsFromParsed, type HfView } from './doc-state'
import { setColumnLayout } from './editor/column-layout'
import { setDkColor } from './editor/dark-page'
import { hfHasVisibleContent, hfReservedHeightPx, hfStripGeom, makeGapHfEl } from './editor/hf-dom'
import { mountHfEditor, type HfEditorHandle } from './editor/hf-editor'
import { GAP_BAND, LayoutBatch, setFloatVShifts, setOversizeClips, setPageGaps, setRowFills, type PageGapSpec } from './editor/pagination-gaps'
import { imageParaPaginationMeta, paraPaginationMeta, tableWidowOff } from './editor/para-flags'
import { textColorValue } from './editor/text-color'
import { textOutlineCssValue } from './editor/text-outline'
import { hfSaveOptions, resolveHf, withHfEdit, type HfSaveOptions, type HfSectionState } from './hf-sections'
import { cssFontFamily, estimateFootnoteHeight, FOOTNOTE_SEPARATOR_H, footnoteLineHeightPx, hfHeaderGeom, noteLineHeightPx, noteRunStyle, resolveNoteStyle } from './line-metrics'
import { noteMarkText, type NoteKind } from './note-format'
import { formatPageNumber, hfVariantOf, pageNumbers } from './pagination-hf'
import { BlockIndex } from './pagination-index'
import { createLineRectsCache, lineStartAnchor, nextLineAnchor, sliceWithLineSplit, type LineAnchor } from './pagination-lines'
import { measureBlocks, tableRowFlags } from './pagination-measure'
import {
  assignSections,
  canvasContentTopPx,
  columnLayoutSpecs,
  effectiveBottomPx,
  effectiveTopPx,
  liveSections,
  newWidthPassState,
  pageLeftPx,
  paperWidthPx,
  sectionColumns,
  sectionGeoms,
  sectionPageBox,
  sectionWidthSpecs,
  widthPassGate,
  type WidthPassState,
} from './pagination-sections'
import { pageAt, sectionFirstPages, visiblePageCount } from './pagination-slices'
import type { BlockBox, BlockMeta, BlockMetaOf, PageNoteItem, PageSlice, SectionHfHeights, SliceOutputs } from './pagination-types'

const twipsToPx = (twips: number) => (twips / 1440) * 96

export interface CanvasPagination {
  pages: number
  slices: PageSlice[]
  blocks: BlockBox[]
  /** page gaps the pass could not anchor (a boundary inside a nested table, …) */
  unanchored: number
  /** column widths changed this pass (line breaks moved): run one more pass */
  followUp: boolean
  /** Physical sheets for a detached print canvas; all coordinates are unzoomed px. */
  printPages?: Array<{ x: number; y: number; width: number; height: number; header: string; footer: string; notes: string }>
}

/** Document-level geometry and pending header/footer/footnote edits the canvas passes share. */
export interface CanvasGeometry {
  parsed: ParsedDoc
  sections: SectionInfo[]
  first: SectionSettings
  /** header/footer state; `edits` holds strips edited in the canvas (saved through `pendingSaveOptions`) */
  hfState: HfSectionState
  hfHeights: SectionHfHeights[]
  titlePg: boolean
  evenOdd: boolean
  /** body top of the canvas's first page (px), under the first-page header when one pushes it down */
  top: number
  /** CSS variables `.doc-page` / `.page-hf` read */
  vars: Record<string, string>
  metaOf: BlockMetaOf
  /** footnotes as the canvas shows them (edited text replaces the parsed note) */
  footnotes: NoteInfo[]
  notesEdited: boolean
  hasColumns: boolean
  colPass: WidthPassState
  /** a strip editor is open: passes leave the gap widgets alone so it is not detached */
  editingStrip: HfEditorHandle | null
}

/** Header/footer state straight from the parsed parts. */
function hfStateOf(parsed: ParsedDoc, sections: SectionInfo[]): HfSectionState {
  const strip = (text: string | null | undefined, page: boolean | undefined, paras: HeaderFooter['paras'] | null | undefined): HeaderFooter | null =>
    text || page || paras?.length ? { text: text ?? '', pageNumber: page, paras: paras ?? undefined } : null
  return {
    sections,
    edits: {},
    links: {},
    docStrips: {
      header: strip(parsed.headerText, parsed.headerHasPageNumber, parsed.headerParas),
      footer: strip(parsed.footerText, parsed.footerHasPageNumber, parsed.footerParas),
      variants: hfVariantsFromParsed(parsed as never),
    },
    parsed: parsed as never,
  }
}

function hfHeightsOf(state: HfSectionState, secs: SectionInfo[], titlePg: boolean): SectionHfHeights[] {
  const live: HfSectionState = { ...state, sections: secs }
  return secs.map((s, i) => {
    const set = s.settings
    const contentW = twipsToPx(set.pageWidth - set.marginLeft - set.marginRight)
    const reserve = (kind: 'header' | 'footer', variant: HfView) => {
      const r = resolveHf(live, i, kind, variant)
      return hfReservedHeightPx(kind, r.value, contentW, r.images, kind === 'header' ? hfHeaderGeom(set) : undefined)
    }
    const firstOn = secs.length === 1 ? titlePg : s.titlePg
    return {
      headerPx: reserve('header', 'default'),
      footerPx: reserve('footer', 'default'),
      ...(firstOn ? { firstHeaderPx: reserve('header', 'first'), firstFooterPx: reserve('footer', 'first') } : {}),
    }
  })
}

// ── footnotes (App.tsx 612–760, 3150–3260, 3469–3510) ──────────────────────────────────────────────

/** All runs a footnote/endnote reference may live in: paragraph runs plus table cell paragraphs (incl. nested tables). */
function blockNoteScanRuns(b: Block): NonNullable<Block['runs']> {
  const out: NonNullable<Block['runs']> = []
  if (b.runs) out.push(...b.runs)
  const walkTable = (table: NonNullable<Block['table']> | undefined): void => {
    for (const row of table?.rows ?? []) {
      for (const cell of row) {
        for (const p of cell.richParas ?? []) out.push(...p.runs)
        for (const nested of cell.nestedTables ?? []) walkTable(nested)
      }
    }
  }
  if (b.table) walkTable(b.table)
  return out
}

/** Note entry content: superscript number + styled runs (shared by the page areas and the hidden height measurer). */
function appendNoteRuns(row: HTMLElement, it: Omit<PageNoteItem, 'height' | 'id'>, kind: NoteKind): void {
  if (!it.noRefMark) {
    const sup = document.createElement('sup')
    sup.textContent = noteMarkText(kind, it.no)
    row.append(sup)
  }
  if (it.richParas) {
    it.richParas.forEach((para, pi) => {
      if (pi > 0) row.append(document.createElement('br'))
      for (const run of para) {
        const span = document.createElement('span')
        span.textContent = run.text
        if (run.bold) span.style.fontWeight = '600'
        if (run.italic) span.style.fontStyle = 'italic'
        const deco = [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean)
        if (deco.length > 0) span.style.textDecoration = deco.join(' ')
        if (run.color) {
          span.style.color = textColorValue(run.color)
          if (run.color !== 'auto') setDkColor(span, run.color)
        }
        if (run.sizeHalfPoints) span.style.fontSize = `${run.sizeHalfPoints / 2}pt`
        if (run.fontAscii) span.style.fontFamily = cssFontFamily(run.fontAscii)
        if (run.textOutline) span.style.webkitTextStroke = textOutlineCssValue(run.textOutline)
        if (run.caps === 'all') span.style.textTransform = 'uppercase'
        else if (run.caps === 'small') span.style.fontVariantCaps = 'small-caps'
        row.append(span)
      }
    })
  } else {
    const span = document.createElement('span')
    span.textContent = it.text
    row.append(span)
  }
}

let noteMeasureHost: HTMLDivElement | null = null
/** Hidden DOM measurement of one note entry at the renderers' exact styles. */
function measureNoteHeightDom(entry: Pick<PageNoteItem, 'no' | 'text' | 'richParas' | 'noRefMark'>, kind: NoteKind, widthPx: number, lineHeightPx: number, fontSizePt: number, fontFamily?: string): number | null {
  if (typeof document === 'undefined' || !document.body || widthPx <= 0) return null
  if (!noteMeasureHost || !noteMeasureHost.isConnected) {
    noteMeasureHost = document.createElement('div')
    noteMeasureHost.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;text-align:left;text-indent:0;'
    document.body.appendChild(noteMeasureHost)
  }
  noteMeasureHost.style.fontFamily = fontFamily ?? "Calibri, 'DengXian', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  noteMeasureHost.style.width = `${widthPx}px`
  noteMeasureHost.style.fontSize = `${fontSizePt}pt`
  noteMeasureHost.style.lineHeight = `${lineHeightPx}px`
  const row = document.createElement('div')
  appendNoteRuns(row, entry, kind)
  const sup = row.querySelector('sup')
  if (sup) {
    sup.style.fontSize = '0.65em'
    sup.style.marginRight = '4px'
  }
  noteMeasureHost.replaceChildren(row)
  const h = row.getBoundingClientRect().height
  noteMeasureHost.replaceChildren()
  return h > 0 ? h : null
}

/** Footnote area (page-bottom band): absolutely positioned; double-click an entry to edit it. */
function makeNotesEl(items: PageNoteItem[], leftPx: number, widthPx: number, heightPx: number, lineHeightPx: number): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'page-gap-notes'
  wrap.style.left = `${leftPx}px`
  wrap.dataset.paperX = leftPx.toFixed(1)
  wrap.style.width = `${widthPx}px`
  wrap.style.height = `${heightPx}px`
  wrap.style.lineHeight = `${lineHeightPx}px`
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'page-gap-note'
    row.title = '두 번 눌러 각주 고치기'
    row.dataset.noteId = it.id
    row.style.minHeight = `${it.height}px`
    if (it.lineHeightPx) row.style.lineHeight = `${it.lineHeightPx}px`
    if (it.fontSizePt) row.style.fontSize = `${it.fontSizePt}pt`
    if (it.fontFamily) row.style.fontFamily = it.fontFamily
    appendNoteRuns(row, it, 'footnote')
    wrap.appendChild(row)
  }
  return wrap
}

function noteNoOf(parsed: ParsedDoc, kind: NoteKind, id: string, index: number): number {
  return parsed.noteNumbers?.[`${kind}:${id}`] ?? index + 1
}

function makeNoteInfo(parsed: ParsedDoc) {
  const cache = new Map<string, { height: number; lineHeightPx: number; fontSizePt: number; fontFamily?: string }>()
  return (fn: NoteInfo | undefined, no: number, sec: SectionSettings, kind: NoteKind) => {
    const contentW = twipsToPx(sec.pageWidth - sec.marginLeft - sec.marginRight)
    const key = `${kind}|${fn?.id ?? ''}|${no}|${Math.round(contentW)}|${fn?.styleId ?? ''}|${fn?.text ?? ''}`
    let v = cache.get(key)
    if (!v) {
      const style = { ...resolveNoteStyle(parsed as never, fn?.styleId, fn?.spacing), ...noteRunStyle(fn?.richParas) }
      const lineHeightPx = noteLineHeightPx(sec.docGrid, style)
      const fontSizePt = style.sizeHalfPoints ? style.sizeHalfPoints / 2 : 10
      const fontFamily = style.fontFamily ? cssFontFamily(style.fontFamily) : undefined
      const entry = { no, text: fn?.text ?? '', ...(fn?.richParas ? { richParas: fn.richParas } : {}), ...(fn?.noRefMark ? { noRefMark: true as const } : {}) }
      const height = measureNoteHeightDom(entry, kind, contentW, lineHeightPx, fontSizePt, fontFamily) ?? estimateFootnoteHeight(fn?.text ?? '', contentW, sec.docGrid, undefined, style, fn?.richParas)
      v = { height, lineHeightPx, fontSizePt, ...(fontFamily ? { fontFamily } : {}) }
      cache.set(key, v)
    }
    return v
  }
}

// ── keep rules (App.tsx 3407–3466) ────────────────────────────────────────────────────────────

function metaOfModel(parsed: ParsedDoc, sections: SectionInfo[], footnotes: () => NoteInfo[], noteInfo: ReturnType<typeof makeNoteInfo>): BlockMetaOf {
  const byIndex = new Map<number, Block>()
  for (const b of parsed.blocks) if (b.docxIndex !== null && !byIndex.has(b.docxIndex)) byIndex.set(b.docxIndex, b)
  const defaultPara = [...parsed.styles.values()].find((s) => s.type === 'paragraph' && s.isDefault)
  const modern = (parsed.compatibilityMode ?? 0) >= 15
  const styleKeepNext = (id: string) => parsed.styles.get(id)?.display?.keepNext === true
  const styleOf = (id: string | undefined) => (id ? parsed.styles.get(id) : defaultPara)?.display
  /** page-bottom heights reserved for footnote references inside a block, one per reference in run order */
  const footnoteBandsOf = (b: Block): Array<{ heightPx: number }> => {
    const notes = footnotes()
    if (notes.length === 0) return []
    const bands: Array<{ heightPx: number }> = []
    for (const run of blockNoteScanRuns(b)) {
      if (run.noteRef?.kind !== 'footnote') continue
      const sec = sections.find((s) => (b.docxIndex ?? 0) <= s.lastBlockIndex)?.settings ?? sections[sections.length - 1]?.settings
      if (!sec) continue
      const i = notes.findIndex((f) => f.id === run.noteRef!.id)
      bands.push({ heightPx: noteInfo(notes[i], noteNoOf(parsed, 'footnote', run.noteRef.id, Math.max(0, i)), sec, 'footnote').height })
    }
    return bands
  }
  return (docxIndex: number): BlockMeta | undefined => {
    const b = byIndex.get(docxIndex)
    if (!b) return undefined
    const fnBands = footnoteBandsOf(b)
    const fnExtra = fnBands.reduce((s, band) => s + band.heightPx, 0)
    const notes = fnExtra > 0 ? { footnoteExtraPx: fnExtra, footnoteBands: fnBands } : {}
    if (b.type === 'table') {
      const xml = b.originalXml ?? ''
      const flagged = /tblHeader|cantSplit|keepNext|<w:trHeight\b/.test(xml) || [...xml.matchAll(/<w:pStyle w:val="([^"]+)"/g)].some((m) => styleKeepNext(m[1]))
      if (!flagged && !modern && fnExtra === 0) return undefined
      const cellWidowOff = modern && tableWidowOff(xml, defaultPara?.display?.widowControl ?? parsed.docDefaults?.widowControl, (id) => parsed.styles.get(id)?.display?.widowControl)
      return {
        ...(flagged ? { tableRowFlags: tableRowFlags(xml, styleKeepNext) } : {}),
        ...(modern ? { modernTableHeaders: true } : {}),
        ...(cellWidowOff ? { cellWidowOff: true } : {}),
        ...notes,
      }
    }
    const flags = b.format ? paraPaginationMeta(b.format) : imageParaPaginationMeta(b.originalXml, styleOf, parsed.docDefaults)
    if (!flags && fnExtra === 0) return undefined
    return { ...flags, ...notes }
  }
}

export function canvasGeometry(parsed: ParsedDoc, sections: SectionInfo[]): CanvasGeometry | null {
  const first = sections[0]?.settings
  if (!first) return null
  const titlePg = parsed.titlePg ?? false
  const evenOdd = parsed.evenAndOddHeaders ?? false
  const hfState = hfStateOf(parsed, sections)
  const hfHeights = hfHeightsOf(hfState, sections, titlePg)
  const h0 = hfHeights[0] ?? { headerPx: 0, footerPx: 0 }
  const top = canvasContentTopPx(sections, first, h0.firstHeaderPx ?? h0.headerPx)
  const bottom = effectiveBottomPx(first, h0.footerPx)
  const box = sectionPageBox(first)
  const geo: CanvasGeometry = {
    parsed,
    sections,
    first,
    hfState,
    hfHeights,
    titlePg,
    evenOdd,
    top,
    metaOf: () => undefined,
    footnotes: parsed.footnotes,
    notesEdited: false,
    hasColumns: sections.some((s) => sectionColumns(s) > 1),
    colPass: newWidthPassState(),
    editingStrip: null,
    vars: {
      '--page-w': `${box.width}px`,
      '--page-h': `${box.height}px`,
      '--page-pad': `${top}px ${twipsToPx(first.marginRight)}px ${bottom}px ${twipsToPx(first.marginLeft)}px`,
      // crop marks (styles.css .page-wrap::before/::after) read the first page's
      // text boundary from these; without them they fall back to 96px (1 inch)
      ...pageMarginVars(first, top, bottom),
      '--section-content-w': `${box.contentWidth}px`,
      '--header-dist': `${box.headerDist}px`,
      '--footer-dist': `${box.footerDist}px`,
    },
  }
  const noteInfo = makeNoteInfo(parsed)
  geo.metaOf = metaOfModel(parsed, sections, () => geo.footnotes, noteInfo)
  noteInfoOf.set(geo, noteInfo)
  return geo
}
const noteInfoOf = new WeakMap<CanvasGeometry, ReturnType<typeof makeNoteInfo>>()

/** A document edit invalidates the column width history (the gate pins widths only within one layout). */
export function resetColumnPasses(geo: CanvasGeometry): void {
  geo.colPass = newWidthPassState()
}

/** Commit a strip edited in the canvas: it shows on every page that resolves to the same part and is saved with the body. */
export function commitHfEdit(geo: CanvasGeometry, si: number, kind: 'header' | 'footer', variant: HfView, next: HeaderFooter): boolean {
  const pending = withHfEdit(geo.hfState, si, kind, variant, next)
  if (!pending) return false
  geo.hfState = { ...geo.hfState, ...pending }
  geo.hfHeights = hfHeightsOf(geo.hfState, geo.sections, geo.titlePg)
  const h0 = geo.hfHeights[0] ?? { headerPx: 0, footerPx: 0 }
  geo.top = canvasContentTopPx(geo.sections, geo.first, h0.firstHeaderPx ?? h0.headerPx)
  const bottom = effectiveBottomPx(geo.first, h0.footerPx)
  geo.vars = {
    ...geo.vars,
    '--page-pad': `${geo.top}px ${twipsToPx(geo.first.marginRight)}px ${bottom}px ${twipsToPx(geo.first.marginLeft)}px`,
    ...pageMarginVars(geo.first, geo.top, bottom),
  }
  return true
}

/** first page text-boundary offsets for the crop marks (App.tsx docZoomStyle --page-mt/mb/ml/mr) */
function pageMarginVars(first: SectionSettings, top: number, bottom: number): Record<string, string> {
  return {
    '--page-mt': `${top}px`,
    '--page-mb': `${bottom}px`,
    '--page-ml': `${twipsToPx(first.marginLeft)}px`,
    '--page-mr': `${twipsToPx(first.marginRight)}px`,
  }
}

/** Replace one footnote's text (an edit rebuilds the note as plain text, like the original's note dialog). */
export function commitNoteEdit(geo: CanvasGeometry, id: string, text: string): boolean {
  const i = geo.footnotes.findIndex((n) => n.id === id)
  if (i < 0 || geo.footnotes[i].text === text) return false
  const next = [...geo.footnotes]
  const { richParas: _rich, ...rest } = next[i]
  void _rich
  next[i] = { ...rest, text }
  geo.footnotes = next
  geo.notesEdited = true
  return true
}

/** Save options for the strips and notes edited in the canvas (merged into saveDocx's options); null when nothing is pending. */
export function pendingSaveOptions(geo: CanvasGeometry): (HfSaveOptions & { footnotes?: NoteInfo[] }) | null {
  const hf = Object.keys(geo.hfState.edits).length > 0 ? hfSaveOptions(geo.hfState) : null
  if (!hf && !geo.notesEdited) return null
  return { ...(hf ?? {}), ...(geo.notesEdited ? { footnotes: geo.footnotes } : {}) }
}

/**
 * Edit a header/footer strip (gap strip or edge strip) in place with the original's strip editor. Returns false when
 * the element is not an editable strip. `onCommit` receives the edited part; `onExit` runs after the editor closed.
 */
export function startStripEdit(geo: CanvasGeometry, el: HTMLElement, onCommit: (si: number, kind: 'header' | 'footer', variant: HfView, next: HeaderFooter) => void, onExit: () => void): boolean {
  if (geo.editingStrip) return false
  const kind = el.dataset.hfKind as 'header' | 'footer' | undefined
  if (!kind) return false
  const si = Number(el.dataset.hfSection ?? 0)
  const variant = (el.dataset.hfVariant as HfView | undefined) ?? 'default'
  const resolved = resolveHf(geo.hfState, si, kind, variant)
  const saved = Array.from(el.childNodes)
  el.replaceChildren()
  el.classList.add('page-hf-editing')
  let committed = false
  const handle = mountHfEditor(el, {
    value: resolved.value ?? { text: '' },
    pageNo: el.dataset.hfPage ?? '1',
    pageTotal: el.dataset.hfTotal ?? '1',
    spellcheck: false,
    onCommit: (next) => {
      committed = true
      onCommit(si, kind, variant, next)
    },
    onExit: () => {
      el.classList.remove('page-hf-editing')
      if (!committed) el.replaceChildren(...saved)
      if (geo.editingStrip === handle) geo.editingStrip = null
      onExit()
    },
  })
  geo.editingStrip = handle
  return true
}

/** Document position of a measured line-start DOM anchor (posAtDOM: works for lines scrolled off-screen). */
function posFromAnchor(view: Editor['view'], anchor: LineAnchor): number | undefined {
  try {
    const pos =
      anchor.node instanceof Element
        ? anchor.node.parentNode
          ? view.posAtDOM(anchor.node.parentNode, Array.prototype.indexOf.call(anchor.node.parentNode.childNodes, anchor.node))
          : -1
        : view.posAtDOM(anchor.node, anchor.charOffset)
    return pos >= 0 ? pos : undefined
  } catch {
    return undefined
  }
}

function hashStr(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

/**
 * One pagination pass over the live canvas. Call after the content settled (fonts loaded, edits debounced); idempotent —
 * measureBlocks subtracts the gaps a previous pass inserted. `zoomFactor` is the CSS zoom on the `.doc-zoom` wrapper
 * (the caller measures at 1 and restores it, like the original). `edgeHost` (the positioned page wrapper) receives the
 * first page's header and the last page's footer and footnotes. A pass is skipped while a strip editor is open.
 */
export function paginateCanvas(editor: Editor, geo: CanvasGeometry, opts: { zoomFactor?: number; edgeHost?: HTMLElement | null; print?: boolean } = {}): CanvasPagination | null {
  if (geo.editingStrip) return null
  const view = editor.view
  const pm = view.dom as HTMLElement
  const factor = opts.zoomFactor ?? 1
  const parsed = geo.parsed
  const noteInfo = noteInfoOf.get(geo) ?? makeNoteInfo(parsed)
  let blocks: BlockBox[]
  let slices: PageSlice[]
  let secs: SectionInfo[]
  let hfHs: SectionHfHeights[]
  const out: SliceOutputs = { rowFills: [], rowSplits: [], floatVShifts: [], floatFlows: [], floatSplits: [], oversizeClips: [] }
  // columned documents measure as one flow (per-block column translates neutralized), like the original's mixed mode
  pm.classList.add('measuring-natural')
  if (geo.hasColumns) pm.classList.add('measuring-columns')
  try {
    const origin = pm.getBoundingClientRect().top + geo.top * factor
    const measured = measureBlocks(pm, origin, factor)
    blocks = measured.blocks
    secs = geo.sections.length > 1 ? liveSections(geo.sections, blocks, measured.sectBreaks) : geo.sections
    if (secs.length > 1) assignSections(blocks, secs)
    hfHs = secs === geo.sections ? geo.hfHeights : hfHeightsOf(geo.hfState, secs, geo.titlePg)
    const geoms = sectionGeoms(secs, hfHs, geo.evenOdd)
    if (!geo.hasColumns) for (const g of geoms) if (g.cols) g.cols = undefined
    slices = sliceWithLineSplit(blocks, geoms, measured.totalHeight, factor, geo.metaOf, out)
  } finally {
    pm.classList.remove('measuring-natural')
    pm.classList.remove('measuring-columns')
  }
  const pmRect = pm.getBoundingClientRect()
  const nums = pageNumbers(slices, secs)
  const firsts = sectionFirstPages(slices)
  const total = visiblePageCount(slices)
  const secOf = (pageIdx: number) => Math.min(slices[pageIdx]?.section ?? 0, Math.max(0, secs.length - 1))
  const setOf = (pageIdx: number) => secs[secOf(pageIdx)]?.settings ?? geo.first
  const hfOfPage = (idx: number) => {
    const h = hfHs[secOf(idx)] ?? { headerPx: 0, footerPx: 0 }
    return firsts[idx] ? { headerPx: h.firstHeaderPx ?? h.headerPx, footerPx: h.firstFooterPx ?? h.footerPx } : h
  }
  const pageNoText = (idx: number) => formatPageNumber(nums[idx] ?? idx + 1, secs[secOf(idx)]?.pageNumberFmt)
  const variantOf = (idx: number) => {
    const si = secOf(idx)
    const titlePg = secs.length <= 1 ? geo.titlePg : !!secs[si]?.titlePg
    return hfVariantOf(titlePg, firsts[idx] ?? idx === 0, geo.evenOdd, nums[idx] ?? idx + 1)
  }
  /** a page's strip; `always` keeps an empty strip as a double-click target (the canvas edges) */
  const strip = (idx: number, kind: 'header' | 'footer', set: SectionSettings, headerStripTop?: number, always = false) => {
    const si = secOf(idx)
    const variant = variantOf(idx)
    const r = resolveHf({ ...geo.hfState, sections: secs }, si, kind, variant)
    const images = opts.print ? r.images : r.images?.filter((img: HfImage) => !img.floating)
    const visible = hfHasVisibleContent(r.value, images)
    if (!visible && !always) return null
    const box = sectionPageBox(set)
    const value = r.value ?? { text: '' }
    const el = makeGapHfEl({
      kind,
      value,
      images,
      pageNo: pageNoText(idx),
      pageTotal: total,
      geom: { ...hfStripGeom(set), ...(headerStripTop !== undefined ? { headerStripTop } : {}) },
    })
    el.style.width = `${box.contentWidth}px`
    el.style.setProperty('--hf-ml', `${twipsToPx(set.marginLeft)}px`)
    el.title = kind === 'header' ? '두 번 눌러 머리말 고치기' : '두 번 눌러 꼬리말 고치기'
    if (!visible) el.classList.add('cdd-hf-empty')
    Object.assign(el.dataset, { hfKind: kind, hfSection: String(si), hfVariant: variant, hfPageIdx: String(idx), hfPage: pageNoText(idx), hfTotal: String(total) })
    return { el, key: `${kind}${idx}:${si}${variant}:${pageNoText(idx)}/${total}:${hashStr(JSON.stringify(value))}` }
  }

  /**
   * An empty strip is only a double-click target: pin it to the page's margin band
   * (styles: .cdd-hf-empty:not(.page-hf-editing) reads --hf-empty-*). While editing
   * it returns to the header-dist/footer-dist geometry set above.
   */
  const emptyBand = (el: HTMLElement, kind: 'header' | 'footer', edge: string, heightPx: number) => {
    if (!el.classList.contains('cdd-hf-empty')) return
    el.style.setProperty('--hf-empty-top', kind === 'header' ? edge : 'auto')
    el.style.setProperty('--hf-empty-bottom', kind === 'footer' ? edge : 'auto')
    el.style.setProperty('--hf-empty-h', `${Math.max(0, heightPx)}px`)
  }

  // footnotes per page: the page holding each reference line (App.tsx pageFootnotesOf)
  const pageNotes: PageNoteItem[][] = slices.map(() => [])
  if (geo.footnotes.length > 0) {
    const byIndex = new Map<number, Block>()
    for (const b of parsed.blocks) if (b.docxIndex !== null && !byIndex.has(b.docxIndex)) byIndex.set(b.docxIndex, b)
    for (const b of blocks) {
      if (b.docxIndex === undefined) continue
      const pb = byIndex.get(b.docxIndex)
      if (!pb) continue
      const ids = blockNoteScanRuns(pb).filter((r) => r.noteRef?.kind === 'footnote').map((r) => r.noteRef!.id)
      if (ids.length === 0) continue
      const blockPage = pageAt(slices, b.top + 0.5) - 1
      const sec = secs.find((s) => b.docxIndex! <= s.lastBlockIndex)?.settings ?? geo.first
      ids.forEach((id, ri) => {
        const i = geo.footnotes.findIndex((f) => f.id === id)
        if (i < 0) return
        const fn = geo.footnotes[i]
        const band = b.noteBands?.length === ids.length ? b.noteBands[ri] : undefined
        const page = band ? pageAt(slices, b.top + (b.spaceBeforePx ?? 0) + band.offset + 0.5) - 1 : blockPage
        const no = noteNoOf(parsed, 'footnote', id, i)
        const info = noteInfo(fn, no, sec, 'footnote')
        pageNotes[page]?.push({ no, id, text: fn.text, ...(fn.richParas ? { richParas: fn.richParas } : {}), ...(fn.noRefMark ? { noRefMark: true as const } : {}), height: info.height, lineHeightPx: info.lineHeightPx, fontSizePt: info.fontSizePt, ...(info.fontFamily ? { fontFamily: info.fontFamily } : {}) })
      })
    }
  }
  const notesHeight = (items: PageNoteItem[]) => (items.length > 0 ? items.reduce((s, n) => s + n.height, 0) + FOOTNOTE_SEPARATOR_H : 0)

  const lineRectsOf = createLineRectsCache()
  const gaps: PageGapSpec[] = []
  let unanchored = 0
  /** notes moved to the last page because their page ended inside a table (in-table gaps carry no notes area) */
  let relocatedNotesH = 0
  slices.slice(1).forEach((slice, k) => {
    // a same-start predecessor that is zero-height is a deliberate blank page; other same-start duplicates draw one band
    if (slice.start === slices[k].start && slices[k].end > slices[k].start) return
    const prevSec = setOf(k)
    const nextSec = setOf(k + 1)
    const prevHf = hfOfPage(k)
    const nextHf = hfOfPage(k + 1)
    const base = {
      marginTop: effectiveTopPx(nextSec, nextHf.headerPx),
      marginBottom: effectiveBottomPx(prevSec, prevHf.footerPx),
      marginLeft: twipsToPx(nextSec.marginLeft),
      marginRight: twipsToPx(nextSec.marginRight),
      sectionMarginLeft: twipsToPx(nextSec.marginLeft),
      sectionMarginRight: twipsToPx(nextSec.marginRight),
      sectionMarginTop: twipsToPx(nextSec.marginTop),
    }
    // a page that ended early leaves unused height: pad the gap so the paper keeps its height. Columned pages use the
    // engine's physical height and pull the gap up over the vacated stacked-column space (original mixed mode)
    const prevContentH = twipsToPx(prevSec.pageHeight) - effectiveTopPx(prevSec, prevHf.headerPx) - base.marginBottom
    const used = slices[k].end - slices[k].start + (slices[k].repeatHeader?.height ?? 0)
    const physUsed = slices[k].regions ? (slices[k].physHeight ?? used) : used
    const pullUp = Math.max(0, used - physUsed)
    const items = pageNotes[k] ?? []
    const fnH = notesHeight(items)
    const pad = Math.max(0, Math.round(prevContentH - physUsed - fnH))
    let metrics = pad > 0 ? { ...base, marginBottom: base.marginBottom + pad } : base
    // previous page's footnotes: the top of the gap (its page-bottom area), the gap enlarged by their height
    let notesProps = {}
    if (items.length > 0) {
      const contentW = twipsToPx(prevSec.pageWidth - prevSec.marginLeft - prevSec.marginRight)
      const notes = makeNotesEl(items, twipsToPx(prevSec.marginLeft), contentW, fnH, footnoteLineHeightPx(prevSec.docGrid))
      notesProps = { notes, notesKey: `${Math.round(fnH)}:${items.map((n) => `${n.no}${n.text}`).join('|')}` }
      metrics = { ...metrics, marginBottom: metrics.marginBottom + fnH }
    }
    // previous page's footer (bottom band) + next page's header (top band)
    const hfEls: HTMLElement[] = []
    const keys: string[] = []
    const footer = strip(k, 'footer', prevSec, undefined, true)
    if (footer) {
      footer.el.style.top = 'auto'
      footer.el.style.bottom = `${GAP_BAND + metrics.marginTop + sectionPageBox(prevSec).footerDist}px`
      // empty strip: the double-click target is the page's bottom margin band (never the body)
      emptyBand(footer.el, 'footer', `${GAP_BAND + metrics.marginTop}px`, twipsToPx(prevSec.marginBottom))
      hfEls.push(footer.el)
      keys.push(footer.key)
    }
    const headerStripTop = Math.min(sectionPageBox(nextSec).headerDist, metrics.marginTop)
    const header = strip(k + 1, 'header', nextSec, headerStripTop, true)
    if (header) {
      header.el.style.bottom = 'auto'
      header.el.style.top = `calc(100% - ${metrics.marginTop - headerStripTop}px)`
      emptyBand(header.el, 'header', `calc(100% - ${metrics.marginTop}px)`, metrics.marginTop)
      hfEls.push(header.el)
      keys.push(header.key)
    }
    const hfProps = hfEls.length ? { hfEls, hfKey: hashStr(keys.join('|')) } : {}
    const extra = { ...hfProps, ...notesProps, ...(pullUp > 0.5 ? { pullUp } : {}) }
    const lead = blocks.find((b) => b.el && !b.floated && Math.abs(b.top - slice.start) < 0.5)
    if (lead?.el) {
      gaps.push({ el: lead.el, boundaryY: slice.start, metrics, ...extra })
      return
    }
    const b = blocks.find((bb) => bb.el && !bb.floated && bb.top < slice.start && bb.top + bb.height > slice.start)
    if (!b?.el) {
      unanchored++
      return
    }
    const cutOff = slice.start - b.top - (b.spaceBeforePx ?? 0)
    if (b.el.querySelector('tr')) {
      // table crossing the boundary: a gap row before the first row of the new page (no footnote area: absolute
      // positioning inside a table row is unreliable — those notes stay in the last page's area)
      const gapRects = Array.from(b.el.querySelectorAll('.page-gap-inline')).map((g) => g.getBoundingClientRect())
      const elTop = b.el.getBoundingClientRect().top
      const rows = Array.from(b.el.querySelectorAll('tr')).filter((r) => !r.closest('.doc-nested-table') && !r.classList.contains('page-repeat-header') && !r.classList.contains('page-gap'))
      for (const tr of rows) {
        const trTop = tr.getBoundingClientRect().top
        const gapsAbove = gapRects.reduce((s, g) => (g.top <= trTop ? s + g.height : s), 0)
        const off = (trTop - elTop - gapsAbove) / factor
        if (Math.abs(off - cutOff) >= 1.5) continue
        try {
          const $pos = view.state.doc.resolve(view.posAtDOM(tr, 0))
          const cols = Math.max(1, ...rows.map((r) => Array.from((r as HTMLTableRowElement).cells).reduce((s, c) => s + c.colSpan, 0)))
          for (let d = $pos.depth; d > 0; d--) {
            if ($pos.node(d).type.name === 'docTableRow') {
              // metrics already pads the page to its full height (the notes' share included): only the notes move —
              // onto the last page, which grows by their height (its own slicing reserved none for them)
              if (items.length > 0) {
                pageNotes[slices.length - 1]?.push(...items)
                relocatedNotesH += items.reduce((s, n) => s + n.height, 0)
              }
              gaps.push({ pos: $pos.before(d), kind: 'table', cols, boundaryY: slice.start, metrics, ...hfProps })
              return
            }
          }
        } catch {
          /* posAtDOM failed: skip this boundary */
        }
        break
      }
      unanchored++
      return
    }
    const anchor = lineStartAnchor(b.el, cutOff, factor, lineRectsOf) ?? nextLineAnchor(b.el, cutOff, factor, lineRectsOf)
    const pos = anchor ? posFromAnchor(view, anchor) : undefined
    if (pos == null) {
      unanchored++
      return
    }
    // fold the block's offset from the paper edge (margin + indent) into negative margins so the gap spans the paper
    const elRect = b.el.getBoundingClientRect()
    gaps.push({ pos, boundaryY: slice.start, metrics: { ...metrics, marginLeft: (elRect.left - pmRect.left) / factor, marginRight: (pmRect.right - elRect.right) / factor }, ...extra })
  })

  // engine patches: split declared-height rows, oversize single lines, page-relative floats
  const blockIndex = new BlockIndex(blocks)
  const batch = new LayoutBatch(view)
  const rowFillEls: Array<{ el: Element; targetPx: number; extraPx?: number }> = []
  for (const f of out.rowFills ?? []) {
    const b = blocks[blockIndex.firstAtTop(f.blockTop, (bb) => !!bb.tableRows)]
    if (!b?.el) continue
    const trs = Array.from(b.el.querySelectorAll('tr')).filter((tr) => !tr.closest('.doc-nested-table') && !tr.classList.contains('page-gap') && !tr.classList.contains('page-repeat-header'))
    const tr = trs[f.row]
    if (tr) rowFillEls.push({ el: tr, targetPx: f.targetPx, ...(f.extraPx ? { extraPx: f.extraPx } : {}) })
  }
  setRowFills(view, rowFillEls, batch)
  const oversizeEls: Array<{ el: HTMLElement; clipPx: number }> = []
  for (const c of out.oversizeClips ?? []) {
    const b = blocks[blockIndex.firstAtTop(c.blockTop, (bb) => bb.oversizeLineH !== undefined)]
    if (b?.el) oversizeEls.push({ el: b.el, clipPx: c.clipPx })
  }
  setOversizeClips(view, oversizeEls)
  const floatEls: Array<{ el: Element; dyPx: number; flow?: boolean }> = []
  for (const f of out.floatVShifts ?? []) {
    const b = blocks.find((bb) => bb.pageRelVyPx !== undefined && Math.abs(bb.top - f.blockTop) < 0.5)
    if (b?.el) floatEls.push({ el: b.el, dyPx: f.dyPx })
  }
  for (const f of out.floatFlows ?? []) {
    const b = blocks.find((bb) => !!bb.floatTable && Math.abs(bb.top - f.blockTop) < 0.5)
    if (b?.el) floatEls.push({ el: b.el, dyPx: 0, flow: true })
  }
  setFloatVShifts(view, floatEls, batch)
  setPageGaps(view, gaps, undefined, batch)
  // columns: each block painted into its column slot (width + translate); widths that move line breaks ask for one more pass
  let followUp = false
  if (geo.hasColumns || opts.print) {
    let colSpecs = geo.hasColumns ? columnLayoutSpecs(blocks, slices, secs) : []
    if (opts.print) {
      const widths = new Map(sectionWidthSpecs(blocks, secs, sectionGeoms(secs, hfHs, geo.evenOdd)).map((spec) => [spec.el, spec]))
      for (const col of colSpecs) {
        const base = widths.get(col.el)
        widths.set(col.el, base ? { ...base, ...col, dx: base.dx + col.dx } : col)
      }
      colSpecs = [...widths.values()]
    }
    followUp = widthPassGate(geo.colPass, colSpecs)
    setColumnLayout(view, colSpecs, batch)
  }
  batch.commit()

  // last page: pad the paper to its full height so its footer sits at the paper bottom. The DOM keeps the stacked
  // height (column translates only move blocks visually), so the pad is measured against `used`, repeated table
  // header rows included; relocated footnotes add their height beyond the page when the text already fills it
  const lastIdx = slices.length - 1
  if (lastIdx >= 0) {
    const set = setOf(lastIdx)
    const hf = hfOfPage(lastIdx)
    const bottom = effectiveBottomPx(set, hf.footerPx)
    const contentH = twipsToPx(set.pageHeight) - effectiveTopPx(set, hf.headerPx) - bottom
    const used = slices[lastIdx].end - slices[lastIdx].start + (slices[lastIdx].repeatHeader?.height ?? 0)
    // the notes area is drawn from the body bottom up: the body must hold the text and the whole notes area
    const required = Math.max(contentH, relocatedNotesH > 0 ? used + notesHeight(pageNotes[lastIdx] ?? []) : 0)
    pm.style.paddingBottom = `${bottom + Math.max(0, Math.round(required - used))}px`
  }
  // edge strips: page 1's header at the canvas top, the last page's footnotes and footer at the canvas bottom
  const host = opts.edgeHost
  if (host) {
    host.querySelectorAll(':scope > .cdd-edge-hf, :scope > .cdd-edge-notes').forEach((el) => el.remove())
    // edge strips live outside .doc-page: give them the page's resolved body font, as the gap strips inherit it
    host.style.setProperty('--cdd-doc-font', getComputedStyle(pm).fontFamily)
    const firstSet = setOf(0)
    const headTop = Math.min(sectionPageBox(firstSet).headerDist, geo.top)
    const head = strip(0, 'header', firstSet, headTop, true)
    if (head) {
      head.el.classList.add('cdd-edge-hf')
      head.el.style.top = `${headTop}px`
      head.el.style.bottom = 'auto'
      head.el.style.left = `${twipsToPx(firstSet.marginLeft)}px`
      head.el.style.transform = 'none'
      // empty header: a min-height strip at header-dist would reach into the body when
      // header-dist + one line > top margin (observed: 12.7mm + 18px over a 15mm margin
      // overlapped the title) — confine it to the top margin band instead
      emptyBand(head.el, 'header', '0px', geo.top)
      host.append(head.el)
    }
    if (lastIdx >= 0) {
      const lastSet = setOf(lastIdx)
      const foot = strip(lastIdx, 'footer', lastSet, undefined, true)
      if (foot) {
        foot.el.classList.add('cdd-edge-hf')
        foot.el.style.top = 'auto'
        foot.el.style.bottom = `${sectionPageBox(lastSet).footerDist}px`
        foot.el.style.left = `${twipsToPx(lastSet.marginLeft)}px`
        foot.el.style.transform = 'none'
        emptyBand(foot.el, 'footer', '0px', twipsToPx(lastSet.marginBottom))
        host.append(foot.el)
      }
      const items = pageNotes[lastIdx] ?? []
      if (items.length > 0) {
        const fnH = notesHeight(items)
        const contentW = twipsToPx(lastSet.pageWidth - lastSet.marginLeft - lastSet.marginRight)
        const notes = makeNotesEl(items, twipsToPx(lastSet.marginLeft), contentW, fnH, footnoteLineHeightPx(lastSet.docGrid))
        notes.classList.add('cdd-edge-notes')
        notes.style.top = 'auto'
        notes.style.bottom = `${effectiveBottomPx(lastSet, hfOfPage(lastIdx).footerPx)}px`
        host.append(notes)
      }
    }
  }
  let printPages: CanvasPagination['printPages']
  if (opts.print && host) {
    const rootTop = host.getBoundingClientRect().top
    const paperW = paperWidthPx(secs, geo.first)
    const remainingGaps = Array.from(pm.querySelectorAll<HTMLElement>('.page-gap[data-boundary-y]'))
    let nextY = 0
    printPages = slices.map((slice, idx) => {
      const set = setOf(idx)
      const box = sectionPageBox(set)
      if (idx > 0) {
        const gi = remainingGaps.findIndex((gap) => Math.abs(Number(gap.dataset.boundaryY) - slice.start) < 0.2)
        const gap = gi >= 0 ? remainingGaps.splice(gi, 1)[0] : null
        if (gap) nextY = (gap.getBoundingClientRect().bottom - rootTop) / factor - effectiveTopPx(set, hfOfPage(idx).headerPx)
      }
      const head = strip(idx, 'header', set, Math.min(box.headerDist, effectiveTopPx(set, hfOfPage(idx).headerPx)))
      const foot = strip(idx, 'footer', set)
      for (const [entry, kind] of [[head, 'header'], [foot, 'footer']] as const) {
        if (!entry) continue
        entry.el.style.position = 'absolute'
        entry.el.style.left = `${twipsToPx(set.marginLeft)}px`
        entry.el.style.transform = 'none'
        entry.el.style.top = kind === 'header' ? `${Math.min(box.headerDist, effectiveTopPx(set, hfOfPage(idx).headerPx))}px` : 'auto'
        entry.el.style.bottom = kind === 'footer' ? `${box.footerDist}px` : 'auto'
      }
      const items = pageNotes[idx] ?? []
      const notes = items.length ? makeNotesEl(items, twipsToPx(set.marginLeft), box.contentWidth, notesHeight(items), footnoteLineHeightPx(set.docGrid)) : null
      if (notes) {
        notes.style.top = 'auto'
        notes.style.bottom = `${effectiveBottomPx(set, hfOfPage(idx).footerPx)}px`
      }
      const page = { x: pageLeftPx(set, paperW), y: nextY, width: box.width, height: box.height, header: head?.el.outerHTML ?? '', footer: foot?.el.outerHTML ?? '', notes: notes?.outerHTML ?? '' }
      nextY += box.height + GAP_BAND
      return page
    })
  }
  return { pages: total, slices, blocks, unanchored, followUp, ...(printPages ? { printPages } : {}) }
}
