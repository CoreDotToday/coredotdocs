/**
 * Derived from IeumOffice apps/hwp/scripts/rhwp-patches.mjs (Apache-2.0, see ../LICENSE and ../NOTICE).
 * Changes for coredotdocs: the custom-scheme patches are gone (the studio is served over http),
 * the plugin module and id are coredotdocs' own.
 *
 * The source patches coredotdocs applies to rhwp-studio when it builds it. Each one is an exact-text
 * replacement that fails loudly when the text is gone, so an rhwp upgrade cannot drop one silently.
 *
 * studio-password-flag
 *   The bridge's export writes plain bytes even for a document that was opened with a password; only
 *   the studio's own Save, which embed mode removes, asks for the password again. The studio knows the
 *   document is protected but does not say so over the bridge, so its command context gains one field
 *   and the host can refuse to write such a document.
 *
 * studio-plugin-allow
 *   The studio loads plugins only from a list compiled into it, and in a production build that list
 *   holds its own HwpCtrl plugin alone. The AI edits the document through coredotdocs' plugin
 *   (agent-plugin.mjs), so the list gains that one name.
 *
 * studio-table-delete-at, studio-nested-table-delete, studio-nested-table-cut, studio-nested-table-command
 *   The studio cannot delete a table that sits in another table's cell (a form whose cells hold tables).
 *   With such a table selected, Delete and Cut drop the selection and leave the table, and "Delete Table"
 *   from the cell's menu reads the caret by the outer table alone and deletes the whole outer table.
 *   The engine has the call for a table in a cell (`deleteCellTableControlByPath`). The bridge gains one
 *   method that deletes the table a selection or a caret points at, and the three paths call it.
 */

/** Field the studio-password-flag patch adds to the studio's command context. */
export const PASSWORD_FLAG = 'passwordProtected'

/** Module specifier the studio-plugin-allow patch imports; build-studio.mjs aliases it. */
export const AGENT_PLUGIN_MODULE = '@coredotdocs/agent-plugin'

/** Must equal AGENT_PLUGIN_ID in agent-plugin.mjs. */
export const AGENT_PLUGIN_ID = 'coredotdocs-agent'

import { FORMAT_PATCHES, FORMAT_PATCH_NAMES } from '../../frontend/scripts/studio-format-patches.mjs'

const PATCHES = {
  // coredotdocs' own format-bar patches (frontend/scripts/studio-format-patches.mjs), applied with the same mechanism
  ...FORMAT_PATCHES,
  'studio-password-flag': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
    find: '    isDirty: documentState.isDirty(),',
    replace: `    isDirty: documentState.isDirty(),\n    ${PASSWORD_FLAG}: wasm.requiresPasswordForSave,`,
  },
  'studio-plugin-allow': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
    find: "  if (import.meta.env.DEV && id === 'dev-probe') {",
    replace:
      `  if (id === '${AGENT_PLUGIN_ID}') {\n` +
      `    return (await import('${AGENT_PLUGIN_MODULE}')).agentPlugin as StudioPlugin;\n` +
      '  }\n' +
      "  if (import.meta.env.DEV && id === 'dev-probe') {",
  },
  'studio-table-delete-at': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]core[\\/]wasm-bridge\.ts$/,
    find: [
      '  deleteTableControl(sec: number, parentPara: number, controlIdx: number): { ok: boolean } {',
      "    if (!this.doc) throw new Error('문서가 로드되지 않았습니다');",
      '    return JSON.parse(this.doc.deleteTableControl(sec, parentPara, controlIdx));',
      '  }',
      '',
    ].join('\n'),
    replace: [
      '  deleteTableControl(sec: number, parentPara: number, controlIdx: number): { ok: boolean } {',
      "    if (!this.doc) throw new Error('문서가 로드되지 않았습니다');",
      '    return JSON.parse(this.doc.deleteTableControl(sec, parentPara, controlIdx));',
      '  }',
      '',
      '  /** The table a selection or a caret points at: in the body, or (a path of two or more) the innermost one in a cell. */',
      '  deleteTableAt(ref: { sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] }): { ok: boolean } {',
      '    const path = ref.cellPath ?? [];',
      '    if (path.length < 2) return this.deleteTableControl(ref.sec, ref.ppi, ref.ci);',
      "    if (!this.doc) throw new Error('문서가 로드되지 않았습니다');",
      '    return JSON.parse(this.doc.deleteCellTableControlByPath(',
      '      ref.sec, ref.ppi, JSON.stringify(path.slice(0, -1)), path[path.length - 1].controlIndex,',
      '    ));',
      '  }',
      '',
    ].join('\n'),
  },
  'studio-nested-table-delete': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]engine[\\/]input-handler\.ts$/,
    find: [
      '      if (ref.cellPath && ref.cellPath.length > 1) {',
      '        this.cursor.moveOutOfSelectedTable();',
      "        this.eventBus.emit('table-object-selection-changed', false);",
      '        this.updateCaret();',
      '        return;',
      '      }',
      '      this.cursor.moveOutOfSelectedTable();',
      "      this.eventBus.emit('table-object-selection-changed', false);",
      "      this.executeOperation({ kind: 'snapshot', operationType: 'deleteTable', operation: (wasm: WasmBridge) => {",
      '        wasm.deleteTableControl(ref.sec, ref.ppi, ref.ci);',
    ].join('\n'),
    replace: [
      '      this.cursor.moveOutOfSelectedTable();',
      "      this.eventBus.emit('table-object-selection-changed', false);",
      "      this.executeOperation({ kind: 'snapshot', operationType: 'deleteTable', operation: (wasm: WasmBridge) => {",
      '        wasm.deleteTableAt(ref);',
    ].join('\n'),
  },
  'studio-nested-table-cut': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]engine[\\/]input-handler\.ts$/,
    find: [
      '        // 중첩 표 잘라내기는 지원하지 않는다. keydown 경로도 같은 선택 상태를 유지한다.',
      '        if (ref.cellPath && ref.cellPath.length > 1) return;',
      '        this.performCopy();',
      '        this.cursor.moveOutOfSelectedTable();',
      "        this.eventBus.emit('table-object-selection-changed', false);",
      "        this.executeOperation({ kind: 'snapshot', operationType: 'cutTable', operation: (wasm: WasmBridge) => {",
      '          wasm.deleteTableControl(ref.sec, ref.ppi, ref.ci);',
    ].join('\n'),
    replace: [
      '        this.performCopy();',
      '        this.cursor.moveOutOfSelectedTable();',
      "        this.eventBus.emit('table-object-selection-changed', false);",
      "        this.executeOperation({ kind: 'snapshot', operationType: 'cutTable', operation: (wasm: WasmBridge) => {",
      '          wasm.deleteTableAt(ref);',
    ].join('\n'),
  },
  'studio-nested-table-command': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]command[\\/]commands[\\/]table\.ts$/,
    find: [
      '      const ref = ih.getSelectedTableRef();',
      '      if (ref) {',
      '        safeTableOp(() => ih.executeOperation({',
      "          kind: 'snapshot',",
      "          operationType: 'deleteTable',",
    ].join('\n'),
    replace: [
      '      const ref = ih.getSelectedTableRef();',
      '      // a table in a cell: a selected one goes the way Delete takes it, and from',
      '      // the caret the table the caret is in goes, not the outer one',
      '      if ((ref?.cellPath?.length ?? 0) > 1) {',
      '        ih.performDelete();',
      '        return;',
      '      }',
      '      const at = ih.getCursorPosition();',
      '      if (!ref && at.parentParaIndex !== undefined && at.controlIndex !== undefined && (at.cellPath?.length ?? 0) > 1) {',
      '        const outer = at.cellPath!.slice(0, -1);',
      '        const cell = outer[outer.length - 1];',
      '        safeTableOp(() => ih.executeOperation({',
      "          kind: 'snapshot',",
      "          operationType: 'deleteTable',",
      '          operation: (wasm) => {',
      '            wasm.deleteTableAt({ sec: at.sectionIndex, ppi: at.parentParaIndex!, ci: at.controlIndex!, cellPath: at.cellPath });',
      '            return {',
      '              sectionIndex: at.sectionIndex,',
      '              paragraphIndex: cell.cellParaIndex,',
      '              charOffset: 0,',
      '              parentParaIndex: at.parentParaIndex,',
      '              controlIndex: outer[0].controlIndex,',
      '              cellIndex: cell.cellIndex,',
      '              cellParaIndex: cell.cellParaIndex,',
      '              cellPath: outer,',
      '              isTextBox: at.isTextBox && outer.length === 1 ? true : undefined,',
      '            };',
      '          },',
      "        }), '표 지우기');",
      '        return;',
      '      }',
      '      if (ref) {',
      '        safeTableOp(() => ih.executeOperation({',
      "          kind: 'snapshot',",
      "          operationType: 'deleteTable',",
    ].join('\n'),
  },
}

/** The patches the studio build applies, in order. */
export const STUDIO_PATCHES = /** @type {const} */ ([
  'studio-password-flag',
  'studio-plugin-allow',
  'studio-table-delete-at',
  'studio-nested-table-delete',
  'studio-nested-table-cut',
  'studio-nested-table-command',
  ...FORMAT_PATCH_NAMES,
])

/** Whether a patch is written against this file. */
export function patchTargets(name, file) {
  const patch = PATCHES[name]
  if (!patch) throw new Error(`rhwp patch: unknown patch "${name}"`)
  return patch.file.test(file)
}

/**
 * What the plugin uses of the studio beyond the plugin host: the editor's caret (to show a change,
 * read the selection, select a word) and the pages' places and zoom (to mark its changes). The host
 * hands out none of it; the plugin reaches it through a command it registers, which the studio calls
 * with its own services. These are names inside the studio, not a contract, so the build looks for
 * them in the fetched source: a release that renames one fails the build instead of silently turning
 * those things off.
 */
export const pluginHooks = [
  {
    file: 'src/engine/cursor.ts',
    needles: [
      'hasSelection(): boolean',
      'getSelectionOrdered()',
      'clearSelection(): void',
      'moveTo(pos: DocumentPosition): void',
      'setAnchor(): void',
      'getPosition(): DocumentPosition',
      'isInCellSelectionMode(): boolean',
      'getSelectedCellRange()',
      'getCellTableContext()',
      'getExcludedCells()',
    ],
  },
  {
    file: 'src/engine/input-handler.ts',
    needles: ['private cursor: CursorState', 'updateCaret(', 'private virtualScroll: VirtualScroll'],
  },
  {
    file: 'src/command/types.ts',
    needles: [
      'getInputHandler: () => InputHandler | null',
      'getViewportManager: () => ViewportManager | null',
      'execute: (services: CommandServices, params?: Record<string, unknown>) => void',
    ],
  },
  {
    file: 'src/view/virtual-scroll.ts',
    needles: ['getPageOffset(pageIdx: number): number', 'getPageLeftResolved(pageIdx: number, containerWidth: number): number'],
  },
  { file: 'src/view/viewport-manager.ts', needles: ['getZoom(): number'] },
  { file: 'index.html', needles: ['<div id="scroll-content"></div>'] },
  { file: 'src/automation/types.ts', needles: ['registerCommand(def: ExtCommandDef): void'] },
]

/** The hooks a studio source tree lacks; `read` gives the text of one of its files, or null. */
export function missingPluginHooks(read) {
  const missing = []
  for (const { file, needles } of pluginHooks) {
    const text = read(file)
    for (const needle of needles) {
      if (text === null || !text.includes(needle)) missing.push(`${file}: ${needle}`)
    }
  }
  return missing
}

export function applyPatch(name, code) {
  const patch = PATCHES[name]
  if (!patch) throw new Error(`rhwp patch: unknown patch "${name}"`)
  // a checkout on Windows may carry CRLF; the patches are written with LF
  const eol = code.includes('\r\n') ? '\r\n' : '\n'
  const find = patch.find.replaceAll('\n', eol)
  const first = code.indexOf(find)
  if (first === -1 || code.indexOf(find, first + 1) !== -1) {
    throw new Error(`rhwp patch ${name}: expected exactly one occurrence of the text to replace; the upstream source changed, review third_party/ieumoffice-hwp/rhwp-patches.mjs`)
  }
  const replace = patch.replace.replaceAll('\n', eol)
  return code.replace(find, () => replace)
}

/**
 * Vite plugin applying the named patches during a production build.
 * @param {...keyof typeof PATCHES} names
 * @returns {import('vite').Plugin}
 */
export function rhwpPatches(...names) {
  const applied = new Set()
  return {
    name: `rhwp-patches:${names.join('+')}`,
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      let next = code
      for (const name of names) {
        if (!PATCHES[name].file.test(file)) continue
        next = applyPatch(name, next)
        applied.add(name)
      }
      return next === code ? null : { code: next, map: null }
    },
    buildEnd() {
      const missing = names.filter((name) => !applied.has(name))
      if (missing.length > 0) {
        this.error(`rhwp patches never applied: ${missing.join(', ')} (file not loaded)`)
      }
    },
  }
}
