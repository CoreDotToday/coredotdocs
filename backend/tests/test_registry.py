import json

from app.tools import registry

DOC = "11111111-2222-4333-8444-555555555555"


def v(name, args):
    return registry.validate(name, args)


def test_every_tool_schema_is_closed_and_bounded():
    for tool in registry.TOOLS:
        schema = tool["inputSchema"]
        assert schema["additionalProperties"] is False, tool["name"]
        stack = [schema]
        while stack:
            node = stack.pop()
            types = node.get("type")
            types = types if isinstance(types, list) else [types]
            if "integer" in types or "number" in types:
                assert "minimum" in node and "maximum" in node, (tool["name"], node)
            if "string" in types and "enum" not in node:
                assert "maxLength" in node, (tool["name"], node)
            if isinstance(node.get("additionalProperties"), dict):
                stack.append(node["additionalProperties"])
            if node.get("type") == "array":
                assert "maxItems" in node, (tool["name"], node)
            stack.extend(node.get("properties", {}).values())
            if "items" in node:
                stack.append(node["items"])


def test_valid_calls_pass():
    assert v("read_document", {"document_id": DOC}) is None
    assert v("replace_text", {"document_id": DOC, "find": "a", "replace": ""}) is None
    assert v("set_table_cells", {"document_id": DOC, "table": 1, "cells": [{"row": 1, "col": 1, "text": "x"}]}) is None
    assert v("insert_content", {"document_id": DOC, "markdown": "x", "after": 0}) is None


def test_bounds_reject_values_the_original_accepted():
    assert "maximum" in v("read_document", {"document_id": DOC, "from": 10**15})
    assert v("find_text", {"query": "a" * 501}) is not None
    assert v("replace_text", {"document_id": DOC, "find": "", "replace": "x"}) is not None
    assert v("undo_last_edit", {"document_id": DOC, "steps": 51}) is not None
    assert v("undo_last_edit", {"document_id": DOC, "steps": 1.5}) is not None
    assert "Additional properties" in v("read_document", {"document_id": DOC, "expectedLoadId": 1})
    assert v("set_table_cells", {"document_id": DOC, "table": 1, "cells": [{"row": 1, "col": 1, "format": {}}]}) is not None
    assert v("format_text", {"document_id": DOC, "find": "a", "color": "red"}) is not None
    assert v("format_text", {"document_id": DOC, "find": "a", "size": -5}) is not None
    assert v("format_paragraphs", {"document_id": DOC, "from": 1, "left": 1e308}) is not None
    assert v("insert_image", {"document_id": DOC, "image_id": DOC, "width_mm": -1}) is not None
    assert v("read_document", {"document_id": DOC, "table": "../../x"}) is not None
    assert v("read_document", {"document_id": DOC, "table": "1-2"}) is None
    assert v("set_table_cells", {"document_id": DOC, "table": 1, "cells": []}) is not None


def test_prototype_like_keys_are_rejected_as_additional():
    args = json.loads('{"document_id": "%s", "__proto__": {"polluted": 1}}' % DOC)
    assert "Additional properties" in v("read_document", args)


def test_tools_list_is_json_serializable_mcp_shape():
    payload = json.dumps({"tools": registry.TOOLS})
    assert '"inputSchema"' in payload
    assert len(registry.tool_names()) == 32  # 선택 3 + 편집기 전용 7 + 쪽 설정 + 설치 글꼴
