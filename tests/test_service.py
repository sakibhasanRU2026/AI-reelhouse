"""Integration tests: real ffmpeg, real uploads, real rendered MP4 files. Run: pytest -v"""
import json
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.media import probe

KEY = {"Authorization": "Bearer test-key"}


@pytest.fixture(scope="session")
def samples(tmp_path_factory):
    d = tmp_path_factory.mktemp("samples")
    mp4, mov = d / "sample.mp4", d / "sample.mov"
    # 10s, 640x360: 4s red "intro" then 6s test pattern (hard scene change at 4s) + sine audio
    base = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:d=4:r=25",
            "-f", "lavfi", "-i", "testsrc2=s=640x360:d=6:r=25", "-f", "lavfi", "-i", "sine=d=10",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
    subprocess.run([*base, str(mp4)], check=True)
    subprocess.run([*base, "-f", "mov", str(mov)], check=True)
    (d / "fake.mp4").write_text("this is not a video")
    return d


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("API_KEY", "test-key")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    with TestClient(create_app()) as c:
        yield c


def ins(*ops):
    return json.dumps({"schema_version": "1.0", "video_id": "v1", "operations": list(ops)})


def submit(client, path, instructions, ctype="video/mp4", name=None):
    with open(path, "rb") as f:
        return client.post("/v1/render-jobs", headers=KEY, data={"instructions": instructions},
                           files={"video": (name or path.name, f, ctype)})


def wait(client, jid, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        j = client.get(f"/v1/render-jobs/{jid}", headers=KEY).json()
        if j["status"] in ("completed", "failed"):
            return j
        time.sleep(0.3)
    raise AssertionError("job timed out")


def render_ok(client, path, instructions, **kw):
    r = submit(client, path, instructions, **kw)
    assert r.status_code == 202, r.text
    assert set(r.json()) == {"job_id", "status", "created_at"} and r.json()["status"] == "queued"
    j = wait(client, r.json()["job_id"])
    assert j["status"] == "completed", j
    out = client.get(j["output_url"], headers=KEY)
    assert out.status_code == 200 and out.headers["content-type"] == "video/mp4"
    assert out.content[4:8] == b"ftyp"  # real MP4 container
    return j, out.content


def info_of(tmp_path, content):
    p = tmp_path / "out.mp4"
    p.write_bytes(content)
    return probe(p), p


def test_health_and_auth(client):
    assert client.get("/health").status_code == 401
    r = client.get("/health", headers=KEY)
    assert r.status_code == 200 and r.json()["status"] == "ok" and r.json()["ffmpeg"]


def test_intro_explicit(client, samples, tmp_path):
    j, c = render_ok(client, samples / "sample.mp4", ins({"op": "shorten_segment", "segment": "intro", "target_duration_s": 2, "segment_end_s": 4}))
    i, _ = info_of(tmp_path, c)
    assert abs(i["duration"] - 8) < 0.3 and abs(j["duration_s"] - i["duration"]) < 0.05 and len(j["output_sha256"]) == 64


def test_intro_scene_detect(client, samples, tmp_path):
    j, c = render_ok(client, samples / "sample.mp4", ins({"op": "shorten_segment", "segment": "intro", "target_duration_s": 2, "segment_end_s": None, "detect": "scene_change", "keep": "last"}))
    assert abs(info_of(tmp_path, c)[0]["duration"] - 8) < 0.4


def test_outro(client, samples, tmp_path):
    j, c = render_ok(client, samples / "sample.mp4", ins({"op": "shorten_segment", "segment": "outro", "target_duration_s": 1, "segment_start_s": 7, "keep": "first"}))
    assert abs(info_of(tmp_path, c)[0]["duration"] - 8) < 0.3


def test_cut_range_mov_input(client, samples, tmp_path):
    j, c = render_ok(client, samples / "sample.mov", ins({"op": "cut_range", "start": 2, "end": 5}), ctype="video/quicktime")
    i, _ = info_of(tmp_path, c)
    assert abs(i["duration"] - 7) < 0.3 and i["has_audio"]


def test_reframe_916(client, samples, tmp_path):
    j, c = render_ok(client, samples / "sample.mp4", ins({"op": "reframe", "aspect": "9:16"}))
    i, _ = info_of(tmp_path, c)
    assert (i["width"], i["height"]) == (1080, 1920)


def frame(path, t):
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-vf", "crop=iw:ih*0.4:0:ih*0.6",
                           "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout


def test_text_caption_is_burned_in(client, samples, tmp_path):
    cap = {"op": "overlay_text", "text": "Hello REELHOUSE caption", "at": 0, "duration": 3, "style": "bold-yellow"}
    late = dict(cap, at=8)
    _, a = render_ok(client, samples / "sample.mp4", ins(cap))
    _, b = render_ok(client, samples / "sample.mp4", ins(late))
    (tmp_path / "a.mp4").write_bytes(a)
    (tmp_path / "b.mp4").write_bytes(b)
    assert frame(tmp_path / "a.mp4", 1) != frame(tmp_path / "b.mp4", 1)   # caption visible only in a at t=1
    assert frame(tmp_path / "a.mp4", 5) == frame(tmp_path / "a.mp4", 5)


def test_manual_captions_with_special_chars(client, samples):
    render_ok(client, samples / "sample.mp4", ins({"op": "captions", "source": "manual", "segments": [{"start": 0, "end": 2, "text": "50% off: it's \"live\" now"}]}))


def test_chained_operations(client, samples, tmp_path):
    j, c = render_ok(client, samples / "sample.mp4", ins(
        {"op": "shorten_segment", "segment": "intro", "target_duration_s": 2, "segment_end_s": 4},
        {"op": "cut_range", "start": 1, "end": 3},
        {"op": "reframe", "aspect": "9:16", "mode": "pad"},
        {"op": "overlay_text", "text": "Done", "at": 0, "duration": 1}))
    i, _ = info_of(tmp_path, c)
    assert abs(i["duration"] - 6) < 0.4 and (i["width"], i["height"]) == (1080, 1920)


@pytest.mark.parametrize("body,code,err", [
    ("{not json", 422, "invalid_json"),
    (json.dumps({"schema_version": "2.0", "operations": []}), 422, "invalid_instructions"),
    (ins({"op": "cut_range", "start": 5, "end": 2}), 422, "invalid_instructions"),
    (ins({"op": "cut_range", "start": 1, "end": 2, "bogus": 1}), 422, "invalid_instructions"),
    (ins({"op": "shorten_segment", "segment": "intro", "target_duration_s": -1}), 422, "invalid_instructions"),
    (ins({"op": "remove_silence"}, {"op": "speed"}), 422, "unsupported_operation"),
    (ins({"op": "captions", "source": "auto_transcribe"}), 422, "unsupported_operation"),
    (ins({"op": "captions", "source": "manual"}), 422, "invalid_instructions"),
])
def test_validation_errors(client, samples, body, code, err):
    r = submit(client, samples / "sample.mp4", body)
    assert r.status_code == code and r.json()["error"] == err, r.text


def test_unsupported_lists_operations(client, samples):
    r = submit(client, samples / "sample.mp4", ins({"op": "remove_silence"}, {"op": "speed"}, {"op": "cut_range", "start": 1, "end": 2}))
    assert r.json()["operations"] == ["remove_silence", "speed"]


def test_bad_uploads(client, samples):
    ok = ins({"op": "cut_range", "start": 1, "end": 2})
    assert submit(client, samples / "fake.mp4", ok).json()["error"] == "invalid_video"       # not really a video
    assert submit(client, samples / "sample.mp4", ok, name="x.avi").json()["error"] == "invalid_video"  # wrong extension
    assert submit(client, samples / "sample.mp4", ok, ctype="text/plain").status_code == 422
    assert client.post("/v1/render-jobs", headers=KEY, data={"instructions": ok}).status_code == 422  # no file


def test_render_time_failure_reports_error(client, samples):
    r = submit(client, samples / "sample.mp4", ins({"op": "cut_range", "start": 50, "end": 60}))
    j = wait(client, r.json()["job_id"])
    assert j["status"] == "failed" and "beyond the video duration" in j["error"] and j["output_url"] is None
    assert client.get(f"/v1/render-jobs/{j['job_id']}/output", headers=KEY).status_code == 409


def test_unknown_job_and_bad_id(client):
    assert client.get("/v1/render-jobs/rj_00000000", headers=KEY).status_code == 404
    assert client.get("/v1/render-jobs/..%2F..%2Fetc", headers=KEY).status_code == 404


def test_upload_too_large(tmp_path, monkeypatch, samples):
    monkeypatch.setenv("API_KEY", "test-key")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "d"))
    monkeypatch.setenv("MAX_UPLOAD_MB", "0")
    with TestClient(create_app()) as c:
        r = submit(c, samples / "sample.mp4", ins({"op": "cut_range", "start": 1, "end": 2}))
        assert r.status_code == 413 and r.json()["error"] == "file_too_large"
