import logging
import re
import secrets
import shutil
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
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

    @app.head("/", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def studio():
        return HTMLResponse(STUDIO_HTML, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

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


# Self-contained UI; no additional frontend files or dependencies required.
STUDIO_HTML = r'''
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Reelhouse — Render Studio</title>
<style>
:root{--bg:#101116;--panel:#181a22;--border:#30323e;--muted:#a1a5b7;--text:#f2f2f7;--accent:#b4a2ff;--purple:#8060ee;--green:#76e4ad;--red:#ff999d}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}button,input,select,textarea{font:inherit}button,a,input,select,textarea{outline-offset:4px}button{cursor:pointer}button:disabled{opacity:.46;cursor:not-allowed}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.shell{max-width:1320px;margin:auto;padding:0 32px 40px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 0;border-bottom:1px solid var(--border)}.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:19px;letter-spacing:1.5px}.logo{width:39px;height:39px;border-radius:12px;display:grid;place-items:center;background:var(--purple);color:white;letter-spacing:0}.brand small{display:block;color:var(--muted);font-size:10px;font-weight:500;letter-spacing:1px}.headright{display:flex;align-items:center;gap:16px}.pill{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:8px}.dot{width:8px;height:8px;border-radius:50%;background:#888d9c}.dot.ok{background:var(--green)}.dot.bad{background:var(--red)}.hero{padding:34px 0 24px;display:flex;justify-content:space-between;align-items:end;gap:16px}.eyebrow{color:var(--accent);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase}h1{font-size:36px;letter-spacing:-1.5px;line-height:1.15;margin:8px 0 6px}h2{font-size:17px;margin:0}h3{font-size:14px;margin:0}.muted{color:var(--muted)}.small{font-size:12px}.layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px;align-items:start}.stack{display:grid;gap:20px;min-width:0}.panel{border:1px solid var(--border);border-radius:16px;background:var(--panel);padding:22px;min-width:0}.panelhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.num{color:var(--accent);font-size:11px;font-weight:800;letter-spacing:1px;margin-right:8px}.btn{background:#252735;border:1px solid #3b3d4b;color:var(--text);padding:10px 14px;border-radius:9px;font-weight:650;white-space:nowrap}.btn:hover:not(:disabled){background:#36384a}.primary{background:var(--purple);border-color:var(--purple);color:white}.primary:hover:not(:disabled){background:#9278f5}.full{width:100%}.keyrow{display:flex;gap:8px;align-items:center}.keyrow input{flex:1;min-width:0}input,select,textarea{width:100%;background:#11131a;border:1px solid #3a3c4a;border-radius:8px;color:var(--text);padding:10px 11px}input:focus,select:focus,textarea:focus{border-color:var(--accent)}label{display:block;font-size:12px;color:#c3c5d3;margin-bottom:5px}.drop{min-height:156px;border:1.5px dashed #555269;border-radius:12px;display:grid;place-items:center;text-align:center;background:#151620;padding:20px;cursor:pointer}.drop:hover,.drop.drag{background:#23213a;border-color:var(--accent)}.drop svg{color:var(--accent);margin-bottom:8px}.drop strong{display:block;font-size:15px}.drop p{margin:5px 0}.fileinfo{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;overflow-wrap:anywhere}.screen{aspect-ratio:16/9;background:#0c0d11;border:1px solid #2c2e38;border-radius:12px;display:grid;place-items:center;overflow:hidden;position:relative}.screen video{width:100%;height:100%;object-fit:contain;background:black}.empty{text-align:center;color:var(--muted);padding:16px}.empty svg{display:block;margin:0 auto 10px;color:#6a6d83}.tabrow{display:flex;gap:6px;background:#101218;border-radius:10px;padding:4px}.tab{border:0;background:transparent;color:var(--muted);border-radius:7px;padding:7px 13px;font-size:12px;font-weight:650}.tab.active{background:#303242;color:white}.opbuttons{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}.opbuttons .btn{font-size:12px;padding:8px 10px}.op{background:#13151d;border:1px solid #343644;border-radius:10px;padding:13px;margin:10px 0}.ophead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.optools{display:flex;gap:4px}.mini{padding:4px 8px;font-size:12px;background:#252735;border:1px solid #424454;border-radius:6px;color:var(--text)}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.wide{grid-column:1/-1}.captionline{display:grid;grid-template-columns:1fr 1fr 2fr auto;gap:6px;align-items:end;margin-bottom:8px}.progress{height:9px;background:#303241;border-radius:10px;overflow:hidden;margin:12px 0}.progress>div{height:100%;width:0;background:linear-gradient(90deg,#8060ee,#b4a2ff);transition:width .3s}.statusrow{display:flex;justify-content:space-between;align-items:center;gap:8px}.status{font-size:12px;font-weight:650;color:var(--accent);text-transform:capitalize}.notice{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--red);font-size:12px;margin-top:10px}.success{color:var(--green)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.actions .btn{flex:1}.divider{height:1px;background:var(--border);margin:17px 0}details summary{cursor:pointer;color:var(--muted);font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:#c1b5ff;background:#11131a;padding:12px;border-radius:8px}footer{color:var(--muted);font-size:12px;margin-top:22px;display:flex;justify-content:space-between;gap:12px}[hidden]{display:none!important}@media(max-width:850px){.layout{grid-template-columns:1fr}.shell{padding:0 16px 25px}.hero{padding-top:24px}.panel{padding:16px}.hero h1{font-size:29px}.headright{gap:8px}.headright a{display:none}}@media(max-width:450px){.keyrow{flex-wrap:wrap}.keyrow input{flex-basis:100%}.fields{grid-template-columns:1fr}.captionline{grid-template-columns:1fr 1fr}.hero{display:block}.headright .pill{font-size:11px}.brand{font-size:15px}.brand small{font-size:9px}}
</style></head><body><div class="shell"><header><div class="brand"><div class="logo"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4M10 9l5 3-5 3z"/></svg></div><div>REELHOUSE<small>RENDER STUDIO</small></div></div><div class="headright"><span class="pill" id="connection"><span class="dot" id="dot"></span><span id="connectionText">Not connected</span></span><a href="/docs" target="_blank" rel="noopener">API docs ↗</a></div></header><section class="hero"><div><div class="eyebrow">Video workspace</div><h1>Make every second count.</h1><div class="muted">Upload, edit and export your video with the REELHOUSE rendering engine.</div></div><span class="pill">MP4 / MOV &nbsp; • &nbsp; H.264 export</span></section>
<div class="layout"><div class="stack"><section class="panel"><div class="panelhead"><h2><span class="num">01</span>Connect to renderer</h2><button class="btn" id="disconnect" hidden>Disconnect</button></div><label for="key">Private API key</label><div class="keyrow"><input id="key" type="password" placeholder="Paste your Render API_KEY" autocomplete="off" spellcheck="false"><button class="btn" id="showKey" type="button">Show</button><button class="btn primary" id="connect">Connect</button></div><p class="small muted">Your key stays in this tab's memory and is sent only to this server. It is not saved in the browser.</p><div class="notice" role="status" id="authMessage"></div></section>
<section class="panel"><div class="panelhead"><h2><span class="num">02</span>Source video</h2><span class="small muted">MP4 or MOV</span></div><input id="file" type="file" accept=".mp4,.mov,video/mp4,video/quicktime" hidden><div class="drop" id="drop" role="button" tabindex="0" aria-label="Choose video"><div><svg width="33" height="33" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg><strong>Drop your video here</strong><p class="muted small">or click to browse your files</p></div></div><div class="fileinfo" id="fileInfo" hidden><span id="fileName"></span><button class="mini" id="removeFile">Remove</button></div><div class="notice" id="fileError" role="status"></div></section>
<section class="panel"><div class="panelhead"><h2><span class="num">03</span>Edit instructions</h2><span class="small muted" id="opCount">0 / 20</span></div><div class="opbuttons" id="opButtons"><button class="btn" data-add="reframe">+ 9:16 reframe</button><button class="btn" data-add="cut_range">+ Cut range</button><button class="btn" data-add="shorten_segment">+ Shorten intro/outro</button><button class="btn" data-add="overlay_text">+ Text overlay</button><button class="btn" data-add="captions">+ Captions</button></div><div class="small muted">Operations run from top to bottom. Times refer to the video at each step.</div><div id="ops"></div><div id="noOps" class="empty small">Add at least one editing operation above.</div><details><summary>View request JSON</summary><pre id="jsonPreview"></pre></details><div class="notice" role="alert" id="formError"></div><div class="divider"></div><button id="render" class="btn primary full" disabled>▶ &nbsp; Render video</button></section></div>
<div class="stack"><section class="panel"><div class="panelhead"><h2>Preview</h2><div class="tabrow"><button id="sourceTab" class="tab active">Original</button><button id="outputTab" class="tab" disabled>Rendered</button></div></div><div class="screen"><div class="empty" id="previewEmpty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/></svg>No video selected<br><span class="small">Your video preview will appear here.</span></div><video id="sourceVideo" controls playsinline hidden></video><video id="outputVideo" controls playsinline hidden></video></div><div class="fileinfo small muted"><span id="previewMeta">Original video</span><span id="durationMeta">—</span></div></section>
<section class="panel"><div class="panelhead"><h2><span class="num">04</span>Render output</h2><span id="jobState" class="status" role="status">Ready</span></div><div class="statusrow"><span class="muted small" id="jobMessage">Connect and choose a video to begin.</span><strong id="percent">0%</strong></div><div class="progress" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="progress"><div id="bar"></div></div><div class="small muted" id="jobId">No active job</div><div id="jobError" class="notice" role="alert"></div><div class="actions"><button class="btn" id="resume" disabled>Refresh status</button><button class="btn primary" id="download" disabled>↓ Download MP4</button></div><div class="divider"></div><label for="existingId">Resume an existing job</label><div class="keyrow"><input id="existingId" placeholder="rj_…" spellcheck="false"><button class="btn" id="loadJob" disabled>Load</button></div><p class="small muted">Rendered files are stored temporarily on this server. Download your output before the service restarts.</p></section>
<section class="panel"><h2>Rendering notes</h2><p class="small muted">Start with a short video for testing. Vertical reframing exports at 1080 × 1920 and can take longer on a free server.</p><p class="small muted">Captions are entered manually. This renderer does not generate AI transcripts or interpret natural-language prompts.</p></section></div></div><footer><span>REELHOUSE • Render Service 1.0</span><a href="/docs" target="_blank" rel="noopener">Developer API ↗</a></footer></div>
<script>
'use strict';
const $=id=>document.getElementById(id); let token='',connected=false,videoFile=null,sourceURL='',outputURL='',ops=[],jobId='',jobStatus='',busy=false,pollTimer=null,pollEpoch=0,outputBlob=null,previewMode='source';
const names={reframe:'Vertical reframe',cut_range:'Cut range',shorten_segment:'Shorten intro / outro',overlay_text:'Text overlay',captions:'Manual captions'};const styles=['bold-yellow','white-box','plain'];
const defaults={reframe:()=>({op:'reframe',aspect:'9:16',mode:'crop'}),cut_range:()=>({op:'cut_range',start:0,end:1}),shorten_segment:()=>({op:'shorten_segment',segment:'intro',target_duration_s:2,keep:'',boundary:''}),overlay_text:()=>({op:'overlay_text',text:'',at:0,duration:2,style:'bold-yellow',max_words_per_line:4}),captions:()=>({op:'captions',source:'manual',style:'bold-yellow',max_words_per_line:4,segments:[{start:0,end:2,text:''}]})};
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el}function button(text,fn){let b=node('button','mini',text);b.type='button';b.onclick=fn;return b}
function field(label,obj,key,type='text',options=[],wide=false){const wrap=node('div',wide?'wide':'');const l=node('label','',label);let e=node(type==='select'?'select':type==='textarea'?'textarea':'input');e.setAttribute('aria-label',label);if(type==='select'){for(const [v,t] of options){let o=node('option','',t);o.value=v;e.append(o)}}else if(type!=='textarea'){e.type=type;if(type==='number'){e.min='0';e.step='any'}}else e.rows=2;e.value=obj[key]??'';e.oninput=()=>{obj[key]=type==='number'?(e.value===''?'':Number(e.value)):e.value;updateJSON()};wrap.append(l,e);return wrap}
function styleField(obj){return field('Text style',obj,'style','select',styles.map(v=>[v,v.replaceAll('-',' ')]))}
function renderOps(){const root=$('ops');root.replaceChildren();ops.forEach((o,i)=>{const card=node('div','op');const head=node('div','ophead');head.append(node('h3','',`${i+1}. ${names[o.op]}`));const controls=node('div','optools');const up=button('↑',()=>{[ops[i-1],ops[i]]=[ops[i],ops[i-1]];renderOps()});up.disabled=i===0;up.setAttribute('aria-label','Move operation up');const down=button('↓',()=>{[ops[i+1],ops[i]]=[ops[i],ops[i+1]];renderOps()});down.disabled=i===ops.length-1;down.setAttribute('aria-label','Move operation down');const remove=button('Remove',()=>{ops.splice(i,1);renderOps()});controls.append(up,down,remove);head.append(controls);card.append(head);const f=node('div','fields');if(o.op==='reframe')f.append(field('9:16 output mode',o,'mode','select',[['crop','Crop to fill'],['pad','Fit with padding']],true));if(o.op==='cut_range')f.append(field('Cut start (s)',o,'start','number'),field('Cut end (s)',o,'end','number'));if(o.op==='shorten_segment'){const segment=field('Segment',o,'segment','select',[['intro','Intro'],['outro','Outro']]);segment.querySelector('select').onchange=e=>{o.segment=e.target.value;o.boundary='';renderOps()};f.append(segment,field('Keep duration (s)',o,'target_duration_s','number'),field(o.segment==='intro'?'Intro ends at (s) — optional':'Outro starts at (s) — optional',o,'boundary','number'),field('Keep',o,'keep','select',[['','Default'],['first','First part'],['last','Last part']]))}if(o.op==='overlay_text')f.append(field('Overlay text',o,'text','textarea',[],true),field('Start (s)',o,'at','number'),field('Duration (s)',o,'duration','number'),styleField(o),field('Words per line',o,'max_words_per_line','number'));if(o.op==='captions'){f.append(styleField(o),field('Words per line',o,'max_words_per_line','number'));let w=node('div','wide');o.segments.forEach((seg,j)=>{const row=node('div','captionline');row.append(field('Start (s)',seg,'start','number'),field('End (s)',seg,'end','number'),field('Caption',seg,'text'),button('×',()=>{o.segments.splice(j,1);renderOps()}));w.append(row)});let add=button('+ Add caption',()=>{if(o.segments.length<200){o.segments.push({start:0,end:2,text:''});renderOps()}});w.append(add);f.append(w)}card.append(f);root.append(card)});$('noOps').hidden=ops.length>0;$('opCount').textContent=`${ops.length} / 20`;$('opButtons').querySelectorAll('button').forEach(b=>b.disabled=ops.length>=20);updateJSON();syncButtons()}
function instructions(){return {schema_version:'1.0',operations:ops.map(o=>{if(o.op!=='shorten_segment')return o;const {boundary,keep,...rest}=o;if(keep)rest.keep=keep;if(boundary!=='')rest[o.segment==='intro'?'segment_end_s':'segment_start_s']=boundary;return rest})}}
function updateJSON(){$('jsonPreview').textContent=JSON.stringify(instructions(),null,2)}
function validate(){if(!videoFile)throw Error('Select a video first.');if(!ops.length)throw Error('Add at least one operation.');for(const [i,o] of ops.entries()){const n=(v,min,max=Infinity)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=200;let ok=true;if(o.op==='cut_range')ok=n(o.start,0)&&n(o.end,0)&&o.end>o.start;if(o.op==='shorten_segment')ok=n(o.target_duration_s,.001,3600)&&(o.boundary===''||n(o.boundary,0));if(o.op==='overlay_text')ok=text(o.text)&&n(o.at,0)&&n(o.duration,.001,60)&&Number.isInteger(o.max_words_per_line)&&n(o.max_words_per_line,1,12);if(o.op==='captions')ok=o.segments.length>0&&o.segments.every(s=>text(s.text)&&n(s.start,0)&&n(s.end,0)&&s.end>s.start)&&Number.isInteger(o.max_words_per_line)&&n(o.max_words_per_line,1,12);if(!ok)throw Error(`Operation ${i+1}: enter valid text and times.`)}}
function syncButtons(){$('render').disabled=!connected||!videoFile||!ops.length||busy;$('resume').disabled=!connected||!jobId;$('loadJob').disabled=!connected||busy;$('download').disabled=!connected||jobStatus!=='completed';$('disconnect').hidden=!connected;$('outputTab').disabled=!outputURL}
function connection(ok,msg){connected=ok;$('dot').className='dot '+(ok?'ok':'bad');$('connectionText').textContent=ok?'Connected':'Not connected';$('authMessage').textContent=msg||'';$('authMessage').className='notice '+(ok?'success':'');syncButtons()}
function detail(data,status){return data?.message||data?.details?.map?.(d=>`${d.loc}: ${d.msg}`).join('\n')||data?.detail||data?.error||`HTTP ${status}`}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{...opts.headers,Authorization:`Bearer ${token}`},cache:'no-store'});if(!r.ok){let d;try{d=await r.json()}catch{}throw Error(detail(d,r.status))}return r}
$('showKey').onclick=()=>{const e=$('key');e.type=e.type==='password'?'text':'password';$('showKey').textContent=e.type==='password'?'Show':'Hide'};
$('connect').onclick=async()=>{const key=$('key').value.trim();if(!key){connection(false,'Paste the API key from Render Environment.');return}token=key;$('connect').disabled=true;try{let r=await api('/health');let j=await r.json();if(j.status!=='ok')throw Error(j.message||'Renderer unavailable');$('key').value='';$('key').type='password';$('showKey').textContent='Show';connection(true,`FFmpeg ${j.ffmpeg} is available.`)}catch(e){token='';connection(false,e.message)}finally{$('connect').disabled=false}};
$('disconnect').onclick=()=>{token='';$('key').value='';stopPolling();busy=false;clearOutput();jobId='';jobStatus='';setProgress('Ready',0,'Disconnected.');$('jobId').textContent='No active job';connection(false,'Disconnected.');$('dot').className='dot'};
function clearOutput(){if(outputURL)URL.revokeObjectURL(outputURL);outputURL='';outputBlob=null;$('outputVideo').removeAttribute('src');$('outputVideo').load();showPreview('source');syncButtons()}
function showPreview(mode){previewMode=mode==='output'&&outputURL?'output':'source';$('sourceVideo').hidden=previewMode!=='source'||!sourceURL;$('outputVideo').hidden=previewMode!=='output'||!outputURL;$('previewEmpty').hidden=!!(previewMode==='source'?sourceURL:outputURL);$('sourceTab').classList.toggle('active',previewMode==='source');$('outputTab').classList.toggle('active',previewMode==='output');$('previewMeta').textContent=previewMode==='source'?'Original video':'Rendered video';let v=previewMode==='source'?$('sourceVideo'):$('outputVideo');$('durationMeta').textContent=Number.isFinite(v.duration)?`${v.duration.toFixed(1)} s`:'—';if(previewMode==='source')$('outputVideo').pause();else $('sourceVideo').pause()}
$('sourceTab').onclick=()=>showPreview('source');$('outputTab').onclick=()=>showPreview('output');$('sourceVideo').onloadedmetadata=()=>showPreview(previewMode);$('outputVideo').onloadedmetadata=()=>showPreview(previewMode);
function selectFile(f){$('fileError').textContent='';if(!f)return;if(!/\.(mp4|mov)$/i.test(f.name)){ $('fileError').textContent='Choose an MP4 or MOV video.';return}if(sourceURL)URL.revokeObjectURL(sourceURL);videoFile=f;sourceURL=URL.createObjectURL(f);$('sourceVideo').src=sourceURL;$('fileName').textContent=`${f.name} • ${(f.size/1048576).toFixed(1)} MB`;$('fileInfo').hidden=false;showPreview('source');syncButtons()}
$('file').onchange=e=>selectFile(e.target.files[0]);$('drop').onclick=()=>$('file').click();$('drop').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file').click()}};for(const event of ['dragover','dragenter'])$('drop').addEventListener(event,e=>{e.preventDefault();$('drop').classList.add('drag')});$('drop').ondragleave=()=>$('drop').classList.remove('drag');$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('drag');selectFile(e.dataTransfer.files[0])};$('removeFile').onclick=()=>{videoFile=null;$('file').value='';if(sourceURL)URL.revokeObjectURL(sourceURL);sourceURL='';$('sourceVideo').removeAttribute('src');$('sourceVideo').load();$('fileInfo').hidden=true;showPreview('source');syncButtons()};
$('opButtons').onclick=e=>{let name=e.target.dataset.add;if(name&&ops.length<20){ops.push(defaults[name]());renderOps()}};
function setProgress(state,p,msg){const pct=Math.max(0,Math.min(100,Number(p)||0));$('jobState').textContent=state;$('percent').textContent=`${pct}%`;$('bar').style.width=pct+'%';$('progress').setAttribute('aria-valuenow',pct);$('jobMessage').textContent=msg}
function stopPolling(){pollEpoch++;clearTimeout(pollTimer);pollTimer=null}
function schedule(epoch){clearTimeout(pollTimer);pollTimer=setTimeout(()=>poll(epoch),1800)}
async function poll(epoch=pollEpoch){if(!jobId||!connected||epoch!==pollEpoch)return;try{const r=await api(`/v1/render-jobs/${jobId}`);const j=await r.json();if(epoch!==pollEpoch)return;jobStatus=j.status;$('jobId').textContent=`Job: ${jobId}`;setProgress(j.status,j.progress,j.status==='completed'?'Your video is ready.':j.status==='failed'?'Rendering failed.':'Processing video…');$('jobError').textContent=j.error||'';busy=!['completed','failed'].includes(j.status);syncButtons();if(busy)schedule(epoch);else if(j.status==='completed'&&!outputBlob){$('jobMessage').textContent='Video ready. Download or preview below.';await loadOutput(epoch)}}catch(e){if(epoch!==pollEpoch)return;busy=false;$('jobError').textContent=`Status check failed: ${e.message}. Use Refresh status to retry.`;syncButtons()}}
async function loadOutput(epoch=pollEpoch){if(outputBlob)return outputBlob;const r=await api(`/v1/render-jobs/${jobId}/output`);const b=await r.blob();if(epoch!==pollEpoch)return null;outputBlob=b;outputURL=URL.createObjectURL(b);$('outputVideo').src=outputURL;showPreview('output');syncButtons();return b}
$('render').onclick=async()=>{$('formError').textContent='';$('jobError').textContent='';try{validate();stopPolling();clearOutput();jobId='';jobStatus='';$('jobId').textContent='Submitting new job…';busy=true;syncButtons();setProgress('Uploading',0,'Sending video to renderer…');let data=new FormData();data.append('video',videoFile,videoFile.name);data.append('instructions',JSON.stringify(instructions()));let epoch=pollEpoch;const r=await api('/v1/render-jobs',{method:'POST',body:data});let j=await r.json();if(epoch!==pollEpoch)return;jobId=j.job_id;jobStatus=j.status;$('existingId').value=jobId;await poll(epoch)}catch(e){busy=false;$('formError').textContent=e.message;setProgress('Error',0,'Could not start the render.');syncButtons()}};
$('resume').onclick=()=>{stopPolling();poll(pollEpoch)};$('loadJob').onclick=()=>{let id=$('existingId').value.trim();if(!/^rj_[0-9a-f]{8}$/.test(id)){$('jobError').textContent='Enter a valid job ID.';return}stopPolling();clearOutput();jobId=id;jobStatus='';$('jobError').textContent='';busy=true;syncButtons();poll(pollEpoch)};
$('download').onclick=async()=>{try{$('download').disabled=true;let b=await loadOutput();if(!b)return;const a=node('a');a.href=outputURL;a.download=`${jobId}.mp4`;document.body.append(a);a.click();a.remove()}catch(e){$('jobError').textContent=e.message}finally{syncButtons()}};
renderOps();
</script></body></html>

'''
