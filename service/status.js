// SPDX-License-Identifier: Apache-2.0
// Unified service status page.
//
// Why this exists: pointing a non-technical user at a raw /healthz JSON blob
// is a bad experience. This module gives them one page that says, in plain
// language, whether each service is up.
//
// Why the probing happens server-side: browsers enforce CORS, so a page on
// api.clawinabox.xyz cannot reliably fetch vetara.bio or bodylog.kedache.com
// directly — good services would be shown as broken. Node has no such limit,
// so the page asks *this* server, and this server asks everyone else.

"use strict";

// Each service lists probe paths in priority order. The first one that answers
// with a non-5xx wins. An empty path means "just fetch the origin".
const SERVICES = [
  {
    id: "vetara",
    name: "Vetara",
    blurb: "Pet health navigation — free, for owners",
    url: "https://vetara.bio/",
    probes: ["/"],
    tag: "web",
  },
  {
    id: "vetara-agent",
    name: "Vetara Agent",
    blurb: "The AI vet triage service behind Vetara",
    url: "https://agent.vetara.bio/",
    // measured: /healthz 404s, / answers 200
    probes: ["/"],
    tag: "agent",
  },
  {
    id: "claw-api",
    name: "Claw-in-a-Box — API",
    blurb: "Primary host — NANDA contract + OKX.AI + x402 Bazaar (merged instance)",
    url: "https://api.clawinabox.xyz/",
    probes: ["/healthz"],
    tag: "agent",
    self: true, // this is the host serving the page
  },
  {
    id: "bodylog",
    name: "BodyLog",
    blurb: "Longitudinal health record review",
    url: "https://bodylog.kedache.com/",
    probes: ["/healthz", "/"],
    tag: "agent",
  },
];

// Resource discipline. This page lives on the same box as the API it fronts,
// so a probe storm here takes down the thing it is supposed to report on.
// Every knob below is set to "cheap", not "fresh".
const TIMEOUT_MS = 3000;      // was 6000
const CACHE_MS = 300000;      // 5 minutes (was 20 seconds)
const STALE_OK_MS = 900000;   // serve stale results up to 15 min if a probe run fails
let cache = { at: 0, results: null };
let probing = null;           // single-flight: concurrent requests share one probe run

async function probeOne(svc) {
  const base = svc.url.replace(/\/$/, "");
  const started = Date.now();

  // Probe paths are measured, not guessed — most services need exactly one
  // request. The slice is a belt-and-braces cap: no service gets more than two
  // outbound attempts from a box that is also serving an API.
  for (const p of svc.probes.slice(0, 2)) {
    const target = p === "/" ? base + "/" : base + p;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, {
        method: "GET",
        signal: ctrl.signal,
        headers: { "user-agent": "claw-status/1.0 (+https://api.clawinabox.xyz/status)" },
        redirect: "follow",
      });
      clearTimeout(timer);

      // A probe path that does not exist (404/405) tells us nothing about the
      // service — try the next path. A 5xx means it is there but broken.
      // Anything else (2xx, 3xx, even 401/402) means something is listening
      // and answering, which is what "up" means here.
      if (res.status >= 500 || res.status === 404 || res.status === 405) continue;

      const ms = Date.now() - started;
      let version = null;
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        try {
          const body = await res.json();
          version = body.version || body.service_version || null;
        } catch {
          /* not our shape; status code is enough */
        }
      }
      return {
        id: svc.id,
        name: svc.name,
        blurb: svc.blurb,
        url: svc.url,
        tag: svc.tag,
        state: "up",
        code: res.status,
        latency_ms: ms,
        version,
        probed: p,
      };
    } catch {
      clearTimeout(timer);
      // try the next probe path
    }
  }

  return {
    id: svc.id,
    name: svc.name,
    blurb: svc.blurb,
    url: svc.url,
    tag: svc.tag,
    state: "down",
    code: null,
    latency_ms: Date.now() - started,
    version: null,
    probed: null,
  };
}

async function probeAll() {
  const now = Date.now();
  if (cache.results && now - cache.at < CACHE_MS) return cache.results;

  // Single-flight: if a probe run is already in progress, every other caller
  // waits for it instead of starting a second stampede.
  if (probing) return probing;

  probing = (async () => {
    try {
      // Sequential, not Promise.all: five simultaneous outbound requests is a
      // spike this box does not need. Five sequential 3s-timeout probes take
      // at most 15s, and the result is cached for 5 minutes anyway.
      const results = [];
      for (const svc of SERVICES) {
        results.push(await probeOne(svc));
      }
      cache = { at: Date.now(), results };
      return results;
    } catch (err) {
      // If the run blows up, keep serving the last known good answer rather
      // than retrying immediately.
      if (cache.results && Date.now() - cache.at < STALE_OK_MS) return cache.results;
      throw err;
    } finally {
      probing = null;
    }
  })();

  return probing;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function statusPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service status — Keda Che</title>
<meta name="description" content="Live status of the services I build and run.">
<link rel="icon" type="image/png" href="https://clawinabox.xyz/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --glass:#F6F8FB; --panel:#FFFFFF; --ink:#1D2433; --steel:#8A96A8;
    --line:#E3E9F1; --coral:#E4593C;
    --mint:#1F7A4F; --mint-bg:#E7F6EE;
    --red:#B8352E; --red-bg:#FDECEA;
    --amber:#B97A0A; --amber-bg:#FFF4DE;
    --mono:'IBM Plex Mono',ui-monospace,monospace;
    --disp:'Bricolage Grotesque',system-ui,sans-serif;
  }
  *{box-sizing:border-box;margin:0}
  body{
    background:var(--glass);color:var(--ink);line-height:1.55;
    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    background-image:linear-gradient(var(--line) 1px,transparent 1px),
                     linear-gradient(90deg,var(--line) 1px,transparent 1px);
    background-size:56px 56px;
  }
  a{color:inherit}
  .wrap{max-width:760px;margin:0 auto;padding:0 20px}

  header{padding:40px 0 6px}
  h1{font-family:var(--disp);font-weight:800;letter-spacing:-.025em;font-size:clamp(30px,5vw,42px);line-height:1.05}
  .sub{margin-top:10px;color:#414B5E;font-size:16px;max-width:52ch}

  .banner{margin:26px 0 22px;background:var(--panel);border:2.5px solid var(--ink);border-radius:14px;
    box-shadow:6px 6px 0 rgba(29,36,51,.08);padding:20px 22px;display:flex;align-items:center;
    gap:14px;flex-wrap:wrap}
  .banner .big{font-family:var(--disp);font-weight:800;font-size:19px}
  .banner .meta{font-family:var(--mono);font-size:12px;color:var(--steel);margin-top:2px}
  .beacon{width:14px;height:14px;border-radius:50%;flex:none;
    animation:pulse 2s ease-in-out infinite}
  .beacon.ok{background:var(--mint);box-shadow:0 0 0 4px var(--mint-bg)}
  .beacon.bad{background:var(--red);box-shadow:0 0 0 4px var(--red-bg)}
  .beacon.warn{background:var(--amber);box-shadow:0 0 0 4px var(--amber-bg)}
  .beacon.idle{background:var(--steel);box-shadow:0 0 0 4px var(--line);animation:none}
  button.run{font-family:var(--disp);font-weight:600;font-size:14.5px;padding:9px 18px;
    border:2px solid var(--ink);border-radius:8px;background:var(--coral);color:#fff;
    cursor:pointer;box-shadow:3px 3px 0 var(--ink);transition:transform .08s,box-shadow .08s;flex:none}
  button.run:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink)}
  button.run:disabled{background:var(--steel);cursor:default;box-shadow:2px 2px 0 var(--line);
    border-color:var(--steel);transform:none}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  @media (prefers-reduced-motion:reduce){.beacon{animation:none}}

  .list{display:grid;gap:12px}
  .row{background:var(--panel);border:1.5px solid var(--line);border-radius:12px;padding:16px 18px;
    display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
  .row .nm{font-family:var(--disp);font-weight:600;font-size:16.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .row .bl{font-size:13.5px;color:#414B5E;margin-top:3px}
  .row .lk{font-family:var(--mono);font-size:11.5px;color:var(--steel);margin-top:6px;
    text-decoration:none;border-bottom:1px solid transparent;display:inline-block}
  .row .lk:hover{color:var(--ink);border-bottom-color:var(--coral)}
  .right{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
  .badge{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
    padding:4px 11px;border-radius:999px;border:1.5px solid;white-space:nowrap}
  .badge.up{color:var(--mint);background:var(--mint-bg);border-color:var(--mint)}
  .badge.down{color:var(--red);background:var(--red-bg);border-color:var(--red)}
  .badge.idle{color:var(--steel);background:var(--glass);border-color:var(--line)}
  .lat{font-family:var(--mono);font-size:11.5px;color:var(--steel)}
  .kind{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;
    color:var(--steel);border:1px solid var(--line);border-radius:999px;padding:2px 7px}

  .skeleton{opacity:.45}
  .foot{margin:34px 0 44px;padding-top:20px;border-top:1.5px solid var(--line);
    font-size:13px;color:var(--steel);display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
  .foot a{text-decoration:none;border-bottom:1px solid var(--line)}
  .foot a:hover{color:var(--ink);border-bottom-color:var(--coral)}
  .byline{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line);width:100%;font-size:13px}
  .byline .heart{color:var(--coral)}
  .byline .me{color:var(--ink);font-weight:600;border-bottom-color:var(--coral)}
  button.refresh{font-family:var(--disp);font-weight:600;font-size:13px;padding:7px 14px;
    border:1.5px solid var(--ink);border-radius:8px;background:var(--panel);color:var(--ink);
    cursor:pointer;box-shadow:2px 2px 0 var(--ink)}
  button.refresh:active{transform:translate(1px,1px);box-shadow:1px 1px 0 var(--ink)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Service status</h1>
    <p class="sub">Live checks on the things I build and keep running. Nothing is
    probed until you press the button — opening this page costs nothing.</p>
  </header>

  <div class="banner" id="banner">
    <span class="beacon idle" id="beacon"></span>
    <div style="flex:1">
      <div class="big" id="headline">Ready to check</div>
      <div class="meta" id="stamp">Nothing is probed until you ask — this page costs nothing to open.</div>
    </div>
    <button class="run" id="run">Run check</button>
  </div>

  <div class="list" id="list">
    ${SERVICES.map(
      (s) => `<div class="row skeleton">
      <div>
        <div class="nm">${s.name} <span class="kind">${s.tag}</span></div>
        <div class="bl">${s.blurb}</div>
      </div>
      <div class="right"><span class="badge idle">Not checked</span></div>
    </div>`
    ).join("")}
  </div>

  <div class="foot">
    <p class="byline">
      Made with <span class="heart">❤</span> by <a class="me" href="https://kedache.com">Keda Che</a>
    </p>
  </div>
</div>

<script>
const list = document.getElementById('list');
const beacon = document.getElementById('beacon');
const headline = document.getElementById('headline');
const stamp = document.getElementById('stamp');

function render(data){
  const up = data.services.filter(s => s.state === 'up').length;
  const total = data.services.length;
  const allUp = up === total;
  beacon.className = 'beacon ' + (allUp ? 'ok' : (up === 0 ? 'bad' : 'warn'));
  headline.textContent = allUp
    ? 'All systems operational'
    : (up === 0 ? 'All services unreachable' : up + ' of ' + total + ' services operational');
  stamp.textContent = 'checked ' + new Date(data.checked_at).toLocaleString();
  runBtn.textContent = 'Check again';

  list.innerHTML = data.services.map(s => {
    const badge = s.state === 'up'
      ? '<span class="badge up">Operational</span>'
      : '<span class="badge down">Unreachable</span>';
    const lat = s.state === 'up'
      ? '<span class="lat">' + s.latency_ms + ' ms' + (s.version ? ' · v' + s.version : '') + '</span>'
      : '<span class="lat">no response</span>';
    return '<div class="row">' +
      '<div>' +
        '<div class="nm">' + s.name + ' <span class="kind">' + s.tag + '</span></div>' +
        '<div class="bl">' + s.blurb + '</div>' +
        '<a class="lk" href="' + s.url + '" target="_blank" rel="noopener">' + s.url.replace(/^https:\\/\\//,'').replace(/\\/$/,'') + ' ↗</a>' +
      '</div>' +
      '<div class="right">' + badge + lat + '</div>' +
    '</div>';
  }).join('');
}

const runBtn = document.getElementById('run');
let busy = false;

// Deliberately manual. Opening this page makes zero outbound requests — the
// probes only fire when a human clicks. A status page that quietly hammers the
// box it reports on is how you take that box down.
async function load(){
  if (busy) return;
  busy = true;
  runBtn.disabled = true;
  runBtn.textContent = 'Checking…';
  beacon.className = 'beacon warn';
  headline.textContent = 'Checking services…';
  stamp.textContent = 'probing one at a time';
  try {
    const r = await fetch('/status/probe', { cache: 'no-store' });
    render(await r.json());
  } catch (e) {
    beacon.className = 'beacon bad';
    headline.textContent = 'Status check failed';
    stamp.textContent = 'could not reach the status service itself';
  } finally {
    busy = false;
    runBtn.disabled = false;
    runBtn.textContent = 'Run check';
  }
}
runBtn.addEventListener('click', load);
</script>
</body>
</html>`;
}

function mountStatus(app, rateLimit) {
  // The page itself is static and free to serve.
  app.get("/status", (req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8").send(statusPage());
  });

  // The probe is the expensive one: it fans out to five external services.
  // Rate-limit it so a crawler cannot turn this endpoint into a load generator.
  const guards = typeof rateLimit === "function" ? [rateLimit] : [];
  app.get("/status/probe", ...guards, async (req, res) => {
    try {
      const services = await probeAll();
      res.json({
        checked_at: new Date().toISOString(),
        summary: {
          up: services.filter((s) => s.state === "up").length,
          total: services.length,
        },
        services,
      });
    } catch (err) {
      res.status(500).json({ error: "probe_failed", detail: err.message });
    }
  });
}

module.exports = { mountStatus, SERVICES };
