from pathlib import Path

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

    obs_ws_host: str = "localhost"
    obs_ws_port: int = 4455
    obs_ws_pass: str = ""
    obs_source_name: str = "RUNDOWN Overlay"

    db_path: Path = DATA_DIR / "rundown.db"
    raw_cache_dir: Path = DATA_DIR / "raw"
    logs_dir: Path = DATA_DIR / "logs"


settings = Settings()
