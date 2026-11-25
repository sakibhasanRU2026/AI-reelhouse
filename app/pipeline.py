"""Turns validated instructions into FFmpeg runs. Operations apply in order; each one
works on the output of the previous one, so all timestamps refer to the *current* timeline."""
import re
from pathlib import Path
from typing import Callable, List, Tuple

from .config import Settings
from .media import MediaError, detect_scenes, probe, run_ffmpeg
from .schemas import CutRange, Instructions, OverlayText, Reframe, ShortenSegment

ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]
t3 = lambda x: f"{x:.3f}"


class Step:
    def __init__(self, settings: Settings, cb: Callable[[float], None], cwd: Path):
        self.s, self.cb, self.cwd = settings, cb, cwd

    def run(self, args, expected: float) -> None:
        run_ffmpeg(args, expected, self.cb, self.s.ffmpeg_timeout_s, cwd=self.cwd)


def _remove_range(step: Step, src: Path, dst: Path, a: float, b: float, info: dict) -> None:
    total = info["duration"]
    if a >= total - 0.01:
        raise MediaError(f"Range start {a:.2f}s is at or beyond the video duration {total:.2f}s")
    b = min(b, total)
    keeps: List[Tuple[float, float]] = []
    if a > 0.01:
        keeps.append((0.0, a))
    if b < total - 0.01:
        keeps.append((b, total))
    if not keeps:
        raise MediaError("That cut would remove the entire video")
    audio, parts = info["has_audio"], []
    for i, (s, e) in enumerate(keeps):
        parts.append(f"[0:v]trim=start={t3(s)}:end={t3(e)},setpts=PTS-STARTPTS[v{i}]")
        if audio:
            parts.append(f"[0:a]atrim=start={t3(s)}:end={t3(e)},asetpts=PTS-STARTPTS[a{i}]")
    if len(keeps) == 1:
        vl, al = "[v0]", "[a0]"
    else:
        ins = "".join(f"[v{i}][a{i}]" if audio else f"[v{i}]" for i in range(len(keeps)))
        parts.append(f"{ins}concat=n={len(keeps)}:v=1:a={1 if audio else 0}[v]" + ("[a]" if audio else ""))
        vl, al = "[v]", "[a]"
    maps = ["-map", vl] + (["-map", al] if audio else [])
    step.run(["-i", src, "-filter_complex", ";".join(parts), *maps, *ENC, dst], sum(e - s for s, e in keeps))


def _shorten(step: Step, op: ShortenSegment, src: Path, dst: Path, info: dict) -> None:
    total, tgt = info["duration"], op.target_duration_s
    keep = op.keep or ("last" if op.segment == "intro" else "first")
    if op.segment == "intro":
        end = op.segment_end_s
        if end is None:
            scenes = [t for t in detect_scenes(src, op.scene_threshold, step.s.ffmpeg_timeout_s) if t >= 0.2]
            if not scenes:
                raise MediaError("Could not detect where the intro ends (no scene change found). Provide segment_end_s.")
            end = scenes[0]
        end = min(end, total)
        if end <= tgt + 0.01:
            raise MediaError(f"The intro is {end:.2f}s, which is not longer than the target {tgt:.2f}s; nothing to trim")
        a, b = (0.0, end - tgt) if keep == "last" else (tgt, end)
    else:
        start = op.segment_start_s
        if start is None:
            scenes = detect_scenes(src, op.scene_threshold, step.s.ffmpeg_timeout_s)
            if not scenes:
                raise MediaError("Could not detect where the outro starts (no scene change found). Provide segment_start_s.")
            start = scenes[-1]
        if total - start <= tgt + 0.01:
            raise MediaError(f"The outro is {total - start:.2f}s, which is not longer than the target {tgt:.2f}s; nothing to trim")
        a, b = (start + tgt, total) if keep == "first" else (start, total - tgt)
    _remove_range(step, src, dst, a, b, info)


def _reframe(step: Step, op: Reframe, src: Path, dst: Path, info: dict) -> None:
    if op.mode == "crop":
        vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"
    else:
        vf = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
    maps = ["-map", "0:v:0"] + (["-map", "0:a:0"] if info["has_audio"] else [])
    step.run(["-i", src, "-vf", vf, *maps, *ENC, dst], info["duration"])


def _drawtext(textfile: str, start: float, end: float, style: str, h: int, font: str) -> str:
    fs, bw = max(18, int(h / 24)), max(2, int(h / 300))
    sty = {"bold-yellow": f"fontcolor=yellow:borderw={bw}:bordercolor=black",
           "white-box": f"fontcolor=white:box=1:boxcolor=black@0.6:boxborderw={max(6, int(h / 100))}",
           "plain": f"fontcolor=white:borderw={bw}:bordercolor=black"}[style]
    return (f"drawtext=fontfile={font}:textfile={textfile}:expansion=none:fontsize={fs}:{sty}:"
            f"line_spacing={int(fs * 0.25)}:x=(w-text_w)/2:y=h*0.72:enable='between(t,{t3(start)},{t3(end)})'")


def _captions(step: Step, op, src: Path, dst: Path, info: dict, idx: int) -> None:
    font = step.s.font_path
    if not re.fullmatch(r"[\w./-]+", font) or not Path(font).is_file():
        raise MediaError(f"Caption font not found or has unsupported characters in its path: {font}. Set FONT_PATH.")
    if isinstance(op, OverlayText):
        items = [(op.text, op.at, op.at + op.duration)]
    else:
        items = [(s.text, s.start, s.end) for s in op.segments or []]
    filters = []
    for n, (text, s, e) in enumerate(items):
        if s >= info["duration"]:
            raise MediaError(f"A caption starts at {s:.2f}s but the video is only {info['duration']:.2f}s long")
        words = text.split()
        lines = [" ".join(words[i:i + op.max_words_per_line]) for i in range(0, len(words), op.max_words_per_line)]
        name = f"cap_{idx}_{n}.txt"
        (step.cwd / name).write_text("\n".join(lines), encoding="utf-8")
        filters.append(_drawtext(name, s, e, op.style, info["height"], font))
    maps = ["-map", "0:v:0"] + (["-map", "0:a:0"] if info["has_audio"] else [])
    step.run(["-i", src, "-vf", ",".join(filters), *maps, *ENC, dst], info["duration"])


def render(src: Path, job_dir: Path, ins: Instructions, settings: Settings, progress: Callable[[float], None]) -> Path:
    n, cur, info = len(ins.operations), src, probe(src)
    for i, op in enumerate(ins.operations):
        dst = job_dir / f"step{i}.mp4"
        step = Step(settings, lambda f, i=i: progress((i + f) / n * 0.97), job_dir)
        if isinstance(op, ShortenSegment):
            _shorten(step, op, cur, dst, info)
        elif isinstance(op, CutRange):
            _remove_range(step, cur, dst, op.start, op.end, info)
        elif isinstance(op, Reframe):
            _reframe(step, op, cur, dst, info)
        else:
            _captions(step, op, cur, dst, info, i)
        info = probe(dst)
        if cur != src:
            cur.unlink(missing_ok=True)
        cur = dst
    final = job_dir / "output.mp4"
    cur.replace(final)
    for f in job_dir.glob("cap_*.txt"):
        f.unlink(missing_ok=True)
    return final
