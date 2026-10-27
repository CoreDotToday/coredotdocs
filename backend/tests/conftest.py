"""테스트 공용 픽스처. 독립 구현이므로 샘플 HWPX도 원본 리소스를 쓰지 않고 여기서 직접 만든다."""

from __future__ import annotations

import io
import zipfile

import pytest

HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HS = "http://www.hancom.co.kr/hwpml/2011/section"
HC = "http://www.hancom.co.kr/hwpml/2011/core"
OPF = "http://www.idpf.org/2007/opf/"

from app.engine.blank import header_xml

HEADER_XML = header_xml()

CONTENT_HPF = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<opf:package xmlns:opf="{OPF}" version="" unique-identifier="" id="">
<opf:manifest>
<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
</opf:manifest>
<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>
</opf:package>"""


def paragraph(text: str, char_pr: str = "0", para_pr: str = "0", extra: str = "") -> str:
    runs = f'<hp:run charPrIDRef="{char_pr}">{extra}<hp:t>{text}</hp:t></hp:run>' if text or extra else f'<hp:run charPrIDRef="{char_pr}"/>'
    return f'<hp:p paraPrIDRef="{para_pr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">{runs}</hp:p>'


def table(rows: list[list[str]], spans: dict[tuple[int, int], tuple[int, int]] | None = None) -> str:
    """rows[r][c]가 None이면 합친 칸에 덮인 자리."""
    spans = spans or {}
    trs = []
    for r, row in enumerate(rows):
        tcs = []
        for c, text in enumerate(row):
            if text is None:
                continue
            rs, cs = spans.get((r, c), (1, 1))
            tcs.append(
                f'<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1">'
                f'<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
                f"{paragraph(text)}</hp:subList>"
                f'<hp:cellAddr colAddr="{c}" rowAddr="{r}"/><hp:cellSpan colSpan="{cs}" rowSpan="{rs}"/>'
                f'<hp:cellSz width="10000" height="1000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>'
            )
        trs.append("<hp:tr>" + "".join(tcs) + "</hp:tr>")
    cols = max(len(r) for r in rows)
    tbl = f'<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="{len(rows)}" colCnt="{cols}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">{"".join(trs)}</hp:tbl>'
    return f'<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">{tbl}</hp:run></hp:p>'


def section_xml(body: str) -> str:
    sec_pr = '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr></hp:secPr>'
    first = paragraph("", extra=sec_pr)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<hs:sec xmlns:hs="{HS}" xmlns:hp="{HP}" xmlns:hc="{HC}">{first}{body}</hs:sec>'
    )


def build_hwpx(body_xml: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("version.xml", '<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" major="5" minor="1" micro="1" buildNumber="0"/>', compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("Contents/header.xml", HEADER_XML, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("Contents/section0.xml", section_xml(body_xml), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("Contents/content.hpf", CONTENT_HPF, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("META-INF/container.xml", '<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>', compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


@pytest.fixture
def sample_body() -> str:
    """[1] 구역 설정 문단(빈) [2] 제목 [3] 본문 hello [4] 표 1 (2×2) [5] 빈 문단"""
    return (
        paragraph("AI 편집 샘플", char_pr="1", para_pr="1")
        + paragraph("이 문서는 관측용 샘플입니다 hello")
        + table([["구분", "내용"], ["가", "나"]])
        + paragraph("")
    )


@pytest.fixture
def sample_hwpx(sample_body: str) -> bytes:
    return build_hwpx(sample_body)


@pytest.fixture
def multi_run_hwpx() -> bytes:
    """한 문단이 여러 run으로 나뉜 경우: '앞 ' + '굵은 글' + ' 뒤'"""
    body = (
        '<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'
        '<hp:run charPrIDRef="0"><hp:t>앞 </hp:t></hp:run>'
        '<hp:run charPrIDRef="2"><hp:t>굵은 글</hp:t></hp:run>'
        '<hp:run charPrIDRef="0"><hp:t> 뒤</hp:t></hp:run></hp:p>'
    )
    return build_hwpx(body)


@pytest.fixture
def merged_table_hwpx() -> bytes:
    """2×3 표에서 (1,1)~(1,2)를 가로로 합침."""
    body = table([["머리", None, "셋"], ["a", "b", "c"]], spans={(0, 0): (1, 2)})
    return build_hwpx(body)


@pytest.fixture
def client_with_doc(sample_hwpx):
    """PostgreSQL이 있는 통합 테스트용: 앱 클라이언트 + 샘플 문서 ID. (test_api의 모듈 픽스처와 독립)"""
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    from app.db import engine
    from app.main import app

    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except Exception as e:  # pragma: no cover
        pytest.skip(f"PostgreSQL에 연결할 수 없습니다: {e}")
    with TestClient(app, base_url="http://127.0.0.1") as c:
        r = c.post("/api/documents", files={"file": ("sample.hwpx", sample_hwpx, "application/hwp+zip")})
        assert r.status_code == 201, r.text
        yield c, r.json()["id"]
