import { describe, expect, it } from "vitest";
import { describeEvent, parseArguments, schemaToFields } from "./format";

const schema = {
  type: "object",
  properties: {
    document_id: { type: "string", minLength: 36, maxLength: 36 },
    from: { type: "integer", minimum: 1, maximum: 100000, description: "이 블록부터" },
    all: { type: "boolean" },
    cells: { type: "array", items: { type: "object" } },
  },
  required: ["document_id"],
  additionalProperties: false,
};

describe("schemaToFields", () => {
  it("maps schema properties to form fields with required flags and bounds", () => {
    const fields = schemaToFields(schema);
    expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ["document_id", "string", true],
      ["from", "integer", false],
      ["all", "boolean", false],
      ["cells", "json", false],
    ]);
    expect(fields[1].min).toBe(1);
    expect(fields[1].max).toBe(100000);
  });
});

describe("parseArguments", () => {
  const fields = schemaToFields(schema);
  it("omits empty optional fields and converts types", () => {
    const { args, errors } = parseArguments(fields, { document_id: "x", from: "3", all: "true", cells: '[{"row":1}]' });
    expect(errors).toEqual([]);
    expect(args).toEqual({ document_id: "x", from: 3, all: true, cells: [{ row: 1 }] });
  });
  it("reports missing required and malformed values", () => {
    const { errors } = parseArguments(fields, { from: "1.5", cells: "{" });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("document_id");
  });
});

describe("describeEvent", () => {
  it("formats edit and undo events", () => {
    expect(describeEvent({ type: "edit", document_id: "d", actor: "ai", revision_seq: 2, summary: "1곳을 바꿨습니다", blocks: [3] })).toBe("AI 편집 · 리비전 2 · 1곳을 바꿨습니다 (블록 3)");
    expect(describeEvent({ type: "undo", document_id: "d", actor: "user", revision_seq: 4, restores_seq: 1, steps: 2 })).toBe("사용자 되돌리기 2단계 → 리비전 4 (리비전 1 내용)");
    expect(describeEvent({ type: "activity", document_id: "d", actor: "ai", tool: "read_document", ok: true })).toBe("AI 도구 read_document 성공");
  });
});
