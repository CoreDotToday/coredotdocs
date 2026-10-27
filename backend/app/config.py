from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EDITOR_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://coredotdocs:coredotdocs@127.0.0.1:5441/coredotdocs"
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    # DNS rebinding 방지. Docker 내부 서비스 이름은 배포 설정에서 명시적으로 추가한다.
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "::1"]
    # 로컬 UI의 토큰 없는 도구 호출을 허용할지. 도구 호출 정책이며 전체 API 인증을 제공하지 않는다.
    allow_anonymous_tools: bool = True
    output_limit: int = 24_000
    max_upload_bytes: int = 50 * 1024 * 1024
    # 앱 내 LLM 채팅 (core.today 게이트웨이). 키는 요청마다 X-CDT-Key로 받고 저장하지 않는다.
    # EDITOR_CDT_API_KEY는 키를 넣지 않은 요청의 대체값(개발·테스트용)이다.
    cdt_api_base: str = "https://api.core.today"
    cdt_api_key: str | None = None
    chat_max_rounds: int = 12
    chat_max_tokens: int = 4096


settings = Settings()
