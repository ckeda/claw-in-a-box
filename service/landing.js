// SPDX-License-Identifier: Apache-2.0
// Human-facing landing page served at "/" — written for OKX.AI buyers,
// reviewers, and anyone who clicks the domain out of curiosity.
// Machines use /skill.md (agent docs) and /healthz (status).

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claw-in-a-Box API — your agent asks before it spends</title>
<link rel="canonical" href="https://api.clawinabox.xyz/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Claw-in-a-Box">
<meta property="og:title" content="Claw-in-a-Box API — your agent asks before it spends">
<meta property="og:description" content="Pay-per-call authorization for AI agents: spend verdicts with Telegram human approval and capability tokens. USDT0 on X Layer (OKX.AI) or USDC on Base (x402 Bazaar), $0.01 per call.">
<meta property="og:url" content="https://api.clawinabox.xyz/">
<meta property="og:image" content="https://clawinabox.xyz/logo-512-white.png">
<meta name="twitter:card" content="summary">
<meta name="description" content="Pay-per-call authorization for AI agents: allow/review/deny spend verdicts with Telegram human approval, plus delegatable capability tokens. Two x402 rails: USDT0 on X Layer (OKX.AI) or USDC on Base (x402 Bazaar). $0.01 per call.">
<link rel="icon" type="image/png" href="https://clawinabox.xyz/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --glass:#F6F8FB; --panel:#FFFFFF; --ink:#1D2433; --steel:#8A96A8;
    --line:#E3E9F1; --coral:#E4593C; --amber:#B97A0A; --amber-bg:#FFF4DE;
    --mint:#1F7A4F; --mint-bg:#E7F6EE; --red:#B8352E; --red-bg:#FDECEA;
    --mono:'IBM Plex Mono',ui-monospace,monospace;
    --disp:'Bricolage Grotesque',system-ui,sans-serif;
  }
  *{box-sizing:border-box;margin:0}
  body{
    background:var(--glass);color:var(--ink);
    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.55;
    background-image:linear-gradient(var(--line) 1px,transparent 1px),
                     linear-gradient(90deg,var(--line) 1px,transparent 1px);
    background-size:56px 56px;
  }
  a{color:inherit}
  .wrap{max-width:900px;margin:0 auto;padding:0 20px}

  header{display:flex;justify-content:space-between;align-items:center;padding:22px 0;gap:12px}
  .mark{font-family:var(--disp);font-weight:800;font-size:19px;letter-spacing:-.01em;
    display:flex;align-items:center;gap:9px}
  .mark img{width:30px;height:30px}
  nav{display:flex;gap:16px;font-size:14px;flex-wrap:wrap}
  nav a{color:var(--steel);text-decoration:none;border-bottom:1px solid transparent;white-space:nowrap}
  nav a:hover,nav a:focus-visible{color:var(--ink);border-bottom-color:var(--coral)}

  .hero{padding:38px 0 6px}
  .live{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11.5px;
    letter-spacing:.12em;text-transform:uppercase;color:var(--mint);background:var(--mint-bg);
    border:1.5px solid var(--mint);border-radius:999px;padding:4px 11px;margin-bottom:16px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--mint);
    animation:pulse 2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
  h1{font-family:var(--disp);font-weight:800;letter-spacing:-.025em;
    font-size:clamp(32px,5.4vw,52px);line-height:1.05}
  h1 .hl{color:var(--coral)}
  .sub{margin-top:16px;max-width:60ch;color:#414B5E;font-size:17px}
  .price{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;font-family:var(--mono);font-size:13px}
  .pill{background:var(--panel);border:1.5px solid var(--line);border-radius:999px;padding:6px 13px}
  .pill b{color:var(--coral)}

  /* the box: live verdict machine */
  .cabinet{position:relative;margin:44px 0 18px;background:var(--panel);
    border:2.5px solid var(--ink);border-radius:14px;
    box-shadow:8px 8px 0 rgba(29,36,51,.08);padding:52px 24px 24px}
  .cabinet-label{position:absolute;top:-11px;left:22px;background:var(--panel);padding:0 8px;
    font-family:var(--mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--steel)}
  .claw{position:absolute;top:0;left:50%;transform:translateX(-50%);animation:bob 3.6s ease-in-out infinite}
  @keyframes bob{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(7px)}}
  @media (prefers-reduced-motion:reduce){.claw{animation:none}}
  form{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch}
  .field{flex:1 1 145px;display:flex;flex-direction:column;gap:5px}
  label{font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--steel)}
  input,select{font-family:var(--mono);font-size:15px;color:var(--ink);padding:11px 12px;
    border:1.5px solid var(--line);border-radius:8px;background:var(--glass)}
  input:focus-visible,select:focus-visible,button:focus-visible{outline:2.5px solid var(--coral);outline-offset:2px}
  button{align-self:flex-end;font-family:var(--disp);font-weight:600;font-size:15.5px;padding:11px 22px;
    border:2px solid var(--ink);border-radius:8px;background:var(--coral);color:#fff;cursor:pointer;
    box-shadow:3px 3px 0 var(--ink);transition:transform .08s,box-shadow .08s}
  button:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink)}
  .out{margin-top:20px;min-height:70px}
  .chip{display:inline-block;font-family:var(--mono);font-weight:500;font-size:14px;letter-spacing:.06em;
    padding:6px 14px;border-radius:999px;border:1.5px solid}
  .chip.allow{color:var(--mint);background:var(--mint-bg);border-color:var(--mint)}
  .chip.review{color:var(--amber);background:var(--amber-bg);border-color:var(--amber)}
  .chip.deny{color:var(--red);background:var(--red-bg);border-color:var(--red)}
  .reasons{margin-top:10px;font-family:var(--mono);font-size:13.5px;color:#414B5E;white-space:pre-wrap}
  .hint{margin-top:13px;font-size:13px;color:var(--steel)}
  .hint code{font-family:var(--mono)}

  h2{font-family:var(--disp);font-weight:800;font-size:25px;letter-spacing:-.02em;margin:42px 0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:16px}
  .card{background:var(--panel);border:1.5px solid var(--line);border-radius:12px;padding:20px}
  .card h3{font-family:var(--disp);font-weight:600;font-size:16.5px;margin-bottom:8px}
  .card p{font-size:14px;color:#414B5E}
  .card pre{margin-top:11px;font-family:var(--mono);font-size:11.5px;color:var(--steel);
    overflow-x:auto;white-space:pre}

  /* layered defense table */
  .layers{background:var(--panel);border:1.5px solid var(--line);border-radius:12px;overflow:hidden}
  .layer{display:grid;grid-template-columns:150px 1fr;gap:14px;padding:16px 20px;border-bottom:1px solid var(--line)}
  .layer:last-child{border-bottom:none}
  .layer .who{font-family:var(--mono);font-size:12.5px;color:var(--steel);letter-spacing:.04em}
  .layer .what{font-size:14px;color:#414B5E}
  .layer .what b{color:var(--ink)}
  @media(max-width:560px){.layer{grid-template-columns:1fr;gap:4px}}

  /* steps */
  ol.steps{counter-reset:s;list-style:none;padding:0;display:grid;gap:12px}
  ol.steps li{counter-increment:s;background:var(--panel);border:1.5px solid var(--line);
    border-radius:12px;padding:16px 18px 16px 52px;position:relative;font-size:14px;color:#414B5E}
  ol.steps li::before{content:counter(s);position:absolute;left:16px;top:15px;
    width:22px;height:22px;border-radius:50%;background:var(--coral);color:#fff;
    font-family:var(--mono);font-size:12px;display:grid;place-items:center;font-weight:600}
  ol.steps code{font-family:var(--mono);font-size:.88em;background:var(--glass);
    border:1px solid var(--line);padding:1px 5px;border-radius:4px}
  ol.steps b{color:var(--ink)}

  pre.code{background:var(--ink);color:#E8EDF5;border-radius:12px;padding:18px 20px;overflow-x:auto;
    font-family:var(--mono);font-size:12.5px;line-height:1.7;margin-top:14px}
  pre.code .c{color:#8A96A8}
  pre.code .k{color:#F2A38C}

  footer{margin:48px 0 40px;padding-top:22px;border-top:1.5px solid var(--line);font-size:13.5px;color:var(--steel)}
  .foot-row{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center}
  footer a{text-decoration:none;border-bottom:1px solid var(--line)}
  footer a:hover{color:var(--ink);border-bottom-color:var(--coral)}
  .byline{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);font-size:13.5px}
  .byline .heart{color:var(--coral);margin:0 1px}
  .byline .me{color:var(--ink);font-weight:600;border-bottom-color:var(--coral)}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="mark">
      <img src="https://clawinabox.xyz/favicon.png" alt="">
      <span>Claw-in-a-Box</span>
    </div>
    <nav>
      <a href="https://api.clawinabox.xyz/skill.md">Agent docs (SKILL.md)</a>
    </nav>
  </header>

  <section class="hero">
    <span class="live"><span class="dot"></span> Live on x402 Bazaar · OKX.AI</span>
    <h1>Your agent asks<br><span class="hl">before it spends.</span></h1>
    <p class="sub">An authorization layer for AI agents. Every spend gets an
    <b>allow / review / deny</b> verdict — with per-agent accounting, human
    approval on Telegram, and delegatable capability tokens for when your agent
    hires other agents.</p>
    <div class="price">
      <span class="pill"><b>$0.01</b> per call</span>
      <span class="pill">x402 · Base + X Layer</span>
      <span class="pill">no SDK required</span>
    </div>
  </section>

  <section id="try" class="cabinet" aria-label="Live demo: ask the box for a verdict">
    <span class="cabinet-label">live — this calls the real API</span>
    <svg class="claw" width="72" height="58" viewBox="0 0 72 58" fill="none" aria-hidden="true">
      <line x1="36" y1="0" x2="36" y2="20" stroke="#8A96A8" stroke-width="3"/>
      <circle cx="36" cy="24" r="5" fill="#8A96A8"/>
      <path d="M36 26 C24 32 20 44 24 52" stroke="#E4593C" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M36 26 C48 32 52 44 48 52" stroke="#E4593C" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M36 26 C34 36 34 44 36 50" stroke="#E4593C" stroke-width="4" stroke-linecap="round" fill="none"/>
    </svg>

    <form id="f">
      <div class="field">
        <label for="agent">agent</label>
        <input id="agent" value="demo-agent" spellcheck="false">
      </div>
      <div class="field">
        <label for="amount">amount</label>
        <input id="amount" type="number" value="150" min="0" step="1">
      </div>
      <div class="field">
        <label for="policy">policy</label>
        <select id="policy">
          <option>standard</option>
          <option>conservative</option>
          <option>permissive</option>
        </select>
      </div>
      <button type="submit">Ask the box</button>
    </form>

    <div class="out" id="out" aria-live="polite">
      <p class="hint">Try 30 (allow), 150 (review), 999 (deny) — or split a big
      spend into small ones and watch the daily total catch it. This demo hits
      the free route; the paid routes (OKX.AI &amp; x402 Bazaar) run the same engine.</p>
    </div>
  </section>

  <h2>Not a replacement for your wallet limits — a layer above them</h2>
  <div class="layers">
    <div class="layer">
      <span class="who">Wallet layer</span>
      <span class="what"><b>"How much can this wallet spend?"</b> — protocol-enforced caps
      and allowlists on the key itself. Your last line of defense.</span>
    </div>
    <div class="layer">
      <span class="who">Claw-in-a-Box</span>
      <span class="what"><b>"Which agent, under what authority, and should a human
      look first?"</b> — per-agent accounting (one wallet, many agents — you find out
      which one is spending), policy verdicts with the exact rules that fired, human
      approval in the loop, and scoped credentials for sub-agents.</span>
    </div>
    <div class="layer">
      <span class="who">Together</span>
      <span class="what">Defense in depth. Set a hard ceiling at the wallet, and do the
      thinking at the authorization layer.</span>
    </div>
  </div>

  <h2>Three things it does</h2>
  <div class="grid">
    <div class="card">
      <h3>Verdicts, not guesses</h3>
      <p>Send the intended action, get <code>allow</code>, <code>review</code> or
      <code>deny</code> back — plus the exact rules that fired. Per-transaction caps,
      daily totals, destination allowlists, time windows.</p>
      <pre>POST /paid/v1/guard/check
→ {"verdict":"review", ...}</pre>
    </div>
    <div class="card">
      <h3>Your phone, your call</h3>
      <p>A <em>review</em> verdict pings a human on Telegram with Approve / Deny
      buttons. Bind your own chat and your agent's reviews come to <em>you</em> —
      measured end-to-end at under four seconds.</p>
      <pre>POST /v1/operators/register
→ /bind CODE in Telegram</pre>
    </div>
    <div class="card">
      <h3>Agents hiring agents</h3>
      <p>Hand a sub-agent a narrower, shorter-lived token instead of your credentials.
      Escalation is refused cryptographically; revoke the root and the whole
      delegation tree dies at once.</p>
      <pre>POST /v1/tokens/delegate
POST /v1/tokens/revoke</pre>
    </div>
  </div>

  <h2 id="how">How to call it</h2>
  <ol class="steps">
    <li><b>Discover.</b> Point your agent at <code>/skill.md</code> — it describes every
    endpoint in plain English. No SDK, no glue code.</li>
    <li><b>Pay per call.</b> Hit the paid route without payment and you get an
    <code>HTTP 402</code> with x402 payment requirements — USDC on Base (<code>/paid/*</code>, x402 Bazaar) or USDT0 on X Layer (<code>/paid-okx/*</code>, OKX.AI) — $0.01 per call.
    Sign, retry with the payment header, get your verdict.</li>
    <li><b>Bind your Telegram</b> (optional but recommended). Register your
    <code>agent_id</code>, send <code>/bind CODE</code> to the bot, and every
    <em>review</em> for that agent lands on your phone instead of the operator's.</li>
    <li><b>Block or poll.</b> Pass <code>"wait": true</code> to hold the call until a
    human decides, or poll <code>/v1/approvals/{id}</code> and get on with other work.</li>
  </ol>

  <pre class="code"><span class="c"># the whole integration, start to finish</span>
curl -X POST https://api.clawinabox.xyz/paid/v1/guard/check \\
  -H "Content-Type: application/json" \\
  -H "PAYMENT-SIGNATURE: &lt;your x402 payment&gt;" \\
  -d '{"agent_id":"my-bot","amount":150,"wait":true}'

<span class="c"># → a human taps Approve on their phone, and you get:</span>
{"verdict":<span class="k">"allow"</span>, "approval_status":<span class="k">"approved"</span>, ...}</pre>

  <footer>
    <div class="foot-row">
      <a href="/skill.md">Agent docs (SKILL.md)</a>
      <a href="/status">Service status</a>
      <a href="https://github.com/ckeda/claw-in-a-box">Github</a>
    </div>
    <p class="byline">
      Made with <span class="heart">❤</span> by <a class="me" href="https://kedache.com">Keda Che</a>
    </p>
  </footer>
</div>

<script>
const f=document.getElementById('f'),out=document.getElementById('out');
let pollTimer=null;

function render(v,reasons,extra){
  out.innerHTML='<span class="chip '+v+'">'+v.toUpperCase()+'</span>'+
    '<div class="reasons">'+reasons.map(x=>'· '+x).join('\\n')+(extra||'')+'</div>';
}

async function pollApproval(id,reasons,startedAt){
  const deadline=startedAt+125000;
  const tick=async()=>{
    let a=null;
    try{
      const r=await fetch('/v1/approvals/'+id);
      if(r.ok)a=await r.json();
    }catch{}
    const waited=Math.round((Date.now()-startedAt)/1000);
    if(a&&a.status==='pending'){
      render('review',reasons,
        '\\n⏳ a real human’s phone just buzzed — waiting for their decision… ('+waited+'s)');
      if(Date.now()<deadline){pollTimer=setTimeout(tick,3000);}
      return;
    }
    if(a&&a.status==='approved'){
      render('allow',reasons.concat(['approved by a human via Telegram in '+waited+'s ✅']));
    }else if(a&&a.status==='denied'){
      render('deny',reasons.concat(['denied by a human via Telegram in '+waited+'s ❌']));
    }else{
      render('deny',reasons.concat(['no human decision within 120s — denied by default ⏰']));
    }
  };
  tick();
}

f.addEventListener('submit',async e=>{
  e.preventDefault();
  if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}
  out.innerHTML='<p class="hint">Asking the box…</p>';
  const body={
    agent_id:document.getElementById('agent').value||'demo-agent',
    amount:Number(document.getElementById('amount').value||0),
    policy:document.getElementById('policy').value
  };
  try{
    const r=await fetch('/v1/guard/check',
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    const v=(d.verdict||'deny');
    const reasons=(d.reasons||[]).slice();
    const extra=(d.spent_today_after!=null?'\\n· spent today: '+d.spent_today_after:'');
    render(v,reasons,extra);
    if(v==='review'&&d.approval_id){
      pollApproval(d.approval_id,reasons,Date.now());
    }
  }catch(err){
    out.innerHTML='<div class="reasons">The box didn’t answer. Try from a terminal:\\n'+
      'curl -X POST https://api.clawinabox.xyz/v1/guard/check -H "Content-Type: application/json" -d \\'{"amount":150}\\'</div>';
  }
});
</script>
</body>
</html>`;

module.exports = { LANDING_HTML };
