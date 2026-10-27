import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/lib/tabs";

const mocks = vi.hoisted(() => ({
  markDirty: vi.fn(),
  registerStudio: vi.fn(),
  registerFlusher: vi.fn(),
  registerPrintRenderer: vi.fn(),
  pushRevision: vi.fn(),
  getDocument: vi.fn(),
  downloadBytes: vi.fn(),
  upload: vi.fn(),
  loadFile: vi.fn(),
  exportDocx: vi.fn(),
  docxGeometry: vi.fn(),
  mountStudio: vi.fn(),
  startLiveSession: vi.fn(),
  update: null as null | ((args: { transaction: { docChanged: boolean } }) => void),
  editor: null as unknown,
  desktop: true,
}));
vi.mock("@/lib/shell", () => ({ useShell: () => shell }));
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
  api: {
    pushRevision: (...args: unknown[]) => mocks.pushRevision(...args),
    getDocument: (...args: unknown[]) => mocks.getDocument(...args),
    downloadBytes: (...args: unknown[]) => mocks.downloadBytes(...args),
    upload: (...args: unknown[]) => mocks.upload(...args),
    reportLayout: () => Promise.resolve(),
  },
}));
vi.mock("@/lib/desktop", () => ({ isDesktop: () => mocks.desktop }));
vi.mock("@/lib/agent-plugin", () => ({ createAgentBridge: () => ({}) }));
vi.mock("@/lib/live", () => ({ startLiveSession: (...args: unknown[]) => mocks.startLiveSession(...args) }));
vi.mock("@/lib/studio", () => ({
  ACTIVITY_EVENTS: ["keyup", "input", "compositionend", "pointerup", "paste", "cut", "drop"],
  STUDIO_ENGINE: "test",
  mountStudio: (...args: unknown[]) => mocks.mountStudio(...args),
  studioChangeSeq: (studio: { getSelectionContext: () => Promise<{ changeSeq: number }> }) => studio.getSelectionContext().then((ctx) => ctx.changeSeq),
  detectLocalFonts: () => Promise.resolve(),
  documentFiles: () => [],
  toArrayBuffer: (bytes: Uint8Array) => bytes.buffer,
}));
vi.mock("@tiptap/react", () => ({
  useEditor: (options: { onUpdate: typeof mocks.update }) => { mocks.update = options.onUpdate; return mocks.editor; },
  EditorContent: () => null,
}));
vi.mock("@tiptap/pm/state", () => ({ Selection: { near: () => ({}) } }));
vi.mock("@/lib/docx-engine", () => ({ openDocx: () => Promise.resolve({}) }));
vi.mock("@/lib/docx-editor", () => ({
  docxExtensions: () => [],
  docxContent: () => ({}),
  docxGeometry: (...args: unknown[]) => mocks.docxGeometry(...args),
  docxNotes: () => [],
  docxStyleSheet: () => "",
  docxFormatSource: () => ({}),
  docxContentChanged: () => {},
  exportDocx: (...args: unknown[]) => mocks.exportDocx(...args),
  DOCX_ENGINE: "test",
}));

import { HwpxEditor } from "./HwpxEditor";
import { DocxEditor } from "./DocxEditor";
import { ApiError } from "@/lib/api";

const shell = {
  markDirty: mocks.markDirty,
  registerStudio: mocks.registerStudio,
  registerFlusher: mocks.registerFlusher,
  registerPrintRenderer: mocks.registerPrintRenderer,
  notify: vi.fn(),
  openHelp: vi.fn(),
};
const tab: Tab = { id: "doc-1", title: "문서", filename: "문서.hwpx", format: "hwpx", dirty: false };
const noop = () => {};
let frame: HTMLIFrameElement;
let changeSeq: number;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = true;
  changeSeq = 0;
  frame = document.createElement("iframe");
  document.body.appendChild(frame);
  mocks.loadFile.mockResolvedValue({ pageCount: 1 });
  mocks.mountStudio.mockResolvedValue({
    element: frame,
    loadFile: mocks.loadFile,
    getSelectionContext: () => Promise.resolve({ changeSeq }),
    exportHwpx: () => Promise.resolve(new Uint8Array([80, 75, 1])),
    destroy: vi.fn(),
  });
  mocks.getDocument.mockResolvedValue({ revision_seq: 1 });
  mocks.downloadBytes.mockResolvedValue(new Uint8Array([80, 75]));
  mocks.upload.mockResolvedValue({ title: "문서 — 충돌 복구" });
  mocks.pushRevision.mockResolvedValue({ changed: true, revision_seq: 2 });
  mocks.exportDocx.mockResolvedValue({ bytes: new Uint8Array([80, 75, 2]), changed: 1 });
  mocks.docxGeometry.mockReturnValue(null);
  mocks.startLiveSession.mockReturnValue({ stop: vi.fn(), handle: vi.fn() });
  const tr = {
    doc: { content: { size: 2 }, resolve: () => ({}) },
    replaceWith: () => tr,
    setMeta: () => tr,
    setSelection: () => tr,
  };
  mocks.editor = {
    isDestroyed: false,
    state: { doc: { content: { size: 2 } }, selection: { from: 1, to: 1 }, storedMarks: null, tr },
    schema: { nodeFromJSON: () => ({ content: {} }) },
    view: { dispatch: vi.fn(), dom: document.createElement("div") },
  };
});
afterEach(() => {
  vi.useRealTimers();
  frame.remove();
});

describe("editor disk-save protection", () => {
  it("DOCX uses its own paper size for print only while its tab is active", async () => {
    mocks.docxGeometry.mockReturnValue({ vars: { "--page-w": "1122.53px", "--page-h": "793.73px" } });
    const props = { tab: { ...tab, filename: "문서.docx", format: "docx" as const }, lastEvent: null, onStatus: noop, onFormatSource: noop };
    const view = render(<DocxEditor {...props} active />);
    await waitFor(() => expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-ready", "1"));
    expect(view.container.querySelector("style[data-doc-page-size]")?.textContent).toContain("size: 1122.53px 793.73px; margin: 0;");
    view.rerender(<DocxEditor {...props} active={false} />);
    expect(view.container.querySelector("style[data-doc-page-size]")).toBeNull();
  });
  it("web HWPX iframe F1 opens the application help", async () => {
    mocks.desktop = false;
    render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={noop} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    const event = new KeyboardEvent("keydown", { key: "F1", cancelable: true });
    frame.contentWindow!.dispatchEvent(event);
    expect(shell.openHelp).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });
  it("HWPX input becomes dirty before the autosync delay; pointer-only activity stays clean", async () => {
    render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={noop} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    mocks.markDirty.mockClear();
    await act(async () => { frame.contentWindow!.dispatchEvent(new Event("pointerup")); });
    expect(mocks.markDirty).not.toHaveBeenCalled();
    frame.contentWindow!.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(mocks.markDirty).toHaveBeenCalledWith(tab.id);
    expect(mocks.pushRevision).not.toHaveBeenCalled();
  });

  it("HWPX explicit flush catches a change even before an activity timer fires", async () => {
    render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={noop} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    changeSeq = 1;
    const handle = mocks.registerStudio.mock.calls.find(([, value]) => value)?.[1];
    let synced = false;
    await act(async () => { synced = await handle.flush(); });
    expect(synced).toBe(true);
    expect(mocks.pushRevision).toHaveBeenCalledOnce();
    expect(mocks.markDirty).toHaveBeenCalledWith(tab.id);
    expect(mocks.markDirty).not.toHaveBeenCalledWith(tab.id, false);
  });

  it("DOCX autosync preserves the disk-unsaved indicator", async () => {
    render(<DocxEditor tab={{ ...tab, filename: "문서.docx", format: "docx" }} active lastEvent={null} onStatus={noop} onFormatSource={noop} />);
    await waitFor(() => expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-ready", "1"));
    mocks.markDirty.mockClear();
    vi.useFakeTimers();
    act(() => { mocks.update!({ transaction: { docChanged: true } }); });
    expect(mocks.markDirty).toHaveBeenCalledWith(tab.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(mocks.pushRevision).toHaveBeenCalledOnce();
    expect(mocks.markDirty).not.toHaveBeenCalledWith(tab.id, false);
  });

  it("DOCX external changes and accepted AI edits require a disk save", async () => {
    const props = { tab: { ...tab, filename: "문서.docx", format: "docx" as const }, active: true, onStatus: noop, onFormatSource: noop };
    const view = render(<DocxEditor {...props} lastEvent={null} />);
    await waitFor(() => expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-ready", "1"));
    mocks.markDirty.mockClear();
    const options = mocks.startLiveSession.mock.calls.at(-1)?.[0];
    options.onApplied();
    expect(mocks.markDirty).toHaveBeenCalledWith(tab.id);
    mocks.markDirty.mockClear();
    mocks.getDocument.mockResolvedValue({ revision_seq: 2 });
    view.rerender(<DocxEditor {...props} lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 2, actor: "user" }} />);
    await waitFor(() => expect(mocks.markDirty).toHaveBeenCalledWith(tab.id));
    expect(mocks.markDirty).not.toHaveBeenCalledWith(tab.id, false);
  });

  it("HWPX preserves pending local edits as a named recovery document before external reload", async () => {
    const view = render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={noop} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    changeSeq = 1;
    view.rerender(<HwpxEditor tab={tab} active lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 2, actor: "user" }} onStatus={noop} />);
    await waitFor(() => expect(mocks.loadFile).toHaveBeenCalledTimes(2));
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^문서 — 충돌 복구 .*\.hwpx$/));
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadFile.mock.invocationCallOrder[1]);
    expect(shell.notify).toHaveBeenCalledWith(expect.stringContaining("시작 화면 → 이 앱의 문서"));
  });

  it("HWPX keeps the editor untouched when its recovery upload fails", async () => {
    const view = render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={noop} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    mocks.upload.mockRejectedValue(new Error("offline"));
    changeSeq = 1;
    view.rerender(<HwpxEditor tab={tab} active lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 2, actor: "user" }} onStatus={noop} />);
    await waitFor(() => expect(shell.notify).toHaveBeenCalledWith(expect.stringContaining("편집 내용을 유지했습니다"), "error"));
    expect(mocks.loadFile).toHaveBeenCalledOnce();
    expect(mocks.downloadBytes).toHaveBeenCalledOnce();
  });

  it("HWPX does not replace typing that arrives while external bytes are downloading", async () => {
    const status = vi.fn();
    const view = render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={status} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    let completeDownload!: (bytes: Uint8Array) => void;
    mocks.downloadBytes.mockReturnValueOnce(new Promise<Uint8Array>((resolve) => { completeDownload = resolve; }));
    view.rerender(<HwpxEditor tab={tab} active lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 2, actor: "user" }} onStatus={status} />);
    await waitFor(() => expect(mocks.downloadBytes).toHaveBeenCalledTimes(2));
    changeSeq = 1;
    await act(async () => { completeDownload(new Uint8Array([80, 75, 3])); });
    expect(mocks.loadFile).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith({ error: expect.stringContaining("새로 입력한 내용을 유지했습니다") });
  });

  it("HWPX cancels an older conflict reload after a newer external reload finishes", async () => {
    const view = render(<HwpxEditor tab={tab} active lastEvent={null} onStatus={noop} />);
    await waitFor(() => expect(screen.getByTestId("studio-host")).toHaveAttribute("data-ready", "1"));
    changeSeq = 1;
    mocks.pushRevision.mockRejectedValueOnce(new ApiError(409, "stale"));
    mocks.getDocument.mockResolvedValue({ revision_seq: 2 });
    let completeOldDownload!: (bytes: Uint8Array) => void;
    mocks.downloadBytes.mockReturnValueOnce(new Promise<Uint8Array>((resolve) => { completeOldDownload = resolve; }));
    const handle = mocks.registerStudio.mock.calls.find(([, value]) => value)?.[1];
    await act(async () => { await handle.flush(); });
    await waitFor(() => expect(mocks.downloadBytes).toHaveBeenCalledTimes(2));
    view.rerender(<HwpxEditor tab={tab} active lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 3, actor: "user" }} onStatus={noop} />);
    await waitFor(() => expect(mocks.loadFile).toHaveBeenCalledTimes(2));
    await act(async () => { completeOldDownload(new Uint8Array([80, 75, 2])); });
    expect(mocks.loadFile).toHaveBeenCalledTimes(2);
  });

  it("DOCX 409 preserves a recovery copy before replacing local content", async () => {
    render(<DocxEditor tab={{ ...tab, filename: "문서.docx", format: "docx" }} active lastEvent={null} onStatus={noop} onFormatSource={noop} />);
    await waitFor(() => expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-ready", "1"));
    act(() => { mocks.update!({ transaction: { docChanged: true } }); });
    mocks.pushRevision.mockRejectedValueOnce(new ApiError(409, "stale"));
    mocks.getDocument.mockResolvedValue({ revision_seq: 2 });
    const flush = mocks.registerFlusher.mock.calls.find(([, value]) => value)?.[1];
    let result = true;
    await act(async () => { result = await flush(); });
    expect(result).toBe(false);
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^문서 — 충돌 복구 .*\.docx$/));
    const dispatch = (mocks.editor as { view: { dispatch: ReturnType<typeof vi.fn> } }).view.dispatch;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[1]);
    expect(shell.notify).toHaveBeenCalledWith(expect.stringContaining("시작 화면 → 이 앱의 문서"));
  });

  it("DOCX failed recovery blocks external reload and keeps dirty local content", async () => {
    const props = { tab: { ...tab, filename: "문서.docx", format: "docx" as const }, active: true, onStatus: noop, onFormatSource: noop };
    const view = render(<DocxEditor {...props} lastEvent={null} />);
    await waitFor(() => expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-ready", "1"));
    act(() => { mocks.update!({ transaction: { docChanged: true } }); });
    mocks.pushRevision.mockRejectedValue(new ApiError(409, "stale"));
    mocks.upload.mockRejectedValue(new Error("offline"));
    view.rerender(<DocxEditor {...props} lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 2, actor: "user" }} />);
    await waitFor(() => expect(shell.notify).toHaveBeenCalledWith(expect.stringContaining("편집 내용을 유지했습니다"), "error"));
    const dispatch = (mocks.editor as { view: { dispatch: ReturnType<typeof vi.fn> } }).view.dispatch;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(mocks.downloadBytes).toHaveBeenCalledOnce();
    const flush = mocks.registerFlusher.mock.calls.find(([, value]) => value)?.[1];
    let result = true;
    await act(async () => { result = await flush(); });
    expect(result).toBe(false);
    expect(mocks.pushRevision).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("DOCX keeps newer typing when it arrives during external download", async () => {
    const status = vi.fn();
    const props = { tab: { ...tab, filename: "문서.docx", format: "docx" as const }, active: true, onStatus: status, onFormatSource: noop };
    const view = render(<DocxEditor {...props} lastEvent={null} />);
    await waitFor(() => expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-ready", "1"));
    let completeDownload!: (bytes: Uint8Array) => void;
    mocks.downloadBytes.mockReturnValueOnce(new Promise<Uint8Array>((resolve) => { completeDownload = resolve; }));
    mocks.getDocument.mockResolvedValue({ revision_seq: 2 });
    view.rerender(<DocxEditor {...props} lastEvent={{ type: "edit", document_id: tab.id, revision_seq: 2, actor: "user" }} />);
    await waitFor(() => expect(mocks.downloadBytes).toHaveBeenCalledTimes(2));
    act(() => { mocks.update!({ transaction: { docChanged: true } }); });
    await act(async () => { completeDownload(new Uint8Array([80, 75, 3])); });
    expect((mocks.editor as { view: { dispatch: ReturnType<typeof vi.fn> } }).view.dispatch).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith({ error: expect.stringContaining("새로 입력한 내용을 유지했습니다") });
  });
});
