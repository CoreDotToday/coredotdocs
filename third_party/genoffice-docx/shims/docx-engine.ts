// coredotdocs shim (not from GenOffice): `@genoffice/docx-engine`의 입구.
// 가져온 커밋(8ab58a5)의 index.ts는 resolve-props의 내보내기(EffectivePPr·EffectiveRPr·resolveCtxOf…)를 아직 다시 내보내지 않는데
// apps/docs의 convert.ts와 엔진 테스트(resolve-props.test.ts)는 그것을 index에서 가져온다. 파일을 고치지 않고 여기서 둘을 합친다.
export * from '../packages/docx-engine/src/index'
export { resolveCtxOf, resolveParagraphPropsXml, resolveRunProps, type EffectivePPr, type EffectiveRPr, type ResolveCtx } from '../packages/docx-engine/src/resolve-props'
