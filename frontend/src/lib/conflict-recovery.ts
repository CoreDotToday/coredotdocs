import { api, type DocFormat } from "./api";

/** Keep the local version as a separate document before accepting a concurrent edit. */
export async function preserveConflictCopy(bytes: Uint8Array, filename: string, format: DocFormat): Promise<string> {
  const name = filename.replace(/\.(hwpx|docx)$/i, "").slice(0, 180);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const recoveryName = `${name} — 충돌 복구 ${stamp}.${format}`;
  try {
    const result = await api.upload(new Blob([bytes as BlobPart]), recoveryName);
    return result.title;
  } catch (error) {
    throw new Error(`충돌 복구 사본을 만들지 못해 화면의 편집 내용을 유지했습니다. 연결을 확인하고 다시 저장하세요. (${String(error)})`);
  }
}

export function recoveryNotice(title: string): string {
  return `다른 곳의 변경과 겹친 편집 내용을 ‘${title}’에 보관했습니다. 시작 화면 → 이 앱의 문서에서 복구 사본을 열 수 있습니다.`;
}
