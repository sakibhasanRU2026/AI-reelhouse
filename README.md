# REELHOUSE Render Service (FastAPI + FFmpeg)

External rendering backend for the REELHOUSE app. It implements the existing API contract:
`GET /health`, `POST /v1/render-jobs`, `GET /v1/render-jobs/{id}`, plus `GET /v1/render-jobs/{id}/output` (the target of `output_url`).

## Folder structure
```
reelhouse-render/
├── app/
│   ├── __init__.py
│   ├── main.py        # routes, auth, error format, upload handling
│   ├── schemas.py     # strict validation of the instructions JSON
│   ├── pipeline.py    # operations -> FFmpeg commands
│   ├── media.py       # ffprobe / ffmpeg wrappers, scene detection
│   ├── jobs.py        # on-disk job store + worker thread pool
│   └── config.py      # environment settings
├── tests/test_service.py   # 22 integration tests (real FFmpeg)
├── requirements.txt
├── requirements-dev.txt
├── .env.example
└── README.md
```

## Install (Ubuntu / Debian Linux)
```bash
sudo apt update
sudo apt install -y python3 python3-venv ffmpeg fonts-dejavu-core
cd reelhouse-render
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
ffmpeg -version | head -1      # confirm FFmpeg is installed
```

## Start
```bash
. .venv/bin/activate
export API_KEY="$(openssl rand -hex 24)"; echo "$API_KEY"    # save this key
export DATA_DIR=./data
# Only if the REELHOUSE app calls the API directly from the browser:
# export CORS_ORIGINS="https://your-app-origin"
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```
The service refuses to start without `API_KEY` (set `REELHOUSE_ALLOW_NO_AUTH=1` for local-only testing).
For real use, put it behind HTTPS (Caddy or nginx), set `PUBLIC_BASE_URL=https://render.yourdomain.com`,
and set the proxy body-size limit (for nginx: `client_max_body_size 500m;`).

## Operations
Applied in order. Each one works on the result of the previous one, so timestamps refer to the video as it is at that step.

| op | fields | behavior |
|---|---|---|
| `shorten_segment`, intro | `target_duration_s`, `segment_end_s` (number or null), `keep` (`last` default, or `first`), `scene_threshold` | Intro = 0..`segment_end_s`. null means the first scene change is auto-detected. `last` keeps the final N seconds of the intro. |
| `shorten_segment`, outro | `target_duration_s`, `segment_start_s` (number or null), `keep` (`first` default, or `last`) | Outro = `segment_start_s`..end. null means the last scene change is auto-detected. |
| `cut_range` | `start`, `end` | Removes that range and joins the rest, audio and video in sync. |
| `reframe` | `aspect: "9:16"`, `mode: "crop"` (default) or `"pad"` | Outputs 1080x1920. |
| `overlay_text` | `text`, `at`, `duration`, `style` (`bold-yellow`, `white-box`, `plain`), `max_words_per_line` | Burns text into the video. |
| `captions` | `source: "manual"`, `segments: [{start,end,text}]`, `style` | Several timed captions. |

Not supported, returned as HTTP 422 `unsupported_operation`: `remove_silence`, `speed`, `audio`, `punch_in`, `manual_review`, and `captions` with `source: "auto_transcribe"` (it needs speech-to-text).

## Example requests
```bash
export RENDER_URL=http://localhost:8000
export RENDER_KEY=<your API_KEY>

curl -H "Authorization: Bearer $RENDER_KEY" $RENDER_URL/health

# Cut the intro to 2 seconds (intro ends at 6.5s), then add a caption
curl -X POST $RENDER_URL/v1/render-jobs -H "Authorization: Bearer $RENDER_KEY" \
  -F "video=@input.mp4;type=video/mp4" \
  -F 'instructions={"schema_version":"1.0","video_id":"v1","reviewer_comment":"Cut the intro to two seconds.","comment_timestamp_s":6.5,"operations":[{"op":"shorten_segment","segment":"intro","target_duration_s":2,"segment_end_s":6.5},{"op":"overlay_text","text":"Stop scrolling","at":0,"duration":2}]}'
# For MOV use: -F "video=@input.mov;type=video/quicktime"

# Other instruction bodies (same curl, change the instructions field):
#   cut 2s-5s:      {"schema_version":"1.0","operations":[{"op":"cut_range","start":2,"end":5}]}
#   trim the outro: {"schema_version":"1.0","operations":[{"op":"shorten_segment","segment":"outro","target_duration_s":1,"segment_start_s":40}]}
#   9:16:           {"schema_version":"1.0","operations":[{"op":"reframe","aspect":"9:16"}]}

# Poll the job, then download the MP4 from output_url
curl -H "Authorization: Bearer $RENDER_KEY" $RENDER_URL/v1/render-jobs/<job_id>
curl -H "Authorization: Bearer $RENDER_KEY" -o rendered.mp4 <output_url>
```

## Errors
- `401 unauthorized`, `404 not_found`, `409 not_ready` (output requested before the job completed)
- `413 file_too_large`
- `422` with `error` set to `invalid_json`, `invalid_instructions` (with `details[]`), `unsupported_operation` (with `operations[]`), `invalid_video`, `video_too_long` or `invalid_request`
- Problems found while rendering (for example a cut beyond the video length) give `status: "failed"` and a readable `error`.

## Tests
```bash
pip install -r requirements-dev.txt
python -m pytest -v        # about 30 seconds; generates its own sample videos with FFmpeg
```
Manual check: run the curl example, download the output, then
`ffprobe -v error -show_entries format=duration:stream=width,height -of compact rendered.mp4`.

## Limitations
- Single machine with an in-process queue (`WORKERS` threads). Jobs and files live in `DATA_DIR`. Jobs unfinished at a restart are marked failed, and old jobs are deleted after `JOB_TTL_HOURS` at startup.
- Every operation re-encodes (H.264 CRF 20 + AAC), so long chains cost time and a little quality.
- Scene-based intro/outro detection is a heuristic. Pass explicit times when you know them.
- Upload size is checked from Content-Length and while saving, but the framework buffers the upload first. Enforce the limit at the proxy as well.
- One shared API key. No per-user accounts, rate limiting or built-in HTTPS (use a reverse proxy).
- Output stays on local disk. Upload to R2/S3 is not implemented.
