import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellApi } from "@/lib/shell";
import { workspace } from "@/lib/tabs";
import { AppShell } from "./AppShell";

const mocks = vi.hoisted(() => ({
  shell: null as ShellApi | null,
  undo: vi.fn(),
  downloadBytes: vi.fn(),
  rename: vi.fn(),
  saveFile: vi.fn(),
  setDocumentState: vi.fn(),
  printToPdf: vi.fn(),
  printHtml: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { ...actual.api, undo: mocks.undo, downloadBytes: mocks.downloadBytes, rename: mocks.rename } };
});
vi.mock("@/lib/desktop", () => ({
  desktopBridge: () => ({
    platform: "win32",
    version: "1.0.0",
    saveFile: mocks.saveFile,
    setDocumentState: mocks.setDocumentState,
    printToPdf: mocks.printToPdf,
    printHtml: mocks.printHtml,
    onMenu: () => () => {},
    onOpenFiles: () => () => {},
  }),
  isDesktop: () => true,
  downloadBytes: vi.fn(),
}));
vi.mock("@/lib/print", () => ({ buildPrintHtml: vi.fn(), collectPages: vi.fn() }));
vi.mock("@/lib/rhwp", () => ({ convertHwpToHwpx: vi.fn() }));
vi.mock("@/lib/studio", () => ({ runCommand: vi.fn() }));
vi.mock("./DocumentView", () => ({ DocumentView: () => null }));
vi.mock("./StartScreen", () => ({ StartScreen: () => null }));
vi.mock("./HelpDialog", () => ({ HelpDialog: () => null }));
vi.mock("./TabBar", async () => {
  const { useShell } = await import("@/lib/shell");
  return {
    TabBar: function ShellHarness() {
      mocks.shell = useShell();
      return null;
    },
  };
});

const document = { id: "word-1", title: "검토 문서", filename: "검토 문서.docx", format: "docx" as const };
const savedFile = { path: "C:\\documents\\검토 문서.docx", name: "검토 문서.docx" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderDocument() {
  workspace.open(document);
  render(<AppShell />);
  if (!mocks.shell) throw new Error("Shell harness was not mounted");
  return mocks.shell;
}

describe("AppShell 문서 변경 보관", () => {
  beforeEach(() => {
    workspace.reset();
    mocks.shell = null;
    mocks.undo.mockReset().mockResolvedValue({ revision_seq: 2 });
    mocks.downloadBytes.mockReset().mockResolvedValue(new Uint8Array([0x50, 0x4b, 1, 2]));
    mocks.rename.mockReset().mockResolvedValue(undefined);
    mocks.saveFile.mockReset().mockResolvedValue(savedFile);
    mocks.setDocumentState.mockClear();
    mocks.printToPdf.mockReset().mockResolvedValue(null);
    mocks.printHtml.mockReset().mockResolvedValue({ ok: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("DOCX PDF·인쇄는 현재 창 대신 편집기가 만든 실제 쪽 HTML을 전달한다", async () => {
    const shell = renderDocument();
    const render = vi.fn().mockResolvedValue("<html>physical document pages</html>");
    shell.registerPrintRenderer(document.id, render);
    await act(async () => { await shell.exportPdf(document.id); });
    expect(mocks.printToPdf).toHaveBeenCalledWith({ html: "<html>physical document pages</html>", suggestedName: "검토 문서.pdf" });
    await act(async () => { await shell.printDocument(document.id); });
    expect(mocks.printHtml).toHaveBeenCalledWith({ html: "<html>physical document pages</html>", title: document.title });
    render.mockRejectedValueOnce(new Error("인쇄용 쪽 구성 실패"));
    await act(async () => { await shell.exportPdf(document.id); });
    expect(mocks.printToPdf).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("인쇄용 쪽 구성 실패");
  });

  it("DOCX의 아직 반영되지 않은 편집을 보관한 다음 되돌린다", async () => {
    const shell = renderDocument();
    const pending = deferred<boolean>();
    const flush = vi.fn(() => pending.promise);
    shell.registerFlusher(document.id, flush);

    let undo!: Promise<void>;
    act(() => { undo = shell.undoAi(document.id); });
    expect(flush).toHaveBeenCalledOnce();
    expect(mocks.undo).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(true); await undo; });
    expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(document.id, 1);
  });

  it("DOCX 변경 보관이 실패하면 되돌리기를 실행하지 않는다", async () => {
    const shell = renderDocument();
    shell.registerFlusher(document.id, vi.fn().mockResolvedValue(false));

    await act(async () => { await shell.undoAi(document.id); });
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("보관하지 못해 되돌리지 않았습니다");
    expect(workspace.get().tabs).toHaveLength(1);
  });

  it("변경 보관이 실패하면 저장 안 됨 표시가 아직 없어도 탭을 닫지 않는다", async () => {
    const shell = renderDocument();
    const flush = vi.fn().mockResolvedValue(false);
    shell.registerFlusher(document.id, flush);
    expect(workspace.get().tabs[0].dirty).toBe(false);

    await act(async () => { await shell.closeTab(document.id); });
    expect(flush).toHaveBeenCalledOnce();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(workspace.get().tabs[0].id).toBe(document.id);
    expect(screen.getByRole("status")).toHaveTextContent("문서를 닫지 않았습니다");
  });

  it("저장 대화상자가 열린 동안 추가로 편집하면 dirty 상태와 탭을 유지한다", async () => {
    const shell = renderDocument();
    shell.registerFlusher(document.id, vi.fn().mockResolvedValue(true));
    const diskSave = deferred<typeof savedFile>();
    mocks.saveFile.mockReturnValueOnce(diskSave.promise);
    act(() => shell.markDirty(document.id));

    let closing!: Promise<void>;
    act(() => { closing = shell.closeTab(document.id); });
    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledOnce());
    // The document was already dirty before the dialog: another edit still has
    // to invalidate the saved snapshot even though the dirty flag stays true.
    act(() => shell.markDirty(document.id));
    await act(async () => { diskSave.resolve(savedFile); await closing; });

    expect(workspace.get().tabs).toHaveLength(1);
    expect(workspace.get().tabs[0]).toMatchObject({ id: document.id, dirty: true, path: savedFile.path });
    expect(screen.getByRole("status")).toHaveTextContent("저장 중 추가된 변경은 다시 저장하세요");

    // An explicit subsequent save with no newer edits may close the tab.
    await act(async () => { await shell.closeTab(document.id); });
    expect(mocks.saveFile).toHaveBeenCalledTimes(2);
    expect(workspace.get().tabs).toHaveLength(0);
  });
});
