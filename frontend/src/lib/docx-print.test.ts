import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDocxPrintHtml, embedPrintResources } from "./docx-print";

afterEach(() => vi.unstubAllGlobals());

describe("DOCX standalone print document", () => {
  it("keeps each paper size and its exact canvas offset, with no trailing forced page", () => {
    const html = buildDocxPrintHtml("<p>body</p>", [
      { x: 164.4, y: 0, width: 793.7333, height: 1122.5333, header: "HEAD_1", footer: "FOOT_1", notes: "NOTE_1" },
      { x: 0, y: 1150.5333, width: 1122.5333, height: 793.7333, header: "HEAD_2", footer: "FOOT_2", notes: "" },
    ], "p{color:black}", "<title>", 'scope"quoted', "Times New Roman");
    expect(html).toContain("@page cdd210x297{size:210mm 297mm;margin:0}");
    expect(html).toContain("@page cdd297x210{size:297mm 210mm;margin:0}");
    expect(html).toContain("left:-164.4px;top:0px");
    expect(html).toContain("left:0px;top:-1150.5333px");
    expect(html).toContain(".cdd-print-sheet:last-child{break-after:auto}");
    expect(html).toContain("<title>&lt;title&gt;</title>");
    expect(html).toContain('data-cdd-doc="scope&quot;quoted"');
    expect(html).toContain("HEAD_1FOOT_1NOTE_1");
    expect(html).toContain("font-src data:");
  });

  it("embeds a shared local font/image once and removes active or editor-only elements", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["asset"], { type: "image/png" }) });
    vi.stubGlobal("fetch", fetch);
    const root = document.createElement("div");
    root.innerHTML = '<script>unsafe()</script><iframe></iframe><img><img src="/asset.png" onerror="unsafe()"><p contenteditable="true" style="background-image:url(/asset.png)">body</p>';
    const css = await embedPrintResources('@font-face{src:url("/asset.png")}', [root]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("img")?.src).toMatch(/^data:image\/png;base64,/);
    expect(root.querySelector("script,iframe,[onerror],[contenteditable]")).toBeNull();
    expect(css).toContain("data:image/png;base64,");
  });

  it("does not request unembedded external assets when creating the print document", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(embedPrintResources('p{background:url("https://external.example/track.png")}', [])).rejects.toThrow("외부 이미지 또는 글꼴");
    expect(fetch).not.toHaveBeenCalled();
  });
});
