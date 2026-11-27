export const STUDIO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="rh-boot" content="__RH_BOOT_TOKEN__"><meta name="rh-fb" content="__RH_FB_CONFIG__"><title>REELHOUSE — Content Automation CRM &amp; Render Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
@font-face{font-family:'ReelhouseDejaVu';src:url('/font/DejaVuSans-Bold.ttf') format('truetype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:'ReelhouseDejaVu';src:url('/font/DejaVuSans.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'ReelhouseDejaVuSerif';src:url('/font/DejaVuSerif-Bold.ttf') format('truetype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:'ReelhouseDejaVuSerif';src:url('/font/DejaVuSerif.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'ReelhouseDejaVuMono';src:url('/font/DejaVuSansMono-Bold.ttf') format('truetype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:'ReelhouseDejaVuMono';src:url('/font/DejaVuSansMono.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}
:root{--bg:#0b0b12;--panel:#13141f;--surface:#0e0f17;--border:rgba(255,255,255,.1);--muted:#a3a8be;--text:#f4f4fa;--accent:#b4a2ff;--indigo:#635bff;--purple:#8060ee;--green:#76e4ad;--amber:#f5c542;--red:#ff999d}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% -8%,rgba(128,96,238,.16),transparent 42%),radial-gradient(circle at 88% 0%,rgba(99,91,255,.12),transparent 36%),var(--bg);color:var(--text);font:14px/1.55 'Plus Jakarta Sans',system-ui,-apple-system,Segoe UI,sans-serif}
button,input,select,textarea{font:inherit}
button,a,input,select,textarea{outline-offset:3px}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent)}
button{cursor:pointer}
button:disabled{opacity:.46;cursor:not-allowed}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

.crm-app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.crm-sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;background:rgba(14,15,23,.94);border-right:1px solid var(--border);padding:20px 14px;display:flex;flex-direction:column;gap:18px;z-index:30}
.brand{display:inline-flex;align-items:center;gap:11px;font-weight:800;font-size:16px;letter-spacing:.12em;color:#fff;white-space:nowrap;padding:4px 8px}
.brand:hover{text-decoration:none}
.logo{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(135deg,#8c6eff,#5c4ae6);color:white;box-shadow:0 8px 22px rgba(128,96,238,.3);flex-shrink:0}
.side-group-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#787d96;padding:6px 10px 2px}
.side-nav{display:grid;gap:3px}
.side-link{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;color:var(--muted);font-size:13px;font-weight:600;border:1px solid transparent;transition:background .15s,color .15s,border-color .15s;text-decoration:none}
.side-link:hover{background:rgba(255,255,255,.04);color:#fff;text-decoration:none}
.side-link.active{background:rgba(128,96,238,.16);border-color:rgba(180,162,255,.28);color:#fff}
.side-footer{margin-top:auto;padding-top:14px;border-top:1px solid var(--border);display:grid;gap:6px;padding-left:8px}

.crm-workspace{min-width:0;display:flex;flex-direction:column}
.crm-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 28px;border-bottom:1px solid var(--border);background:rgba(11,11,18,.86);backdrop-filter:blur(12px)}
.topbar-left{display:flex;align-items:center;gap:12px}
.menu-toggle{display:none;min-height:36px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:#fff}
.headright{display:flex;align-items:center;gap:14px;flex-shrink:0;margin-left:auto}
.conn-status{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#888d9c;flex-shrink:0}
.dot.ok{background:var(--green)}
.dot.connecting{background:var(--amber);animation:rhpulse 1.2s ease-in-out infinite}
.dot.bad{background:var(--red)}
@keyframes rhpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.85)}}

.profile-wrap{position:relative}
.profile-btn{display:inline-flex;align-items:center;gap:9px;min-height:38px;padding:4px 10px 4px 5px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:#fff;font-size:13px;font-weight:600;white-space:nowrap}
.profile-btn:hover{background:rgba(255,255,255,.08);border-color:rgba(180,162,255,.35)}
.avatar{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#8c6eff,#5c4ae6);color:#fff;font-weight:750;font-size:12px;display:grid;place-items:center;flex-shrink:0;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover;display:block}
.profile-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.profile-menu{position:absolute;right:0;top:calc(100% + 8px);width:292px;padding:14px;border-radius:14px;background:#161724;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6);z-index:40;display:grid;gap:12px}
.menu-head{padding-bottom:10px;border-bottom:1px solid var(--border)}
.menu-name{font-weight:700;font-size:14px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu-email{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu-conn{display:grid;gap:3px;font-size:12px}
.menu-conn-title{font-weight:650;color:#e7e8f4}
.menu-actions{display:grid;gap:8px;padding-top:4px;border-top:1px solid var(--border)}

.crm-main{max-width:1360px;width:100%;margin:0 auto;padding:26px 28px 54px;display:grid;gap:20px}
.view-header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.eyebrow{color:var(--accent);font-size:12px;font-weight:650;letter-spacing:.04em}
h1{font-size:clamp(1.5rem,2.4vw,2rem);font-weight:800;letter-spacing:-.03em;line-height:1.15;margin:4px 0}
h2{font-size:16px;font-weight:700;margin:0}
h3{font-size:14px;font-weight:650;margin:0}
.muted{color:var(--muted)}
.small{font-size:12px}
.mono{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums}

.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.kpi-card{text-align:left;border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:16px;display:grid;gap:6px;color:var(--text);transition:border-color .15s,transform .15s}
.kpi-card:hover{border-color:rgba(180,162,255,.4);transform:translateY(-1px)}
.kpi-label{font-size:12px;color:var(--muted);font-weight:600}
.kpi-value{font-size:28px;font-weight:800;line-height:1.1;color:#fff}
.kpi-sub{font-size:11px;color:#8e93ab}

.crm-two-col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}
.crm-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:18px;align-items:start}
.studio-grid{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(0,1fr);gap:20px;align-items:start}
.stack{display:grid;gap:18px;min-width:0}
.panel{border:1px solid var(--border);border-radius:15px;background:var(--panel);padding:20px;min-width:0;display:grid;gap:12px}
.subpanel{border:1px solid rgba(255,255,255,.08);border-radius:11px;background:var(--surface);padding:14px;display:grid;gap:8px}
.panelhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.num{color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;margin-right:8px}

.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.02em;text-transform:capitalize;white-space:nowrap}
.badge-neutral{background:rgba(255,255,255,.08);color:#d7daea}
.badge-purple{background:rgba(128,96,238,.2);color:#d4c7ff;border:1px solid rgba(180,162,255,.3)}
.badge-green{background:rgba(118,228,173,.14);color:var(--green);border:1px solid rgba(118,228,173,.28)}
.badge-amber{background:rgba(245,197,66,.14);color:var(--amber);border:1px solid rgba(245,197,66,.28)}
.badge-red{background:rgba(255,153,157,.14);color:var(--red);border:1px solid rgba(255,153,157,.28)}

.list-stack{display:grid;gap:8px}
.list-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-radius:10px;background:var(--surface);border:1px solid rgba(255,255,255,.07)}
.list-meta{min-width:0;display:grid;gap:2px}
.list-title{font-weight:650;font-size:13px;color:#fff;overflow-wrap:anywhere}
.list-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.activity-item{padding:10px 12px;border-radius:9px;background:var(--surface);border:1px solid rgba(255,255,255,.06);display:grid;gap:3px}
.activity-summary{font-size:13px;color:#ececf6}
.activity-meta{font-size:11px;color:var(--muted)}
.meta-kv{display:grid;gap:6px}
.color-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;background:var(--surface);border:1px solid var(--border)}
.color-dot{width:11px;height:11px;border-radius:50%;border:1px solid rgba(255,255,255,.25)}
.script-points{margin:4px 0;padding-left:18px;display:grid;gap:4px}
.inline-info{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:9px 12px;border-radius:9px;background:var(--surface);border:1px solid rgba(255,255,255,.08)}

.btn{min-height:38px;background:#222434;border:1px solid rgba(255,255,255,.12);color:var(--text);padding:8px 14px;border-radius:9px;font-weight:650;font-size:13px;white-space:nowrap;transition:background .15s,border-color .15s}
.btn:hover:not(:disabled){background:#2d3045;border-color:rgba(255,255,255,.2)}
.primary{background:linear-gradient(135deg,#8768ff,#6655ee);border-color:transparent;color:white}
.primary:hover:not(:disabled){background:linear-gradient(135deg,#977bff,#7465f7)}
.btn-danger{background:rgba(255,153,157,.1);border-color:rgba(255,153,157,.28);color:#ffb6ba}
.btn-danger:hover:not(:disabled){background:rgba(255,153,157,.18)}
.full{width:100%}
.mini{padding:5px 9px;font-size:12px;background:#222434;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:var(--text);white-space:nowrap}
.row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.actions .btn{flex:1}

input,select,textarea{width:100%;background:var(--surface);border:1px solid rgba(255,255,255,.13);border-radius:9px;color:var(--text);padding:9px 11px;font-size:13px}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
label{display:block;font-size:12px;font-weight:600;color:#c9cde0;margin-bottom:5px}
.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.wide{grid-column:1/-1}
.check-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer}
.check-row input[type=checkbox]{width:auto}
.keyrow{display:flex;gap:8px;align-items:center}
.keyrow input{flex:1;min-width:0}

.drop{min-height:130px;border:1.5px dashed rgba(180,162,255,.32);border-radius:12px;display:grid;place-items:center;text-align:center;background:var(--surface);padding:18px;cursor:pointer}
.drop:hover,.drop.drag{background:#1b1930;border-color:var(--accent)}
.fileinfo{display:flex;justify-content:space-between;align-items:center;gap:8px;overflow-wrap:anywhere}

.screen{width:100%;aspect-ratio:16/9;background:#08090d;border:1px solid rgba(255,255,255,.1);border-radius:12px;display:grid;place-items:center;overflow:hidden;position:relative;margin:0 auto;max-width:100%}
.preview-stage{position:relative;width:100%;height:100%;background:#000;overflow:hidden}
.preview-stage video{width:100%;height:100%;object-fit:contain;background:#000;display:block;cursor:pointer}
.preview-stage.crop video{object-fit:cover}
.preview-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.safe-zone-guide{position:absolute;inset:0;pointer-events:none;z-index:3}
.safe-zone-inner{position:absolute;border:1.5px dashed rgba(180,162,255,.72);box-shadow:0 0 0 9999px rgba(0,0,0,.18);border-radius:4px}
.safe-zone-label{position:absolute;top:4px;left:6px;font-size:10px;font-weight:700;color:#e5ddff;background:rgba(11,11,18,.72);padding:1px 6px;border-radius:4px}
.pv-line{position:absolute;white-space:pre;line-height:1.164;user-select:none}
.preview-status{position:absolute;inset:0;background:rgba(9,9,14,.84);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:18px;text-align:center;font-size:13px;color:var(--text);z-index:4}
.pv-spinner{width:26px;height:26px;border:3px solid #383a4a;border-top-color:var(--accent);border-radius:50%;animation:rhspin .8s linear infinite}
@keyframes rhspin{to{transform:rotate(360deg)}}
.player-wrap{display:grid;gap:10px}
.player-wrap:fullscreen{background:#000;padding:14px;display:flex;flex-direction:column;justify-content:center;gap:10px}
.player-wrap:fullscreen .screen{flex:1;min-height:0;width:100%!important;max-width:100%!important;max-height:none!important;height:100%;border-color:#222}
.player-bar{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 10px;display:grid;gap:8px}
.player-top,.player-bottom{display:flex;align-items:center;gap:8px}
.player-bottom{justify-content:space-between;flex-wrap:wrap}
.vp-play{min-width:74px}
.vp-seek{flex:1;min-width:90px;padding:0;accent-color:var(--accent);background:transparent;border:0;height:18px;cursor:pointer}
.vp-time,.recent-id{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.vp-vol{display:flex;align-items:center;gap:6px}
.vp-vol input{width:76px;padding:0;accent-color:var(--accent);background:transparent;border:0;height:18px;cursor:pointer}
.vp-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vp-speed{width:auto;padding:4px 8px;font-size:12px;background:#222434;border:1px solid rgba(255,255,255,.14);border-radius:6px}

.tabrow{display:flex;gap:4px;background:var(--surface);border-radius:10px;padding:4px;border:1px solid rgba(255,255,255,.07)}
.tab{border:0;background:transparent;color:var(--muted);border-radius:7px;padding:6px 12px;font-size:12px;font-weight:650;white-space:nowrap}
.tab.active{background:#292b3d;color:white}
.opbuttons{display:flex;flex-wrap:wrap;gap:6px}
.opbuttons .btn{font-size:12px;padding:6px 10px;min-height:34px}
.op{background:var(--surface);border:1px solid rgba(255,255,255,.09);border-radius:11px;padding:14px}
.ophead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.optools{display:flex;gap:4px}
.captionline{display:grid;grid-template-columns:1fr 1fr 2fr auto;gap:6px;align-items:end;margin-bottom:8px}
.progress{height:8px;background:#252736;border-radius:10px;overflow:hidden}
.progress>div{height:100%;width:0;background:linear-gradient(90deg,var(--indigo),var(--accent));transition:width .3s}
.statusrow{display:flex;justify-content:space-between;align-items:center;gap:8px}
.notice{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--red);font-size:12px}
.success{color:var(--green)}
.alert-banner{padding:11px 14px;border-radius:10px;font-size:13px;border:1px solid rgba(245,197,66,.35);background:rgba(245,197,66,.1);color:var(--amber)}
.divider{height:1px;background:var(--border);margin:6px 0}
.empty{text-align:center;color:var(--muted);padding:20px}
.recent-wrap{display:grid;gap:6px}
.recent-list{display:grid;gap:6px;max-height:190px;overflow-y:auto}
.recent-item{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--surface);border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:8px 11px}
.recent-meta{min-width:0}
.recent-id{font-size:12px;font-weight:600}
.recent-sub{font-size:11px;color:var(--muted)}
details summary{cursor:pointer;color:var(--muted);font-size:12px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:'JetBrains Mono',monospace;font-size:11px;color:#c7bcff;background:var(--surface);padding:12px;border-radius:9px;border:1px solid rgba(255,255,255,.08)}

.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.cal-dow{font-size:11px;font-weight:700;color:var(--muted);text-align:center;padding:6px 0}
.cal-cell{min-height:94px;background:var(--surface);border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:7px;display:flex;flex-direction:column;gap:4px}
.cal-dim{opacity:.42}
.cal-date{font-size:11px;color:var(--muted)}
.cal-item{font-size:11px;padding:3px 6px;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-pub{background:rgba(128,96,238,.25);color:#e2d8ff}
.cal-due{background:rgba(245,197,66,.2);color:var(--amber)}

.toast-stack{position:fixed;right:20px;bottom:20px;display:grid;gap:8px;z-index:90;max-width:360px}
.toast{padding:11px 14px;border-radius:10px;background:#1a1b2b;border:1px solid var(--border);color:#fff;font-size:13px;box-shadow:0 14px 36px rgba(0,0,0,.45);transition:opacity .25s}
.toast-ok{border-color:rgba(118,228,173,.4);color:var(--green)}
.toast-err{border-color:rgba(255,153,157,.45);color:var(--red)}
.toast-hide{opacity:0}

[hidden]{display:none!important}
@media(max-width:1024px){
  .crm-app{grid-template-columns:1fr}
  .crm-sidebar{position:fixed;left:0;top:0;bottom:0;width:256px;transform:translateX(-100%);transition:transform .2s ease}
  .crm-sidebar.open{transform:translateX(0)}
  .menu-toggle{display:inline-flex;align-items:center}
  .crm-two-col,.studio-grid{grid-template-columns:1fr}
  .crm-main{padding:20px 16px 40px}
  .crm-topbar{padding:12px 16px}
}
@media(max-width:600px){
  .fields,.captionline{grid-template-columns:1fr}
  .calendar-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cal-dow{display:none}
  .profile-name{display:none}
}
</style></head><body>
<div class="crm-app">
  <aside class="crm-sidebar" id="crmSidebar" aria-label="REELHOUSE CRM navigation">
    <a class="brand" href="#overview" data-crm-nav="overview">
      <span class="logo"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4M10 9l5 3-5 3z"/></svg></span>
      <span>REELHOUSE</span>
    </a>

    <div>
      <div class="side-group-label">CRM &amp; Planning</div>
      <nav class="side-nav">
        <a class="side-link active" href="#overview" data-crm-nav="overview">Overview</a>
        <a class="side-link" href="#clients" data-crm-nav="clients">Clients</a>
        <a class="side-link" href="#ideas" data-crm-nav="ideas">Content Ideas</a>
        <a class="side-link" href="#scripts" data-crm-nav="scripts">Scripts</a>
      </nav>
    </div>

    <div>
      <div class="side-group-label">Production &amp; Review</div>
      <nav class="side-nav">
        <a class="side-link" href="#projects" data-crm-nav="projects">Content Projects</a>
        <a class="side-link" href="#studio" data-crm-nav="studio">Video Studio</a>
        <a class="side-link" href="#review" data-crm-nav="review">Review &amp; Approvals</a>
        <a class="side-link" href="#history" data-crm-nav="history">Revision History</a>
      </nav>
    </div>

    <div>
      <div class="side-group-label">Distribution &amp; Admin</div>
      <nav class="side-nav">
        <a class="side-link" href="#calendar" data-crm-nav="calendar">Content Calendar</a>
        <a class="side-link" href="#publishing" data-crm-nav="publishing">Publishing</a>
        <a class="side-link" href="#settings" data-crm-nav="settings">Settings</a>
      </nav>
    </div>

    <div class="side-footer">
      <a class="small muted" href="/docs" target="_blank" rel="noopener">Developer API Docs ↗</a>
    </div>
  </aside>

  <div class="crm-workspace">
    <header class="crm-topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="sidebarToggle" type="button" aria-label="Toggle CRM navigation">☰ Menu</button>
        <span class="small muted">Content Automation CRM · Make Every Second Count.</span>
      </div>
      <div class="headright">
        <span class="badge badge-neutral" id="roleBadge">Checking role</span>
        <span class="conn-status" id="connection"><span class="dot connecting" id="dot"></span><span id="connectionText">Connecting</span></span>
        <div class="profile-wrap" id="profileWrap">
          <button class="profile-btn" id="profileBtn" type="button" aria-haspopup="menu" aria-expanded="false">
            <span class="avatar" id="userAvatar">R</span>
            <span class="profile-name" id="profileName">Account</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="profile-menu" id="profileMenu" role="menu" hidden>
            <div class="menu-head">
              <div class="menu-name" id="menuName">Signed in</div>
              <div class="menu-email" id="menuEmail"></div>
            </div>
            <div class="menu-conn">
              <div class="menu-conn-title" id="sessionTitle">Connecting to render backend…</div>
              <div class="muted" id="sessionSub">Establishing authenticated server session</div>
              <div class="notice" role="status" id="authMessage"></div>
            </div>
            <div class="menu-actions">
              <button class="btn" id="reconnect" type="button" hidden>Reconnect renderer</button>
              <button class="btn" id="disconnect" type="button" hidden>Disconnect renderer</button>
              <button class="btn btn-danger" id="signOut" type="button">Sign out</button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <main class="crm-main" id="crmMain">
      <section class="panel"><div class="empty">Loading REELHOUSE workspace…</div></section>
    </main>
  </div>
</div>
<script src="/crm-app.js"></script>
</body></html>`;

export const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>REELHOUSE Render Service — API Docs</title>
<style>
body{margin:0;background:#0b0b12;color:#f4f4fa;font:14px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;padding:32px}
.wrap{max-width:920px;margin:auto}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 10px;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:6px}
code,pre{background:#13141f;border:1px solid rgba(255,255,255,.1);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{padding:2px 6px}pre{padding:14px;overflow:auto;color:#c7bcff}.badge{display:inline-block;background:#8060ee;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-right:8px}
a{color:#b4a2ff;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
<p><a href="/dashboard">← Back to REELHOUSE CRM</a></p>
<h1>REELHOUSE Content Automation CRM &amp; Render API (v1.0.0)</h1>
<p>Authentication accepts verified Firebase ID tokens (<code>Authorization: Bearer &lt;FIREBASE_ID_TOKEN&gt;</code>) or the server API key (<code>Authorization: Bearer &lt;API_KEY&gt;</code>) for server-to-server requests. Render jobs and project assets are strictly isolated per authenticated owner/client account, and <code>API_KEY</code> remains strictly server-side.</p>
<p>All protected endpoints enforce rate limiting and return standard <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code>, <code>RateLimit-Reset</code>, and <code>Retry-After</code> headers (HTTP <code>429</code> on limit exceeded).</p>
<h2>Rendering &amp; Project Endpoints</h2>
<p><span class="badge">GET</span><code>/health</code> — Check service, FFmpeg availability, and worker telemetry.</p>
<p><span class="badge">GET</span><code>/v1/crm/integrations</code> — Live worker, storage adapter, research provider, and Meta/TikTok connection status.</p>
<p><span class="badge">POST</span><code>/v1/crm/recommend-ideas</code> — Deterministic tag/category/niche recommender from approved client ideas.</p>
<p><span class="badge">POST</span><code>/v1/revisions/parse</code> — Deterministic client feedback parser returning validated FFmpeg instructions or clarification prompt.</p>
<p><span class="badge">POST</span><code>/v1/captions/parse-srt</code> — Parse uploaded <code>.srt</code> subtitles into validated caption segments.</p>
<p><span class="badge">POST</span><code>/v1/projects/{pid}/assets</code> — Upload raw source footage or reference video (with FFprobe/FFmpeg reference metrics extraction).</p>
<p><span class="badge">GET</span><code>/v1/projects/{pid}/assets/{aid}/status</code> — Check temporary storage availability or expiration of uploaded footage.</p>
<p><span class="badge">POST</span><code>/v1/projects/{pid}/render</code> — Trigger FFmpeg render directly from stored project footage.</p>
<p><span class="badge">GET</span><code>/v1/render-jobs</code> — List render jobs owned by the authenticated user.</p>
<p><span class="badge">POST</span><code>/v1/render-jobs</code> — Multipart form upload with <code>video</code> (.mp4/.mov) and <code>instructions</code> JSON string. Returns <code>202 Accepted</code>.</p>
<p><span class="badge">GET</span><code>/v1/render-jobs/{job_id}</code> — Poll render job status, progress, and <code>output_url</code>.</p>
<p><span class="badge">GET</span><code>/v1/render-jobs/{job_id}/output</code> — Stream (<code>video/mp4</code>, supports HTTP <code>Range</code> / <code>206 Partial Content</code>) or download (<code>?download=1</code>).</p>
<p><span class="badge">POST</span><code>/v1/render-jobs/{job_id}/media-token</code> — Issue short-lived, job-scoped media stream token for browser playback.</p>
<p><span class="badge">POST</span><code>/v1/preview-layout</code> — Compute exact server-side text wrapping, scaling, and social safe-zone layout.</p>
<h2>Instructions Schema (schema_version: "1.0")</h2>
<pre>{
  "schema_version": "1.0",
  "resolution_preset": "export_1080p",
  "operations": [
    { "op": "shorten_segment", "segment": "intro", "target_duration_s": 2, "segment_end_s": 6.5 },
    { "op": "cut_range", "start": 2, "end": 5 },
    { "op": "reframe", "aspect": "9:16", "mode": "blur" },
    { "op": "overlay_text", "text": "Stop scrolling", "at": 0, "duration": 2, "style": "bold-yellow", "font_family": "sans", "max_words_per_line": 4 },
    { "op": "captions", "source": "manual", "style": "bold-yellow", "segments": [{ "start": 0, "end": 2, "text": "Caption line" }] }
  ]
}</pre>
</div></body></html>`;
