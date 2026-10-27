from app import fonts


def setup_function():
    fonts.set_fonts([])


def test_normalize_maps_localized_name_to_family_and_notes_unknown():
    assert fonts.normalize("에이투지체") == ("에이투지체", None)  # 목록 없음: 그대로, 안내 없음
    fonts.set_fonts([fonts.Font("A2Z", "에이투지체"), fonts.Font("Noto Sans KR", "본고딕"), fonts.Font("A2Z", "중복")])
    assert fonts.normalize("에이투지체") == ("A2Z", None)
    assert fonts.normalize("a2z")[0] == "A2Z"
    assert fonts.normalize(" 에이투지 체 ")[0] == "A2Z"
    name, note = fonts.normalize("없는글꼴")
    assert name == "없는글꼴" and note and "list_fonts" in note
    rows, total = fonts.search("노토", 10)
    assert total == 0
    rows, total = fonts.search("sans", 10)
    assert [f.family for f in rows] == ["Noto Sans KR"] and total == 1
    assert len(fonts.fonts()) == 2  # 가족명 중복은 하나로


def test_fonts_api_and_tool(client_with_doc):
    client, doc_id = client_with_doc
    text = client.post("/api/tools/list_fonts", json={"arguments": {}}).json()["content"][0]["text"]
    assert "받지 못했습니다" in text
    r = client.post("/api/fonts", json={"fonts": [{"family": "A2Z", "localized": "에이투지체"}, {"family": "Arial"}]})
    assert r.status_code == 200 and r.json()["count"] == 2
    assert client.get("/api/fonts").json()["fonts"][0]["family"] == "Arial"
    text = client.post("/api/tools/list_fonts", json={"arguments": {"query": "투지"}}).json()["content"][0]["text"]
    assert "- A2Z  (에이투지체)" in text and "가족명" in text
    # 편집 도구의 font는 가족명으로 바뀌어 저장되고, 모르는 이름은 안내가 붙는다
    body = client.post("/api/tools/format_paragraphs", json={"arguments": {"document_id": doc_id, "all": True, "font": "에이투지체"}}).json()
    assert not body.get("isError"), body
    assert "문서 전체" in body["content"][0]["text"] and "주의" not in body["content"][0]["text"]
    body = client.post("/api/tools/format_text", json={"arguments": {"document_id": doc_id, "find": "hello", "font": "없는글꼴"}}).json()
    assert not body.get("isError"), body
    assert "주의: '없는글꼴'" in body["content"][0]["text"]
