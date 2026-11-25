import os
from pathlib import Path


class Settings:
    """All configuration comes from environment variables (see .env.example)."""

    def __init__(self) -> None:
        self.data_dir = Path(os.getenv("DATA_DIR", "./data")).resolve()
        self.api_key = os.getenv("API_KEY", "")
        self.allow_no_auth = os.getenv("REELHOUSE_ALLOW_NO_AUTH") == "1"
        self.max_upload_mb = int(os.getenv("MAX_UPLOAD_MB", "500"))
        self.max_duration_s = float(os.getenv("MAX_DURATION_S", "600"))
        self.workers = max(1, int(os.getenv("WORKERS", "1")))
        self.ffmpeg_timeout_s = int(os.getenv("FFMPEG_TIMEOUT_S", "1800"))
        self.job_ttl_hours = float(os.getenv("JOB_TTL_HOURS", "72"))
        self.font_path = os.getenv("FONT_PATH", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
        self.public_base_url = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
        self.cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
