export type AuthPageMode = "login" | "register" | "reset";

const ASSET_PATHS = {
  splashBackdrop: "/assets/images/splash_cinema_backdrop_1795732203957.jpg",
  authArtwork: "/assets/images/auth_studio_artwork_1795732204399.jpg",
  reelCinema: "/assets/images/reel_frame_cinema_1795732204514.jpg",
  reelUrban: "/assets/images/reel_frame_urban_1795732205337.jpg",
};

const FONT_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;

const LOGO_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4M10 9l5 3-5 3z"/></svg>`;

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

export const SPLASH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="rh-boot" content="__RH_BOOT_TOKEN__">
<meta name="rh-fb" content="__RH_FB_CONFIG__">
<title>REELHOUSE — Make Every Second Count.</title>
${FONT_HEAD}
<style>
:root{--bg:#09090e;--surface:#13141f;--border:rgba(255,255,255,.1);--text:#f5f5fa;--muted:#a3a8be;--accent:#b4a2ff;--indigo:#635bff;--purple:#8060ee}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font-family:'Plus Jakarta Sans',system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
.splash{position:relative;min-height:100vh;display:grid;place-items:center;padding:32px;isolation:isolate;opacity:1;transition:opacity .32s cubic-bezier(.16,1,.3,1)}
.splash.leaving{opacity:0}
.backdrop{position:absolute;inset:0;z-index:-3;overflow:hidden;background:radial-gradient(circle at 50% 30%,rgba(128,96,238,.22),transparent 55%),radial-gradient(circle at 80% 75%,rgba(99,91,255,.16),transparent 50%),#09090e}
.backdrop img{width:100%;height:100%;object-fit:cover;opacity:.28;filter:saturate(.9) contrast(1.05);transform:scale(1.03);animation:bgDrift 14s ease-out forwards}
.scrim{position:absolute;inset:0;z-index:-2;background:radial-gradient(circle at 50% 48%,rgba(9,9,14,.42) 0%,rgba(9,9,14,.88) 70%,#09090e 100%)}
.glow{position:absolute;width:620px;height:620px;border-radius:50%;background:radial-gradient(circle,rgba(128,96,238,.22) 0%,rgba(99,91,255,.08) 45%,transparent 70%);filter:blur(32px);z-index:-1;pointer-events:none}
.frames{position:absolute;inset:0;pointer-events:none;z-index:-1;max-width:1280px;margin:auto}
.frame-card{position:absolute;width:168px;aspect-ratio:9/16;border-radius:16px;overflow:hidden;border:1px solid rgba(180,162,255,.22);background:linear-gradient(155deg,#1d1930,#0f101a);box-shadow:0 28px 70px rgba(0,0,0,.6);opacity:0}
.frame-card img{width:100%;height:100%;object-fit:cover;display:block;opacity:.82}
.frame-card::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(9,9,14,.75) 100%)}
.frame-left{left:6%;top:18%;transform:translate3d(0,18px,0) rotate(-6deg);animation:frameInLeft .85s .1s cubic-bezier(.16,1,.3,1) forwards,floatSlow 7s 1s ease-in-out infinite}
.frame-right{right:6%;bottom:16%;transform:translate3d(0,22px,0) rotate(6deg);animation:frameInRight .85s .2s cubic-bezier(.16,1,.3,1) forwards,floatSlowAlt 8s 1.1s ease-in-out infinite}
.center{text-align:center;max-width:540px;width:100%;animation:logoEnter .65s cubic-bezier(.16,1,.3,1) both}
.brand-mark{width:68px;height:68px;margin:0 auto 22px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(135deg,#8c6eff,#5c4ae6);color:#fff;box-shadow:0 18px 46px rgba(128,96,238,.36),inset 0 1px 0 rgba(255,255,255,.25)}
.brand-mark svg{width:32px;height:32px}
.wordmark{margin:0;font-size:clamp(2rem,4vw,2.9rem);font-weight:800;letter-spacing:.16em;text-indent:.16em;line-height:1.1;color:#fff}
.tagline{margin:12px 0 30px;font-size:17px;font-weight:500;color:var(--muted);letter-spacing:-.01em}
.loader-wrap{width:220px;margin:0 auto}
.loader-track{height:3px;width:100%;background:rgba(255,255,255,.12);border-radius:99px;overflow:hidden}
.loader-bar{height:100%;width:42%;border-radius:99px;background:linear-gradient(90deg,var(--indigo),var(--accent));transform:translateX(-110%);animation:indeterminate 1.25s cubic-bezier(.4,0,.2,1) infinite}
.loader-text{margin:12px 0 0;font-size:12px;color:var(--muted);letter-spacing:.02em;font-variant-numeric:tabular-nums}
.fallback-actions{margin-top:20px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 20px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:#fff;font-weight:600;font-size:13px;text-decoration:none}
.btn:hover{background:rgba(255,255,255,.12)}
@keyframes logoEnter{from{opacity:0;transform:translate3d(0,14px,0) scale(.97)}to{opacity:1;transform:translate3d(0,0,0) scale(1)}}
@keyframes frameInLeft{to{opacity:.9;transform:translate3d(0,0,0) rotate(-6deg)}}
@keyframes frameInRight{to{opacity:.9;transform:translate3d(0,0,0) rotate(6deg)}}
@keyframes floatSlow{0%,100%{transform:translate3d(0,0,0) rotate(-6deg)}50%{transform:translate3d(0,-10px,0) rotate(-5deg)}}
@keyframes floatSlowAlt{0%,100%{transform:translate3d(0,0,0) rotate(6deg)}50%{transform:translate3d(0,-12px,0) rotate(7deg)}}
@keyframes bgDrift{from{transform:scale(1.06)}to{transform:scale(1.01)}}
@keyframes indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}
@media(max-width:900px){.frame-card{width:118px;opacity:.45}.frame-left{left:3%;top:10%}.frame-right{right:3%;bottom:10%}}
@media(max-width:560px){.frame-card{display:none}.splash{padding:24px}}
@media(prefers-reduced-motion:reduce){.backdrop img,.frame-card,.center,.loader-bar,.splash{animation:none!important;transition:none!important}.frame-card{opacity:.75}.loader-bar{width:100%;transform:none}}
</style>
</head>
<body>
<main class="splash" id="splash">
  <div class="backdrop">
    <img src="${ASSET_PATHS.splashBackdrop}" alt="" referrerpolicy="no-referrer">
  </div>
  <div class="scrim"></div>
  <div class="glow" aria-hidden="true"></div>
  <div class="frames" aria-hidden="true">
    <div class="frame-card frame-left">
      <img src="${ASSET_PATHS.reelCinema}" alt="" referrerpolicy="no-referrer">
    </div>
    <div class="frame-card frame-right">
      <img src="${ASSET_PATHS.reelUrban}" alt="" referrerpolicy="no-referrer">
    </div>
  </div>
  <section class="center" aria-label="Loading REELHOUSE">
    <div class="brand-mark">${LOGO_SVG}</div>
    <h1 class="wordmark">REELHOUSE</h1>
    <p class="tagline">Make Every Second Count.</p>
    <div class="loader-wrap">
      <div class="loader-track" role="progressbar" aria-label="Checking authentication status">
        <div class="loader-bar"></div>
      </div>
      <p class="loader-text" id="splashStatus">Checking session…</p>
    </div>
    <div class="fallback-actions" id="fallbackActions" hidden>
      <a class="btn" href="/login">Continue to sign in</a>
    </div>
  </section>
</main>
<script src="/studio-auth.js"></script>
<script>
'use strict';
(async function(){
  const statusEl = document.getElementById('splashStatus');
  const splashEl = document.getElementById('splash');
  const fallbackEl = document.getElementById('fallbackActions');
  const bootToken = (document.querySelector('meta[name="rh-boot"]')?.getAttribute('content') || '').replace('__RH_BOOT_TOKEN__', '');
  let fbConfig = null;
  try {
    const raw = document.querySelector('meta[name="rh-fb"]')?.getAttribute('content') || '';
    if (raw && raw !== '__RH_FB_CONFIG__' && raw !== 'null') fbConfig = JSON.parse(raw);
  } catch {}
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const startedAt = Date.now();
  const minDelay = reduced ? 0 : 420;

  function go(url){
    const wait = Math.max(0, minDelay - (Date.now() - startedAt));
    setTimeout(() => {
      if (!reduced) splashEl.classList.add('leaving');
      setTimeout(() => window.location.replace(url), reduced ? 0 : 220);
    }, wait);
  }

  async function fetchWithTimeout(url, opts, ms){
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function withTimeout(promise, ms){
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Request timed out')), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  async function syncServerSession(forceRefresh){
    const idToken = await withTimeout(fbApi.getIdToken(Boolean(forceRefresh)), 8000);
    if (!idToken) return { ok: false, reason: 'missing_token' };
    const headers = { 'X-Requested-With': 'ReelhouseStudio', 'Authorization': 'Bearer ' + idToken };
    if (bootToken) headers['X-Studio-Boot'] = bootToken;
    const r = await fetchWithTimeout('/v1/studio/session', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers }, 10000);
    if (r.status === 401 && !forceRefresh) {
      return syncServerSession(true);
    }
    if (!r.ok) return { ok: false, reason: 'session_failed' };
    const chkRes = await fetchWithTimeout('/v1/studio/session-check', { credentials: 'same-origin', cache: 'no-store' }, 5000);
    const chk = chkRes.ok ? await chkRes.json().catch(() => null) : null;
    if (!chk || !chk.cookie_ok) return { ok: false, reason: 'cookie_blocked' };
    return { ok: true };
  }

  const fbApi = window.ReelhouseFirebase || null;
  if (!fbConfig || !fbApi) {
    statusEl.textContent = 'Opening workspace…';
    go('/dashboard');
    return;
  }

  let handled = false;
  const safetyTimer = setTimeout(() => {
    if (!handled) {
      statusEl.textContent = 'Redirecting to sign in…';
      fallbackEl.hidden = false;
      go('/login');
    }
  }, 6000);

  try {
    const ok = await fbApi.initFirebaseAuth(fbConfig);
    if (!ok) {
      clearTimeout(safetyTimer);
      go('/dashboard');
      return;
    }
    const unsub = fbApi.onAuthStateChanged(async (user) => {
      if (handled) return;
      handled = true;
      clearTimeout(safetyTimer);
      unsub();
      if (!user) {
        statusEl.textContent = 'Redirecting to sign in…';
        go('/login');
        return;
      }
      statusEl.textContent = 'Preparing workspace…';
      try {
        const res = await syncServerSession(false);
        if (res.ok) {
          go('/dashboard');
          return;
        }
        go('/login?auth_err=' + encodeURIComponent(res.reason || 'session'));
        return;
      } catch {}
      go('/login?auth_err=session');
    });
  } catch {
    handled = true;
    clearTimeout(safetyTimer);
    go('/login');
  }
})();
</script>
</body>
</html>`;

export function renderAuthPageHtml(mode: AuthPageMode): string {
  const metaTitle =
    mode === "register"
      ? "Create account — REELHOUSE"
      : mode === "reset"
        ? "Reset password — REELHOUSE"
        : "Sign in — REELHOUSE";

  const heading =
    mode === "register"
      ? "Create your studio account"
      : mode === "reset"
        ? "Reset your password"
        : "Welcome back";

  const subheading =
    mode === "register"
      ? "Start editing vertical reels and syncing renders to your private workspace."
      : mode === "reset"
        ? "Enter your account email and we will send you a password reset link."
        : "Sign in to access your workspace and connect to the rendering engine.";

  const submitLabel =
    mode === "register"
      ? "Create account"
      : mode === "reset"
        ? "Send reset link"
        : "Sign in";

  const showGoogle = mode !== "reset";
  const showName = mode === "register";
  const showPassword = mode !== "reset";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="rh-boot" content="__RH_BOOT_TOKEN__">
<meta name="rh-fb" content="__RH_FB_CONFIG__">
<title>${metaTitle}</title>
${FONT_HEAD}
<style>
:root{--bg:#09090e;--panel:rgba(19,20,31,.76);--surface:#12131e;--border:rgba(255,255,255,.11);--border-focus:#a793ff;--text:#f5f5fa;--muted:#a4a9be;--accent:#b4a2ff;--indigo:#635bff;--purple:#8060ee;--green:#76e4ad;--red:#ff9aa2}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0;background:var(--bg);color:var(--text);font-family:'Plus Jakarta Sans',system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button,input{font:inherit}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.split{min-height:100vh;display:grid;grid-template-columns:1.08fr 1fr}
.art-pane{position:relative;overflow:hidden;padding:36px 44px;display:flex;flex-direction:column;justify-content:space-between;background:#0b0b12;border-right:1px solid var(--border);isolation:isolate}
.art-bg{position:absolute;inset:0;z-index:-2}
.art-bg img{width:100%;height:100%;object-fit:cover;opacity:.52;filter:contrast(1.06) saturate(.92)}
.art-scrim{position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(9,9,14,.74) 0%,rgba(9,9,14,.42) 45%,rgba(9,9,14,.94) 100%),radial-gradient(circle at 20% 25%,rgba(128,96,238,.28),transparent 55%)}
.art-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:inline-flex;align-items:center;gap:12px;color:#fff;font-weight:800;font-size:17px;letter-spacing:.12em;white-space:nowrap}
.brand:hover{text-decoration:none}
.brand-box{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,#8c6eff,#5c4ae6);color:#fff;box-shadow:0 10px 26px rgba(128,96,238,.35)}
.reel-showcase{display:flex;align-items:flex-end;gap:16px;margin:28px 0}
.reel-thumb{width:128px;aspect-ratio:9/16;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.18);background:#151624;box-shadow:0 22px 48px rgba(0,0,0,.55);flex-shrink:0}
.reel-thumb.secondary{width:106px;opacity:.88;transform:translateY(-10px)}
.reel-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.art-copy{max-width:500px}
.art-kicker{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:.08em;text-transform:uppercase;margin:0 0 10px}
.art-title{margin:0 0 12px;font-size:clamp(1.85rem,2.7vw,2.55rem);font-weight:800;line-height:1.14;letter-spacing:-.03em;text-wrap:balance}
.art-lead{margin:0 0 24px;color:#cfd3e4;font-size:15px;line-height:1.6}
.highlights{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding-top:20px;border-top:1px solid rgba(255,255,255,.14)}
.hi-title{font-size:13px;font-weight:700;color:#fff;margin:0 0 4px}
.hi-desc{font-size:12px;color:#b8bdd3;margin:0;line-height:1.45}
.form-pane{position:relative;display:grid;place-items:center;padding:32px 24px;background:radial-gradient(circle at 80% 15%,rgba(128,96,238,.14),transparent 45%),radial-gradient(circle at 20% 85%,rgba(99,91,255,.1),transparent 45%),var(--bg)}
.auth-card{width:100%;max-width:430px;padding:32px;border-radius:20px;background:var(--panel);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border:1px solid var(--border);box-shadow:0 28px 80px rgba(0,0,0,.55);animation:cardIn .45s cubic-bezier(.16,1,.3,1) both}
.mobile-brand{display:none;align-items:center;gap:10px;margin-bottom:22px;font-weight:800;font-size:16px;letter-spacing:.12em;color:#fff}
.mode-nav{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;border-radius:11px;background:rgba(9,9,14,.7);border:1px solid rgba(255,255,255,.07);margin-bottom:24px}
.mode-link{display:flex;align-items:center;justify-content:center;min-height:36px;padding:6px 8px;border-radius:8px;font-size:12px;font-weight:650;color:var(--muted);white-space:nowrap;transition:background .15s,color .15s}
.mode-link:hover{color:#fff;text-decoration:none}
.mode-link.active{background:#292a3d;color:#fff}
h1{margin:0 0 6px;font-size:24px;font-weight:750;letter-spacing:-.025em;text-wrap:balance}
.sub{margin:0 0 22px;font-size:14px;color:var(--muted);line-height:1.5}
.btn{width:100%;min-height:44px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);font-weight:650;font-size:14px;display:inline-flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;white-space:nowrap;transition:transform .12s,background .15s,border-color .15s}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-google{background:#f6f6fb;color:#11121a;border-color:#e3e5f0}
.btn-google:hover:not(:disabled){background:#ffffff}
.btn-primary{background:linear-gradient(135deg,#8768ff,#6655ee);border-color:transparent;color:#fff;box-shadow:0 10px 26px rgba(114,91,244,.28)}
.btn-primary:hover:not(:disabled){background:linear-gradient(135deg,#977bff,#7465f7)}
.sep{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--muted);font-size:12px}
.sep::before,.sep::after{content:'';flex:1;height:1px;background:var(--border)}
.form{display:grid;gap:14px}
.field label{display:block;font-size:12px;font-weight:600;color:#d2d6e7;margin-bottom:6px}
.input-wrap{position:relative}
input{width:100%;min-height:44px;padding:10px 13px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(9,9,14,.72);color:#fff;font-size:14px;transition:border-color .15s,background .15s}
input::placeholder{color:#6f748d}
input:focus{border-color:var(--border-focus);background:rgba(12,13,22,.92)}
.pw-input{padding-right:64px}
.pw-toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:var(--muted);padding:6px 10px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer}
.pw-toggle:hover{color:#fff;background:rgba(255,255,255,.07)}
.row-between{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px}
.status{min-height:20px;margin-top:14px;font-size:13px;line-height:1.45;color:var(--red)}
.status.ok{color:var(--green)}
.retry-row{display:flex;gap:8px;margin-top:10px}
.btn-secondary{background:rgba(255,255,255,.06);color:#e7e9f5;border-color:rgba(255,255,255,.14);min-height:38px;font-size:13px}
.btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.12)}
.footer-note{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
[hidden]{display:none!important}
@keyframes cardIn{from{opacity:0;transform:translate3d(0,12px,0)}to{opacity:1;transform:translate3d(0,0,0)}}
@media(max-width:980px){.split{grid-template-columns:1fr}.art-pane{display:none}.mobile-brand{display:inline-flex}.form-pane{padding:24px 16px}.auth-card{padding:26px 20px}}
@media(prefers-reduced-motion:reduce){.auth-card{animation:none!important}}
</style>
</head>
<body>
<div class="split">
  <aside class="art-pane">
    <div class="art-bg"><img src="${ASSET_PATHS.authArtwork}" alt="Dark video editing workstation bathed in violet studio lighting" referrerpolicy="no-referrer"></div>
    <div class="art-scrim"></div>
    <div class="art-top">
      <a class="brand" href="/login">
        <span class="brand-box">${LOGO_SVG}</span>
        <span>REELHOUSE</span>
      </a>
    </div>
    <div>
      <div class="reel-showcase" aria-hidden="true">
        <div class="reel-thumb"><img src="${ASSET_PATHS.reelCinema}" alt="" referrerpolicy="no-referrer"></div>
        <div class="reel-thumb secondary"><img src="${ASSET_PATHS.reelUrban}" alt="" referrerpolicy="no-referrer"></div>
      </div>
      <div class="art-copy">
        <p class="art-kicker">REELHOUSE Studio</p>
        <h2 class="art-title">Make Every Second Count.</h2>
        <p class="art-lead">Upload raw footage, reframe to 9:16, place responsive captions, and preview frame-accurate MP4 renders in one private workspace.</p>
      </div>
      <div class="highlights">
        <div>
          <p class="hi-title">9:16 Smart Reframe</p>
          <p class="hi-desc">Crisp 1080×1920 vertical crop or padded export.</p>
        </div>
        <div>
          <p class="hi-title">Adaptive Captions</p>
          <p class="hi-desc">Auto-wrapped overlays aligned with final output.</p>
        </div>
        <div>
          <p class="hi-title">Private Render Queue</p>
          <p class="hi-desc">Jobs and streamed outputs stay isolated to you.</p>
        </div>
      </div>
    </div>
  </aside>

  <main class="form-pane">
    <section class="auth-card" aria-label="${heading}">
      <a class="mobile-brand" href="/login">
        <span class="brand-box">${LOGO_SVG}</span>
        <span>REELHOUSE</span>
      </a>
      <nav class="mode-nav" aria-label="Authentication pages">
        <a class="mode-link${mode === "login" ? " active" : ""}" href="/login">Sign in</a>
        <a class="mode-link${mode === "register" ? " active" : ""}" href="/register">Create account</a>
        <a class="mode-link${mode === "reset" ? " active" : ""}" href="/reset-password">Reset password</a>
      </nav>
      <h1>${heading}</h1>
      <p class="sub">${subheading}</p>

      ${
        showGoogle
          ? `<button class="btn btn-google" id="googleBtn" type="button">${GOOGLE_SVG}<span>Continue with Google</span></button>
      <div class="sep"><span>or continue with email</span></div>`
          : ""
      }

      <form class="form" id="authForm" novalidate>
        ${
          showName
            ? `<div class="field">
          <label for="nameInput">Full name (optional)</label>
          <input id="nameInput" type="text" autocomplete="name" maxlength="80" placeholder="Alex Rivera">
        </div>`
            : ""
        }
        <div class="field">
          <label for="emailInput">Email address</label>
          <input id="emailInput" type="email" autocomplete="email" required placeholder="you@example.com">
        </div>
        ${
          showPassword
            ? `<div class="field">
          <div class="row-between">
            <label for="passwordInput">Password</label>
            ${mode === "login" ? `<a href="/reset-password">Forgot password?</a>` : ""}
          </div>
          <div class="input-wrap">
            <input class="pw-input" id="passwordInput" type="password" autocomplete="${mode === "register" ? "new-password" : "current-password"}" minlength="6" required placeholder="Enter password">
            <button class="pw-toggle" id="pwToggle" type="button" aria-label="Show password" aria-pressed="false">Show</button>
          </div>
        </div>`
            : ""
        }
        <button class="btn btn-primary" id="submitBtn" type="submit">${submitLabel}</button>
      </form>

      <div class="status" id="statusMsg" role="status" aria-live="polite"></div>
      <div class="retry-row" id="retryRow" hidden>
        <button class="btn btn-secondary" id="retryConnBtn" type="button">Retry connection</button>
        <button class="btn btn-secondary" id="switchAcctBtn" type="button">Sign out</button>
      </div>

      <div class="footer-note">
        ${
          mode === "login"
            ? `<span>New to REELHOUSE?</span><a href="/register">Create an account →</a>`
            : mode === "register"
              ? `<span>Already have an account?</span><a href="/login">Sign in →</a>`
              : `<span>Remembered your password?</span><a href="/login">Back to sign in →</a>`
        }
      </div>
    </section>
  </main>
</div>

<script src="/studio-auth.js"></script>
<script>
'use strict';
(async function(){
  const mode = ${JSON.stringify(mode)};
  const $ = id => document.getElementById(id);
  let bootToken = (document.querySelector('meta[name="rh-boot"]')?.getAttribute('content') || '').replace('__RH_BOOT_TOKEN__', '');
  let fbConfig = null;
  try {
    const raw = document.querySelector('meta[name="rh-fb"]')?.getAttribute('content') || '';
    if (raw && raw !== '__RH_FB_CONFIG__' && raw !== 'null') fbConfig = JSON.parse(raw);
  } catch {}

  const fbApi = window.ReelhouseFirebase || null;
  const params = new URLSearchParams(window.location.search);
  const nextRaw = params.get('next') || '';
  const authErrParam = params.get('auth_err') || '';
  const targetPath = nextRaw === '/dashboard' ? '/dashboard' : '/dashboard';
  let busy = false;
  let redirecting = false;
  let manualAuthActive = false;

  function setStatus(msg, isOk){
    const el = $('statusMsg');
    el.textContent = msg || '';
    el.className = 'status' + (isOk ? ' ok' : '');
  }

  function showRetryControls(show){
    if ($('retryRow')) $('retryRow').hidden = !show;
  }

  function setBusy(flag){
    busy = flag;
    if ($('googleBtn')) $('googleBtn').disabled = flag;
    if ($('submitBtn')) $('submitBtn').disabled = flag;
    if ($('emailInput')) $('emailInput').disabled = flag;
    if ($('passwordInput')) $('passwordInput').disabled = flag;
    if ($('nameInput')) $('nameInput').disabled = flag;
    if ($('retryConnBtn')) $('retryConnBtn').disabled = flag;
    if ($('switchAcctBtn')) $('switchAcctBtn').disabled = flag;
  }

  function mapError(err){
    const code = err?.code || '';
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') return 'Incorrect email or password.';
    if (code === 'auth/email-already-in-use') return 'An account with this email already exists. Try signing in.';
    if (code === 'auth/weak-password') return 'Password must be at least 6 characters.';
    if (code === 'auth/invalid-email') return 'Please enter a valid email address.';
    if (code === 'auth/popup-closed-by-user') return 'Google sign-in was closed before completing.';
    if (code === 'auth/popup-blocked') return 'Popup blocked by browser. Allow popups for this site and try again.';
    if (code === 'auth/unauthorized-domain') return 'This domain is not authorized in Firebase Authentication settings.';
    if (code === 'auth/operation-not-allowed') return 'Email/Password sign-in is not enabled in the Firebase Console yet.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a moment before trying again.';
    if (code === 'auth/network-request-failed') return 'Network error contacting authentication service.';
    return err?.message || 'Authentication failed.';
  }

  async function fetchWithTimeout(url, opts, ms){
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Connection timed out while contacting the render workspace. Please retry.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function withTimeout(promise, ms, msg){
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(msg)), ms);
      promise.then(
        val => { clearTimeout(timer); resolve(val); },
        err => { clearTimeout(timer); reject(err); }
      );
    });
  }

  async function refreshBootToken(){
    const r = await fetchWithTimeout(window.location.pathname, { credentials: 'same-origin', cache: 'no-store' }, 8000);
    if (!r.ok) return;
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nextBoot = doc.querySelector('meta[name="rh-boot"]')?.getAttribute('content') || '';
    if (nextBoot && nextBoot !== '__RH_BOOT_TOKEN__') bootToken = nextBoot;
  }

  async function completeBackendLogin(forceRefresh, allowBootRetry = true){
    if (redirecting) return;
    redirecting = true;
    showRetryControls(false);
    setBusy(true);
    setStatus('Connecting to render workspace…', true);
    try {
      const idToken = await withTimeout(
        fbApi.getIdToken(Boolean(forceRefresh)),
        10000,
        'Authentication token request timed out. Please retry.'
      );
      if (!idToken) throw new Error('Could not read Firebase authentication token.');
      const headers = { 'X-Requested-With': 'ReelhouseStudio', 'Authorization': 'Bearer ' + idToken };
      if (bootToken) headers['X-Studio-Boot'] = bootToken;
      const r = await fetchWithTimeout(
        '/v1/studio/session',
        { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers },
        12000
      );
      if (r.status === 403 && allowBootRetry) {
        redirecting = false;
        await refreshBootToken();
        return completeBackendLogin(forceRefresh, false);
      }
      if (r.status === 401 && !forceRefresh) {
        redirecting = false;
        return completeBackendLogin(true, allowBootRetry);
      }
      if (!r.ok) {
        let d;
        try { d = await r.json(); } catch {}
        throw new Error(d?.message || ('Unable to establish workspace session (HTTP ' + r.status + ').'));
      }
      const chkRes = await fetchWithTimeout('/v1/studio/session-check', { credentials: 'same-origin', cache: 'no-store' }, 6000);
      const chk = chkRes.ok ? await chkRes.json().catch(() => null) : null;
      if (!chk || !chk.cookie_ok) {
        throw new Error('Your browser did not save the workspace session cookie. Allow cookies for this site and click Retry connection.');
      }
      window.location.replace(targetPath);
    } catch (err) {
      redirecting = false;
      setStatus(err?.message || 'Could not connect to workspace.', false);
      showRetryControls(Boolean(fbApi && fbApi.getCurrentUser()));
      setBusy(false);
    }
  }

  const pwToggle = $('pwToggle');
  const pwInput = $('passwordInput');
  if (pwToggle && pwInput) {
    pwToggle.onclick = () => {
      const hidden = pwInput.type === 'password';
      pwInput.type = hidden ? 'text' : 'password';
      pwToggle.textContent = hidden ? 'Hide' : 'Show';
      pwToggle.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      pwToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    };
  }

  if ($('retryConnBtn')) {
    $('retryConnBtn').onclick = () => {
      completeBackendLogin(true, true);
    };
  }

  if ($('switchAcctBtn')) {
    $('switchAcctBtn').onclick = async () => {
      setBusy(true);
      showRetryControls(false);
      try {
        await fetch('/v1/studio/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'ReelhouseStudio' } }).catch(() => {});
        if (fbApi) await fbApi.signOut();
        setStatus('Signed out. Sign in with an account to continue.', false);
      } catch (err) {
        setStatus(mapError(err), false);
      } finally {
        setBusy(false);
      }
    };
  }

  if (!fbConfig || !fbApi) {
    window.location.replace('/dashboard');
    return;
  }

  try {
    const initialized = await fbApi.initFirebaseAuth(fbConfig);
    if (!initialized) {
      window.location.replace('/dashboard');
      return;
    }
  } catch (err) {
    setStatus(mapError(err), false);
    return;
  }

  if (authErrParam === 'cookie_blocked') {
    setStatus('Your browser blocked the workspace session cookie. Allow cookies for this site and click Retry connection.', false);
  } else if (authErrParam === 'session_failed' || authErrParam === 'session') {
    setStatus('Could not verify workspace session automatically. Click Retry connection or sign in again.', false);
  }

  fbApi.onAuthStateChanged((user) => {
    if (!user) {
      showRetryControls(false);
      return;
    }
    if (manualAuthActive || mode === 'reset') return;
    if (authErrParam) {
      showRetryControls(true);
      return;
    }
    completeBackendLogin(false, true);
  });

  if ($('googleBtn')) {
    $('googleBtn').onclick = async () => {
      if (busy) return;
      setStatus('', false);
      showRetryControls(false);
      setBusy(true);
      manualAuthActive = true;
      try {
        await fbApi.signInWithGoogle();
        manualAuthActive = false;
        await completeBackendLogin(false, true);
      } catch (err) {
        manualAuthActive = false;
        setStatus(mapError(err), false);
        setBusy(false);
      }
    };
  }

  $('authForm').onsubmit = async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const email = ($('emailInput')?.value || '').trim();
    const password = $('passwordInput')?.value || '';
    const name = ($('nameInput')?.value || '').trim();

    if (!email) {
      setStatus('Please enter your email address.', false);
      return;
    }
    if (mode !== 'reset' && password.length < 6) {
      setStatus('Password must be at least 6 characters.', false);
      return;
    }

    setStatus('', false);
    showRetryControls(false);
    setBusy(true);
    manualAuthActive = mode !== 'reset';
    try {
      if (mode === 'register') {
        await fbApi.registerWithEmail(email, password, name);
        manualAuthActive = false;
        await completeBackendLogin(true, true);
      } else if (mode === 'reset') {
        await fbApi.resetPassword(email);
        setStatus('Password reset email sent to ' + email + '. Check your inbox.', true);
        setBusy(false);
      } else {
        await fbApi.loginWithEmail(email, password);
        manualAuthActive = false;
        await completeBackendLogin(false, true);
      }
    } catch (err) {
      manualAuthActive = false;
      setStatus(mapError(err), false);
      setBusy(false);
    }
  };
})();
</script>
</body>
</html>`;
}
