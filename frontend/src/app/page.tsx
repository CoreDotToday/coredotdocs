import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ doc?: string }> }) {
  const { doc } = await searchParams;
  return <AppShell initialDocId={doc} />;
}
