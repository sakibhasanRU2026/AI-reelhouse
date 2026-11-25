import logging
import re
import secrets
import shutil
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .jobs import JobStore, Worker, now_iso
from .media import MediaError, ffmpeg_version, probe
from .schemas import InstructionError, parse_instructions

JOB_ID = re.compile(r"^rj_[0-9a-f]{8}$")
ALLOWED_EXT = {".mp4", ".mov"}
ALLOWED_TYPES = {"video/mp4", "video/quicktime", "application/octet-stream"}


class ApiError(Exception):
    def __init__(self, status: int, body: dict, headers: Optional[dict] = None):
        self.status, self.body, self.headers = status, body, headers or {}


def create_app() -> FastAPI:
    s = Settings()
    if not s.api_key and not s.allow_no_auth:
        raise RuntimeError("API_KEY is not set. Set API_KEY, or set REELHOUSE_ALLOW_NO_AUTH=1 for local testing only.")
    logging.basicConfig(level=logging.INFO)
    store = JobStore(s)
    store.recover_and_cleanup()
    worker = Worker(store, s)
    version = ffmpeg_version()
    app = FastAPI(title="REELHOUSE Render Service", version="1.0.0")

    @app.exception_handler(ApiError)
    async def _api_err(_, e: ApiError):
        return JSONResponse(e.body, status_code=e.status, headers=e.headers)

    @app.exception_handler(RequestValidationError)
    async def _val_err(_, e: RequestValidationError):
        details = [{"loc": ".".join(str(p) for p in x["loc"]), "msg": x["msg"]} for x in e.errors()]
        return JSONResponse({"error": "invalid_request", "details": details}, status_code=422)

    @app.middleware("http")
    async def _size_guard(request: Request, call_next):
        cl = request.headers.get("content-length")
        if request.method == "POST" and cl and cl.isdigit() and int(cl) > s.max_upload_mb * 1048576 + 1_000_000:
            return JSONResponse({"error": "file_too_large", "message": f"Upload exceeds {s.max_upload_mb} MB"}, status_code=413)
        return await call_next(request)

    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["GET", "POST", "OPTIONS"],
                           allow_headers=["Authorization", "Content-Type"])

    bearer_auth = HTTPBearer(auto_error=False)

    def auth(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_auth)) -> None:
        if not s.api_key:
            return
        token = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else ""
        if not secrets.compare_digest(token.encode(), s.api_key.encode()):
            raise ApiError(401, {"error": "unauthorized", "message": "Missing or invalid bearer token"}, {"WWW-Authenticate": "Bearer"})

    def public(job: dict, request: Request) -> dict:
        base = s.public_base_url or str(request.base_url).rstrip("/")
        done = job["status"] == "completed"
        return {"job_id": job["job_id"], "status": job["status"], "progress": job.get("progress", 0),
                "error": job.get("error"), "duration_s": job.get("duration_s"),
                "output_url": f"{base}/v1/render-jobs/{job['job_id']}/output" if done else None,
                "output_sha256": job.get("output_sha256"),
                "created_at": job.get("created_at"), "finished_at": job.get("finished_at")}

    @app.get("/health", dependencies=[Depends(auth)])
    def health():
        if not version:
            return JSONResponse({"status": "error", "ffmpeg": None, "message": "ffmpeg not found on PATH"}, status_code=503)
        return {"status": "ok", "ffmpeg": version}

    @app.post("/v1/render-jobs", status_code=202, dependencies=[Depends(auth)])
    async def create_job(video: UploadFile = File(...), instructions: str = Form(...)):
        try:
            ins = parse_instructions(instructions)
        except InstructionError as e:
            raise ApiError(e.status, e.body)
        ext = Path(video.filename or "").suffix.lower()
        if ext not in ALLOWED_EXT or (video.content_type or "") not in ALLOWED_TYPES:
            raise ApiError(422, {"error": "invalid_video", "message": "Upload an MP4 or MOV file (video/mp4 or video/quicktime)"})
        jid = store.new_id()
        jdir = store.dir(jid)
        jdir.mkdir(parents=True)
        src, size, limit = jdir / f"input{ext}", 0, s.max_upload_mb * 1048576
        try:
            with open(src, "wb") as f:
                while chunk := await video.read(1 << 20):
                    size += len(chunk)
                    if size > limit:
                        raise ApiError(413, {"error": "file_too_large", "message": f"Upload exceeds {s.max_upload_mb} MB"})
                    f.write(chunk)
            try:
                info = await run_in_threadpool(probe, src)
            except MediaError as e:
                raise ApiError(422, {"error": "invalid_video", "message": str(e)})
            if info["duration"] > s.max_duration_s:
                raise ApiError(422, {"error": "video_too_long", "message": f"Video is {info['duration']:.0f}s; the limit is {s.max_duration_s:.0f}s"})
        except ApiError:
            shutil.rmtree(jdir, ignore_errors=True)
            raise
        created = now_iso()
        store.save(jid, {"job_id": jid, "status": "queued", "progress": 0, "error": None, "duration_s": None,
                         "output_sha256": None, "created_at": created, "finished_at": None, "input": src.name})
        worker.submit(jid, ins, src)
        return {"job_id": jid, "status": "queued", "created_at": created}

    def load(jid: str) -> dict:
        job = store.get(jid) if JOB_ID.match(jid) else None
        if not job:
            raise ApiError(404, {"error": "not_found", "message": "Unknown job"})
        return job

    @app.get("/v1/render-jobs/{jid}", dependencies=[Depends(auth)])
    def job_status(jid: str, request: Request):
        return public(load(jid), request)

    @app.get("/v1/render-jobs/{jid}/output", dependencies=[Depends(auth)])
    def job_output(jid: str):
        job = load(jid)
        if job["status"] != "completed":
            raise ApiError(409, {"error": "not_ready", "message": f"Job status is '{job['status']}'"})
        return FileResponse(store.dir(jid) / "output.mp4", media_type="video/mp4", filename=f"{jid}.mp4")

    return app
