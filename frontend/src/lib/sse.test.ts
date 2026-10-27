import { describe, expect, it } from "vitest";
import { parseSseChunk, readSse } from "./sse";

describe("parseSseChunk", () => {
  it("완성된 이벤트만 넘기고 나머지는 남긴다", () => {
    const { events, rest } = parseSseChunk("event: text\ndata: {\"a\":1}\n\n: keep-alive\n\nevent: done\ndata: {}\n\nevent: part");
    expect(events).toEqual([
      { event: "text", data: '{"a":1}' },
      { event: "done", data: "{}" },
    ]);
    expect(rest).toBe("event: part");
  });
});

describe("readSse", () => {
  it("스트림을 이벤트로 바꾼다", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("event: tool_call\ndata: {\"name\":\"read_document\"}\n\nevent: te"));
        c.enqueue(encoder.encode("xt\ndata: {\"text\":\"안녕\"}\n\n"));
        c.close();
      },
    });
    const got: string[] = [];
    await readSse(new Response(stream), (e) => got.push(`${e.event}:${e.data}`));
    expect(got).toEqual(['tool_call:{"name":"read_document"}', 'text:{"text":"안녕"}']);
  });
});
