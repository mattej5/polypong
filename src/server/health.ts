// The reachability check for SPEC §14 R1 — the highest risk in the project.
//
// School networks often enable client isolation, in which case no Chromebook
// can reach the teacher's Mac at all and no amount of application code fixes
// it. This page exists so a teacher can find that out in under a minute, from
// one Chromebook, in the actual room, before they build a lesson on top of it.
//
// It is deliberately a self-contained string rather than a bundled client
// page: it has to work in the compiled binary with no bundler involved, and it
// has to keep working even if the client lanes' build is broken. If the only
// page a teacher can load on a bad day is this one, that is the right choice.
//
// It proves two separate things, because they fail separately:
//   HTTP  — the page rendered at all, so TCP to this port works.
//   WS    — the live latency readout, so the WebSocket upgrade survives
//           whatever proxy or filter the school has in the path.

export interface HealthFacts {
  /** The client's address as the SERVER sees it. A teacher comparing this to
   *  the Chromebook's own reported IP can spot a NAT or proxy in the path. */
  clientAddress: string;
  /** The Mac's LAN IPv4, i.e. the number written on the whiteboard. */
  serverAddress: string;
  port: number;
  /** The host:port the browser actually used, so the WS URL matches the page
   *  origin even when the teacher reached this over localhost. */
  origin: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

export function healthPage(f: HealthFacts): string {
  const joinUrl = `http://${f.serverAddress}:${f.port}/play`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyPong network check</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#05070a; color:#cfe8ff;
         font:16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding:24px; }
  h1 { font-size:20px; letter-spacing:.14em; text-transform:uppercase; color:#7fd6ff; margin:0 0 4px; }
  p.sub { margin:0 0 24px; color:#6b8299; }
  .card { border:1px solid #16324a; border-radius:8px; padding:16px 18px; margin-bottom:14px; background:#080d13; }
  .lamp { font-size:22px; font-weight:700; letter-spacing:.08em; }
  .ok { color:#5cff9d; } .bad { color:#ff6b6b; } .wait { color:#ffd166; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 18px; margin:12px 0 0; }
  dt { color:#6b8299; } dd { margin:0; word-break:break-all; }
  .big { font-size:26px; color:#fff; }
  .hint { color:#6b8299; font-size:14px; margin-top:10px; }
</style>
</head>
<body>
<h1>PolyPong network check</h1>
<p class="sub">Run this on one student Chromebook, in the room, on the school Wi-Fi, before class.</p>

<div class="card">
  <div class="lamp ok">HTTP OK</div>
  <div class="hint">This page loaded, so this device can open a TCP connection to the teacher's Mac on port ${f.port}.</div>
</div>

<div class="card">
  <div class="lamp wait" id="wslamp">WEBSOCKET &hellip;</div>
  <dl>
    <dt>round trip</dt><dd id="rtt">measuring&hellip;</dd>
    <dt>best / worst</dt><dd id="range">&mdash;</dd>
    <dt>replies</dt><dd id="count">0 of 0</dd>
  </dl>
  <div class="hint" id="wshint">If this never turns green, the network is blocking WebSockets even though plain HTTP works.</div>
</div>

<div class="card">
  <dl>
    <dt>this device</dt><dd id="cli">${esc(f.clientAddress)}</dd>
    <dt>teacher's Mac</dt><dd>${esc(f.serverAddress)}:${f.port}</dd>
    <dt>page origin</dt><dd>${esc(f.origin)}</dd>
  </dl>
  <div class="hint">"This device" is the address the server saw. If it does not look like this school's
  addresses, something is rewriting traffic in between.</div>
</div>

<div class="card">
  <div class="hint">Student join link</div>
  <div class="big">${esc(joinUrl)}</div>
</div>

<script>
(function () {
  var lamp = document.getElementById('wslamp');
  var rttEl = document.getElementById('rtt');
  var rangeEl = document.getElementById('range');
  var countEl = document.getElementById('count');
  var hint = document.getElementById('wshint');
  var sent = 0, got = 0, best = Infinity, worst = 0, timer = null;

  // Same origin as the page: whatever host the teacher typed is the host that
  // has to work, and hardcoding the LAN IP here would test the wrong path.
  var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/health-ws';
  var ws;
  try { ws = new WebSocket(url); } catch (e) { fail(String(e)); return; }

  function fail(why) {
    lamp.textContent = 'WEBSOCKET BLOCKED';
    lamp.className = 'lamp bad';
    hint.textContent = 'The WebSocket could not stay open (' + why + '). HTTP works but real-time play will not. '
      + 'This usually means client isolation or a filtering proxy on the school network.';
    if (timer) clearInterval(timer);
  }

  ws.onopen = function () {
    lamp.textContent = 'WEBSOCKET OK';
    lamp.className = 'lamp ok';
    ping();
    timer = setInterval(ping, 1000);
  };
  ws.onmessage = function (ev) {
    var t = Number(ev.data);
    if (!isFinite(t)) return;
    var ms = Math.round(performance.now() - t);
    got++;
    if (ms < best) best = ms;
    if (ms > worst) worst = ms;
    rttEl.textContent = ms + ' ms';
    rangeEl.textContent = best + ' ms / ' + worst + ' ms';
    countEl.textContent = got + ' of ' + sent;
    // A link that opens and then drops every other frame is worse than one
    // that never opens, because it looks fine until 24 students are on it.
    if (sent > 4 && got < sent - 2) {
      lamp.textContent = 'WEBSOCKET UNSTABLE';
      lamp.className = 'lamp bad';
      hint.textContent = 'The connection opens but is losing replies. Expect stalls during play.';
    }
  };
  ws.onclose = function () { fail('closed'); };
  ws.onerror = function () { fail('error'); };

  function ping() {
    if (ws.readyState !== 1) return;
    sent++;
    countEl.textContent = got + ' of ' + sent;
    ws.send(String(performance.now()));
  }
})();
</script>
</body>
</html>`;
}
