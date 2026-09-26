from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    anthropic_api_key: str = ""
    youtube_api_key: str = ""
    reddit_client_id: str = ""
    reddit_client_secret: str = ""
    reddit_user_agent: str = ""
    reddit_api_approved: bool = False
    retrieval_daily_limit: int = Field(default=20, ge=1, le=100)
    # Explicit isolated HTTP fixture; real credentials are never sent to it.
    retrieval_test_origin: str = ""

    obs_ws_host: str = "localhost"
    obs_ws_port: int = 4455
    obs_ws_pass: str = ""
    obs_source_name: str = "RUNDOWN Overlay"

    db_path: Path = DATA_DIR / "rundown.db"
    raw_cache_dir: Path = DATA_DIR / "raw"
    logs_dir: Path = DATA_DIR / "logs"
    # Managed upload files, served only by opaque id through /attachments.
    assets_dir: Path = DATA_DIR / "assets"

    # Explicit fixture origin for isolated verification only; empty in normal use.
    rss_test_feed_origin: str = ""

    rss_scheduler_enabled: bool = True
    rss_scheduler_poll_seconds: int = Field(default=5, ge=1, le=60)

    research_ai_enabled: bool = False
    research_ai_model: str = ""
    research_ai_daily_limit: int = Field(default=5, ge=1, le=100)

    preparation_enabled: bool = False
    preparation_model: str = ""
    preparation_daily_limit: int = Field(default=10, ge=1, le=100)
    # Isolated provider contract tests only; never forwards real credentials.
    preparation_test_origin: str = ""


settings = Settings()
