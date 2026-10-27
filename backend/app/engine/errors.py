class EngineError(Exception):
    """문서를 읽거나 쓰는 과정에서 생긴 오류 (형식이 아니거나 망가진 파일)."""


class CommandError(Exception):
    """명령 입력이 문서 상태와 맞지 않을 때 (없는 블록 번호 등). AI에게 그대로 전달한다."""

    def __init__(self, message: str, code: str = "INVALID_ARGUMENT"):
        super().__init__(message)
        self.code = code
