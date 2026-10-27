import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY, pushRecent, reduceClose, reduceOpen, reduceUpdate, workspace } from "./tabs";

const a = { id: "a", title: "A", filename: "a.hwpx", format: "hwpx" as const };
const b = { id: "b", title: "B", filename: "b.docx", format: "docx" as const, path: "/tmp/b.docx" };

describe("탭 전이", () => {
  it("열면 활성 탭이 되고 최근 목록 맨 앞에 온다", () => {
    const s = reduceOpen(reduceOpen(EMPTY, a), b);
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(s.activeId).toBe("b");
    expect(s.recent.map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("이미 열린 탭을 다시 열면 중복되지 않고 dirty를 지킨다", () => {
    let s = reduceOpen(EMPTY, a);
    s = reduceUpdate(s, "a", { dirty: true });
    s = reduceOpen(s, { ...a, title: "A2" });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ title: "A2", dirty: true });
  });
  it("활성 탭을 닫으면 이웃 탭이 활성화된다", () => {
    let s = reduceOpen(reduceOpen(reduceOpen(EMPTY, a), b), { id: "c", title: "C", filename: "c.hwpx", format: "hwpx" });
    s = { ...s, activeId: "b" };
    s = reduceClose(s, "b");
    expect(s.activeId).toBe("c");
    s = reduceClose(s, "c");
    expect(s.activeId).toBe("a");
    s = reduceClose(s, "a");
    expect(s.activeId).toBeNull();
    expect(reduceClose(s, "zzz")).toBe(s);
  });
  it("경로가 바뀌면 최근 목록도 따라간다", () => {
    let s = reduceOpen(EMPTY, a);
    s = reduceUpdate(s, "a", { path: "/docs/a.hwpx", filename: "a.hwpx", title: "a" });
    expect(s.recent[0]).toMatchObject({ path: "/docs/a.hwpx", title: "a" });
  });
  it("최근 목록은 같은 id·경로를 합치고 상한을 지킨다", () => {
    let list = pushRecent([], { ...b, at: 1 });
    list = pushRecent(list, { id: "x", title: "X", filename: "x.docx", format: "docx", path: "/tmp/b.docx", at: 2 });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("x");
    for (let i = 0; i < 30; i++) list = pushRecent(list, { id: `r${i}`, title: "r", filename: "r.hwpx", format: "hwpx", at: i });
    expect(list).toHaveLength(20);
  });
});

describe("workspace 저장소", () => {
  beforeEach(() => workspace.reset());
  it("다시 읽어도 디스크에 저장하지 않은 상태를 유지한다", () => {
    workspace.open(a);
    workspace.update("a", { dirty: true });
    expect(workspace.get().tabs[0].dirty).toBe(true);
    const raw = JSON.parse(localStorage.getItem("coredotdocs.workspace")!);
    expect(raw.tabs[0].id).toBe("a");
    // 새로 읽기
    (workspace as unknown as { reset: () => void }).reset();
    localStorage.setItem("coredotdocs.workspace", JSON.stringify(raw));
    expect(workspace.get().tabs[0].dirty).toBe(true);
    expect(workspace.get().activeId).toBe("a");
  });
  it("저장된 탭과 이전 형식의 탭은 저장 안 됨으로 바꾸지 않는다", () => {
    localStorage.setItem("coredotdocs.workspace", JSON.stringify({ tabs: [{ ...a, dirty: false }, b], activeId: "a" }));
    expect(workspace.get().tabs.map((t) => t.dirty)).toEqual([false, false]);
  });
});
