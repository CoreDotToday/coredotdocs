"""서버 쪽 rhwp 사이드카: Node에서 rhwp(MIT) WASM을 돌려 옛 HWP를 HWPX로 바꾼다 (설계 문서 04 §8.2-5).

브라우저 없이(외부 MCP 클라이언트가 HWP를 올릴 때, 데스크톱 앱의 백엔드) 변환이 되게 한다. Node가 없으면 None을 돌려주고
호출자는 전처럼 "한글에서 HWPX로 저장해 올려 달라"고 안내한다.

찾는 순서: EDITOR_NODE_BIN(데스크톱 앱은 Electron 실행 파일 + ELECTRON_RUN_AS_NODE=1) → PATH의 node.
엔진 폴더: EDITOR_RHWP_DIR(rhwp.js·rhwp_bg.wasm) → frontend/public/rhwp-core (저장소 안에서 돌 때).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .errors import EngineError

SCRIPT = Path(__file__).with_name("rhwp_convert.mjs")
TIMEOUT_S = 60


def node_bin() -> str | None:
    env = os.environ.get("EDITOR_NODE_BIN")
    if env and Path(env).exists():
        return env
    return shutil.which("node")


def rhwp_dir() -> Path | None:
    env = os.environ.get("EDITOR_RHWP_DIR")
    candidates = [Path(env)] if env else []
    candidates.append(Path(__file__).resolve().parents[3] / "frontend" / "public" / "rhwp-core")
    for c in candidates:
        if (c / "rhwp.js").exists() and (c / "rhwp_bg.wasm").exists():
            return c
    return None


def available() -> bool:
    return node_bin() is not None and rhwp_dir() is not None and SCRIPT.exists()


def convert(data: bytes, to: str) -> bytes | None:
    """to는 'hwpx' 또는 'hwp'. 사이드카를 쓸 수 없으면 None, 변환이 실패하면 EngineError."""
    node = node_bin()
    engine = rhwp_dir()
    if node is None or engine is None or not SCRIPT.exists():
        return None
    with tempfile.TemporaryDirectory(prefix="cdd-rhwp-") as tmp:
        src = Path(tmp) / f"in.{'hwp' if to == 'hwpx' else 'hwpx'}"
        dst = Path(tmp) / f"out.{to}"
        src.write_bytes(data)
        env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
        try:
            proc = subprocess.run([node, str(SCRIPT), str(engine), to, str(src), str(dst)], capture_output=True, text=True, timeout=TIMEOUT_S, env=env, check=False)
        except subprocess.TimeoutExpired as e:
            raise EngineError("HWP 변환이 제한 시간을 넘겼습니다.") from e
        if proc.returncode != 0 or not dst.exists():
            lines = [ln for ln in (proc.stderr or proc.stdout or "").strip().splitlines() if ln.strip() and "trace-uncaught" not in ln and not ln.startswith("(node:")]
            detail = " | ".join(lines[:2] + (["…"] if len(lines) > 4 else []) + lines[-2:]) if len(lines) > 4 else " | ".join(lines)
            raise EngineError(f"HWP를 HWPX로 바꾸지 못했습니다: {detail[:400]}")
        return dst.read_bytes()


def hwp_to_hwpx(data: bytes) -> bytes | None:
    return convert(data, "hwpx")
