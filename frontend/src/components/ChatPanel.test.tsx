import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chatMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    chatModels: () => Promise.resolve({ models: [{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic" }], default: "claude-sonnet-5-5", docs: "" }),
    checkKey: (key: string) => (key.startsWith("cdt_") ? Promise.resolve({ ok: true, key_hint: "cdt_ab…cdef" }) : Promise.reject(new Error("401 키가 올바르지 않습니다"))),
    chat: (...args: unknown[]) => chatMock(...args),
    chatHistory: () => Promise.resolve({ messages: [] }),
    clearChatHistory: () => Promise.resolve({ ok: true }),
  },
}));

import { ChatPanel } from "./ChatPanel";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((ch) => c.enqueue(encoder.encode(ch)));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("ChatPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    chatMock.mockReset();
  });

  it("키를 확인해 저장하고, 대화·도구 호출·결과를 보여 준다", async () => {
    const onChanged = vi.fn();
    render(<ChatPanel documentId="doc-1" onChanged={onChanged} />);
    const keyInput = screen.getByLabelText("core.today API 키");
    fireEvent.change(keyInput, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "키 저장·확인" }));
    await screen.findByText(/올바르지 않습니다/);
    fireEvent.change(keyInput, { target: { value: "cdt_abcdef" } });
    fireEvent.click(screen.getByRole("button", { name: "키 저장·확인" }));
    await screen.findByLabelText("AI에게 보낼 글");
    expect(localStorage.getItem("cdt_api_key")).toBe("cdt_abcdef");

    chatMock.mockResolvedValue(
      sseResponse([
        'event: tool_call\ndata: {"id":"t1","name":"set_paragraph_text","arguments":{"document_id":"doc-1","block":2,"text":"새 글"}}\n\n',
        'event: tool_result\ndata: {"id":"t1","name":"set_paragraph_text","ok":true,"text":"→ 리비전 2로 저장되었습니다."}\n\n',
        'event: text\ndata: {"text":"2번 블록을 고쳤습니다."}\n\nevent: done\ndata: {"usage":{"input_tokens":12,"output_tokens":3},"model":"claude-sonnet-5-5"}\n\nevent: end\ndata: {"type":"end"}\n\n',
      ]),
    );
    fireEvent.change(screen.getByLabelText("AI에게 보낼 글"), { target: { value: "2번 블록 고쳐줘" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("2번 블록을 고쳤습니다.");
    expect(chatMock).toHaveBeenCalledWith("cdt_abcdef", { document_id: "doc-1", model: "claude-sonnet-5-5", message: "2번 블록 고쳐줘", selection: null }, expect.anything()); // history는 서버 기록을 쓴다 (6차-2)
    expect(screen.getByTestId("chat-tool")).toHaveTextContent("도구 set_paragraph_text ✓");
    expect(screen.getByText(/입력 12 \/ 출력 3 토큰/)).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    // 다음 메시지도 history를 싣지 않는다 — 앞 대화는 서버의 문서별 기록이 맡는다 (6차-2)
    chatMock.mockResolvedValue(sseResponse(['event: text\ndata: {"text":"네."}\n\nevent: end\ndata: {}\n\n']));
    fireEvent.change(screen.getByLabelText("AI에게 보낼 글"), { target: { value: "고마워" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("네.");
    expect(chatMock.mock.calls[1][1]).toEqual({ document_id: "doc-1", model: "claude-sonnet-5-5", message: "고마워", selection: null });
    expect(screen.getByText("2번 블록 고쳐줘")).toBeInTheDocument(); // 화면의 대화는 그대로 남는다
  });

  it("게이트웨이 오류 이벤트를 보여 준다", async () => {
    localStorage.setItem("cdt_api_key", "cdt_saved");
    render(<ChatPanel documentId="doc-1" onChanged={() => {}} />);
    chatMock.mockResolvedValue(sseResponse(['event: error\ndata: {"status":402,"message":"크레딧이 부족합니다."}\n\nevent: end\ndata: {}\n\n']));
    fireEvent.change(await screen.findByLabelText("AI에게 보낼 글"), { target: { value: "안녕" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("크레딧이 부족합니다.");
  });
});
