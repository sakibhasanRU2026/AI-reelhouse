"""Thin, safe wrappers around ffprobe / ffmpeg (no shell, argument lists only)."""
import json
import re
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Callable, Optional


class MediaError(Exception):
    """A user-presentable media/rendering failure."""


def ffmpeg_version() -> Optional[str]:
    try:
        out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"ffmpeg version (\S+)", out)
    return m.group(1) if m else None


def probe(path: Path) -> dict:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise MediaError(f"ffprobe could not run: {e}")
    if r.returncode != 0:
        raise MediaError("Not a readable media file: " + r.stderr.strip()[-300:])
    d = json.loads(r.stdout)
    streams = d.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    if not v:
        raise MediaError("File contains no video stream")
    dur = float(d.get("format", {}).get("duration") or v.get("duration") or 0)
    if dur <= 0:
        raise MediaError("Could not determine the video duration")
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if v.get("tags", {}).get("rotate") is not None:
        rot = int(float(v["tags"]["rotate"]))
    if abs(rot) % 180 == 90:
        w, h = h, w
    return {"duration": dur, "width": w, "height": h, "has_audio": any(s.get("codec_type") == "audio" for s in streams)}


def run_ffmpeg(args, expected: float, on_progress: Callable[[float], None], timeout: int, cwd: Optional[Path] = None) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *map(str, args)]
    err = tempfile.TemporaryFile()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True, cwd=str(cwd) if cwd else None)
    timer = threading.Timer(timeout, p.kill)
    timer.start()
    try:
        for line in p.stdout:  # type: ignore[union-attr]
            if line.startswith(("out_time_us=", "out_time_ms=")):
                try:
                    us = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if expected > 0 and us >= 0:
                    on_progress(min(1.0, us / 1e6 / expected))
        p.wait()
    finally:
        timer.cancel()
    if p.returncode != 0:
        err.seek(0)
        tail = err.read().decode(errors="replace")[-700:].strip()
        err.close()
        if p.returncode < 0:
            raise MediaError(f"ffmpeg was stopped (timeout {timeout}s or killed)")
        raise MediaError("ffmpeg failed: " + tail)
    err.close()


def detect_scenes(path: Path, threshold: float, timeout: int) -> list:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-an", "-vf",
                        f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise MediaError("Scene detection failed: " + r.stderr.strip()[-300:])
    return [float(x) for x in re.findall(r"pts_time:([0-9.]+)", r.stderr)]
