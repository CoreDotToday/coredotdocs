// coredotdocs' own patches to rhwp-studio (MIT) for the shell's format bar (설계 문서 02 §16).
// Applied by third_party/ieumoffice-hwp/build-studio.mjs with the same exact-text mechanism as its patches.
//
// The studio's SDK (`commands.execute`) exposes only toggles (bold…) and dialogs (글자 모양·문단 모양) for formatting;
// its own toolbar sets the font name, size and colour through an internal event (`format-char`) and reads the
// caret's formatting through `InputHandler.getCharProperties()`. The shell draws its own toolbar (chrome=embed hides
// the studio's), so the studio gains:
//
// cdd-format-context      command context carries the caret's character/paragraph formatting (`format`) and the
//                         fonts the document uses (`documentFonts`) — read with `commands.context()`.
// cdd-document-fonts(-var) remembers the loaded document's font list for the context.
// cdd-format-commands     `format:set-char` {fontName|fontSize(pt*100)|textColor|shadeColor|bold…} and
//                         `format:set-para` {alignment|lineSpacing…} — parameterised commands the shell calls,
//                         going through the studio's own apply paths (caret-pending format when nothing is selected).

export const FORMAT_PATCHES = {
  'cdd-format-context': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
    find: "    sourceFormat: hasDoc ? (wasm.getSourceFormat() as 'hwp' | 'hwpx' | 'hml') : undefined,",
    replace: [
      "    sourceFormat: hasDoc ? (wasm.getSourceFormat() as 'hwp' | 'hwpx' | 'hml') : undefined,",
      '    // coredotdocs: 셸 서식 도구 막대가 읽는 캐럿 서식 (cdd-format-context)',
      '    format: hasDoc && inputHandler ? cddReadFormat(inputHandler) : undefined,',
      '    documentFonts: hasDoc ? [...new Set([...cddDocumentFonts, ...cddFontNames.values()])] : undefined,',
      '    localFonts: getDetectedLocalFonts(), // 스튜디오가 감지한 설치 글꼴 (tools:detect-local-fonts 뒤; 저장된 감지 결과가 있으면 다음 실행부터 바로)',
    ].join('\n'),
  },
  'cdd-format-import': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
    find: "import { InputHandler } from '@/engine/input-handler';",
    replace: [
      "import { InputHandler } from '@/engine/input-handler';",
      "import { cddFontNames } from '@/command/commands/format'; // coredotdocs (cdd-format-import)",
      "import { getDetectedLocalFonts } from '@/core/local-fonts';",
    ].join('\n'),
  },
  'cdd-document-fonts-var': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
    find: 'let toolbar: Toolbar | null = null;',
    replace: [
      'let toolbar: Toolbar | null = null;',
      '// coredotdocs: 연 문서가 쓰는 글꼴 목록 (cdd-document-fonts)',
      'let cddDocumentFonts: string[] = [];',
      'function cddReadFormat(ih: InputHandler): Record<string, unknown> | undefined {',
      '  try {',
      '    // 선택이 없을 때 고른 서식은 캐럿 대기 서식으로만 있다(다음 타이핑부터) — 막대는 그것을 보여 줘야 한다',
      '    const pending = ih.getPendingCharShape() ?? {};',
      '    const c = { ...ih.getCharProperties(), ...pending };',
      "    if (typeof pending.fontId === 'number' && cddFontNames.has(pending.fontId)) c.fontFamily = cddFontNames.get(pending.fontId);",
      '    const p = ih.getParaProperties();',
      '    return {',
      '      fontFamily: c.fontFamily, fontFamilies: c.fontFamilies, fontSize: c.fontSize,',
      '      bold: !!c.bold, italic: !!c.italic, underline: !!c.underline, strikethrough: !!c.strikethrough,',
      '      textColor: c.textColor, shadeColor: c.shadeColor,',
      "      alignment: p.alignment, lineSpacing: p.lineSpacingType === 'Percent' ? p.lineSpacing : undefined,",
      '      pending: Object.keys(pending).length > 0,',
      '    };',
      '  } catch {',
      '    return undefined;',
      '  }',
      '}',
    ].join('\n'),
  },
  'cdd-document-fonts': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]main\.ts$/,
    find: '    toolbar?.initFontDropdown(docInfo.fontsUsed);',
    replace: ['    toolbar?.initFontDropdown(docInfo.fontsUsed);', '    cddDocumentFonts = [...docInfo.fontsUsed];'].join('\n'),
  },
  'cdd-format-commands': {
    file: /[\\/]rhwp-studio[\\/]src[\\/]command[\\/]commands[\\/]format\.ts$/,
    find: 'export const formatCommands: CommandDef[] = [',
    replace: [
      "import { detectLocalFonts, isLocalFontSupported } from '@/core/local-fonts'; // coredotdocs (cdd-format-commands)",
      '// coredotdocs: format:set-char가 만든 글꼴 id → 이름 (캐럿 대기 서식의 글꼴을 막대에 보여 주기 위해)',
      'export const cddFontNames = new Map<number, string>();',
      'export const formatCommands: CommandDef[] = [',
      '  // coredotdocs: 셸 서식 도구 막대용 매개변수 명령 (cdd-format-commands)',
      '  {',
      "    id: 'format:set-char',",
      "    label: '글자 속성 지정',",
      '    canExecute: (ctx) => ctx.hasDocument,',
      '    execute(services, params) {',
      '      const ih = services.getInputHandler();',
      '      if (!ih || !params) return;',
      '      const mods: Record<string, unknown> = { ...params };',
      "      if (typeof mods.fontName === 'string') {",
      '        const fontId = services.wasm.findOrCreateFontId(mods.fontName);',
      '        if (fontId >= 0) {',
      '          mods.fontId = fontId;',
      '          cddFontNames.set(fontId, mods.fontName);',
      '        }',
      '        delete mods.fontName;',
      '      }',
      "      services.eventBus.emit('format-char', mods);",
      '    },',
      '  },',
      '  {',
      "    id: 'tools:detect-local-fonts',",
      "    label: '설치된 글꼴 감지',",
      '    canExecute: () => isLocalFontSupported(),',
      '    async execute(services, params) {',
      '      // 스튜디오의 옵션 대화상자가 하는 것과 같다: 감지(Local Font Access) → 저장 → 화면이 실제 글꼴로 다시 그려진다',
      '      const fonts = await detectLocalFonts({ force: params?.force === true, includeRegistered: true });',
      "      services.eventBus.emit('local-fonts-changed', { fonts, source: 'host' });",
      '    },',
      '  },',
      '  {',
      "    id: 'format:set-para',",
      "    label: '문단 속성 지정',",
      '    canExecute: (ctx) => ctx.hasDocument,',
      '    execute(services, params) {',
      '      const ih = services.getInputHandler();',
      '      if (!ih || !params) return;',
      '      ih.applyParaPropsAtCursor(params as Record<string, unknown>);',
      '      ih.focus();',
      '    },',
      '  },',
    ].join('\n'),
  },
}

export const FORMAT_PATCH_NAMES = /** @type {const} */ (['cdd-format-import', 'cdd-format-context', 'cdd-document-fonts-var', 'cdd-document-fonts', 'cdd-format-commands'])
