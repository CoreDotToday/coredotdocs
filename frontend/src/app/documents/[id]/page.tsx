import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

/** 예전 주소(/documents/{id}) 호환: 셸을 띄우고 그 문서를 탭으로 연다. */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell initialDocId={id} />;
}
