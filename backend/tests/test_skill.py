"""스킬 문서(skills/coredotdocs/SKILL.md)는 도구 레지스트리에서 생성되고, 레지스트리와 어긋나면 실패한다. 버전은 서버 버전 이상이어야 한다."""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import gen_skill  # noqa: E402

from app.mcp_stdio import SERVER_INFO
from app.tools import registry


def test_skill_matches_registry():
    assert gen_skill.OUT.exists(), "uv run python scripts/gen_skill.py 로 먼저 만드세요"
    text = gen_skill.OUT.read_text(encoding="utf-8")
    assert text == gen_skill.render(), "SKILL.md가 레지스트리와 다릅니다. scripts/gen_skill.py를 다시 실행하세요."
    for t in registry.TOOLS:
        assert f"`{t['name']}`" in text
    for code, _, _ in gen_skill.ERROR_CODES:
        assert f"`{code}`" in text


def test_skill_version_and_size():
    text = gen_skill.OUT.read_text(encoding="utf-8")
    m = re.search(r"^  version: (\d+)\.(\d+)\.(\d+)$", text, re.M)
    assert m, "frontmatter metadata.version이 없습니다"
    assert tuple(map(int, m.groups())) >= (1, 0, 0)
    assert SERVER_INFO["version"] in text
    assert len(text.encode()) < 64 * 1024  # 도구 설명 총량 상한 (이음오피스 91KiB 규칙의 우리 판)


def test_all_runner_error_codes_are_documented():
    """runner·commands·service가 내는 코드는 모두 스킬 표에 있어야 한다."""
    src = ""
    for p in (Path("app/tools/runner.py"), Path("app/engine/commands.py"), Path("app/services/documents.py"), Path("app/engine/errors.py")):
        src += p.read_text(encoding="utf-8")
    used = set(re.findall(r'"([A-Z_]{4,})"\)', src)) | set(re.findall(r'CommandError\([^)]*?,\s*"([A-Z_]+)"', src))
    documented = {c for c, _, _ in gen_skill.ERROR_CODES}
    assert used <= documented, f"스킬 표에 없는 코드: {used - documented}"
