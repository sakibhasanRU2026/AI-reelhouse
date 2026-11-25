import hashlib
import json
import logging
import os
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import Settings
from .media import MediaError, probe
from .pipeline import render
from .schemas import Instructions

log = logging.getLogger("reelhouse")
now_iso = lambda: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class JobStore:
    """One folder per job (data/jobs/<id>/): input file, job.json, output.mp4. Survives restarts."""

    def __init__(self, settings: Settings):
        self.s = settings
        self.root = settings.data_dir / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def new_id(self) -> str:
        return "rj_" + uuid.uuid4().hex[:8]

    def dir(self, jid: str) -> Path:
        return self.root / jid

    def get(self, jid: str) -> Optional[dict]:
        f = self.dir(jid) / "job.json"
        try:
            return json.loads(f.read_text())
        except (OSError, ValueError):
            return None

    def save(self, jid: str, data: dict) -> None:
        f = self.dir(jid) / "job.json"
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        os.replace(tmp, f)

    def update(self, jid: str, **fields) -> None:
        with self.lock:
            d = self.get(jid) or {}
            d.update(fields)
            self.save(jid, d)

    def recover_and_cleanup(self) -> None:
        for d in self.root.iterdir():
            job = self.get(d.name)
            if job is None:
                continue
            if job["status"] in ("queued", "rendering"):
                job.update(status="failed", error="Service restarted before this job finished. Submit it again.", finished_at=now_iso())
                self.save(d.name, job)
            elif time.time() - d.stat().st_mtime > self.s.job_ttl_hours * 3600:
                shutil.rmtree(d, ignore_errors=True)


class Worker:
    def __init__(self, store: JobStore, settings: Settings):
        self.store, self.s = store, settings
        self.pool = ThreadPoolExecutor(max_workers=settings.workers, thread_name_prefix="render")

    def submit(self, jid: str, ins: Instructions, src: Path) -> None:
        self.pool.submit(self._run, jid, ins, src)

    def _run(self, jid: str, ins: Instructions, src: Path) -> None:
        st, last = self.store, [-1]

        def progress(f: float) -> None:
            pct = int(f * 100)
            if pct != last[0]:
                last[0] = pct
                st.update(jid, progress=pct)

        try:
            st.update(jid, status="rendering", progress=0)
            out = render(src, st.dir(jid), ins, self.s, progress)
            h = hashlib.sha256()
            with open(out, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            info = probe(out)
            st.update(jid, status="completed", progress=100, error=None, duration_s=round(info["duration"], 3),
                      output_sha256=h.hexdigest(), finished_at=now_iso())
            log.info("job %s completed (%.2fs)", jid, info["duration"])
        except MediaError as e:
            log.warning("job %s failed: %s", jid, e)
            st.update(jid, status="failed", error=str(e), finished_at=now_iso())
        except Exception as e:  # unexpected
            log.exception("job %s crashed", jid)
            st.update(jid, status="failed", error=f"Internal error: {type(e).__name__}: {e}", finished_at=now_iso())
