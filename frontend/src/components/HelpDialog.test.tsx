import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HelpDialog } from "./HelpDialog";

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined }));

// jsdom does not implement the native dialog lifecycle or scrolling. Keep the
// open attribute and real focus behavior so navigation and cleanup stay testable.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterAll(() => {
  for (const [prototype, property, descriptor] of [
    [HTMLDialogElement.prototype, "showModal", originalShowModal],
    [HTMLDialogElement.prototype, "close", originalClose],
    [HTMLElement.prototype, "scrollTo", originalScrollTo],
  ] as const) {
    if (descriptor) Object.defineProperty(prototype, property, descriptor);
    else Reflect.deleteProperty(prototype, property);
  }
});

describe("HelpDialog", () => {
  it("주제를 이동하고 검색 결과에서 원하는 안내를 연다", () => {
    render(<HelpDialog initialSection="start" onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "코어닷독스 사용 안내" });
    const search = within(dialog).getByRole("searchbox", { name: "도움말 검색" });
    expect(search).toHaveFocus();
    expect(within(dialog).getByRole("heading", { level: 2, name: "처음 시작하기" })).toBeInTheDocument();

    const navigation = within(dialog).getByRole("navigation", { name: "도움말 주제" });
    const files = within(navigation).getByRole("button", { name: "열기와 저장" });
    fireEvent.click(files);
    expect(files).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByRole("heading", { level: 2, name: "열기와 저장" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "API 키" } });
    expect(within(dialog).getByRole("status")).toHaveTextContent("API 키");
    expect(files).not.toHaveAttribute("aria-current");
    fireEvent.click(within(dialog).getByRole("button", { name: /API 키 설정, 요청 작성/ }));
    expect(search).toHaveValue("");
    expect(within(dialog).getByRole("heading", { level: 2, name: "AI와 함께 편집" })).toBeInTheDocument();
  });

  it("검색 결과가 없을 때 검색어를 지우거나 처음 안내로 돌아갈 수 있다", () => {
    render(<HelpDialog initialSection="files" onClose={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "도움말 검색" });
    fireEvent.change(search, { target: { value: "없는도움말-9182" } });
    expect(screen.getByText("일치하는 도움말이 없습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: "열기와 저장" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "없는도움말-9182" } });
    fireEvent.click(screen.getByRole("button", { name: "처음 사용하기" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("heading", { level: 2, name: "처음 시작하기" })).toBeInTheDocument();
  });

  it("정보에서 현재 1.0.0 버전과 프로젝트의 GitHub 릴리스를 안내한다", () => {
    render(<HelpDialog initialSection="about" onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "코어닷독스 사용 안내" });
    expect(within(dialog).getByRole("heading", { level: 2, name: "코어닷독스 정보" })).toBeInTheDocument();
    expect(within(dialog).getAllByText("1.0.0").length).toBeGreaterThan(0);
    const releases = within(dialog).getByRole("link", { name: "GitHub 릴리스 및 변경 사항 보기" });
    expect(releases).toHaveAttribute("href", "https://github.com/CoreDotToday/coredotdocs/releases");
    expect(releases).toHaveAttribute("target", "_blank");
    expect(releases).toHaveAttribute("rel", "noreferrer");
    expect(dialog).not.toHaveTextContent(/rhwp/i);
  });

  it.each(["닫기 버튼", "네이티브 취소"])("%s로 닫으면 호출한 버튼으로 초점을 돌려준다", (method) => {
    const onClose = vi.fn();
    function Launcher() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>사용 안내 열기</button>
        {open && <HelpDialog initialSection="start" onClose={() => { onClose(); setOpen(false); }} />}
      </>;
    }
    render(<Launcher />);
    const launcher = screen.getByRole("button", { name: "사용 안내 열기" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "코어닷독스 사용 안내" });
    expect(screen.getByRole("searchbox", { name: "도움말 검색" })).toHaveFocus();

    if (method === "닫기 버튼") fireEvent.click(within(dialog).getByRole("button", { name: "도움말 닫기" }));
    else {
      const cancel = new Event("cancel", { cancelable: true });
      fireEvent(dialog, cancel);
      expect(cancel.defaultPrevented).toBe(true);
    }

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();
  });
});
