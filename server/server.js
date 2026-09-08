/*
  CallKaro — signaling + push server.

  PERSONAL CODES:
    - A person creates a unique code (letters/numbers, a few symbols).
    - To call someone, you type THEIR code. Codes are unique.

  SIGNALING:
    - WebSocket relays SDP/ICE between caller <-> callee (peer-to-peer audio).
    - Media never touches this server.

  RINGING WHEN THE OTHER SIDE IS OFFLINE (the whole point):
    - Caller sends `call` + `offer`. If the callee's page is open, everything
      relays live as before.
    - If the callee is NOT connected, the server HOLDS the offer (a "pending
      call") and sends an FCM web push to the callee's registered token(s).
      When the callee taps the notification, their page opens, logs in, and
      the server immediately hands them the held `incoming` + `offer`, and
      pairs them with the still-ringing caller. 60s timeout = "No answer".

  PERSISTENCE:
    - Codes + FCM tokens are stored in Firestore (collection `codes`) when the
      project has Firestore enabled, so they survive Render restarts/sleeps.
      If Firestore is not enabled, everything falls back to memory (works,
      but codes are lost on restart).

  Endpoints:
    GET  /ping          -> keep-alive probe (returns "ok")
    POST /create        -> {code}                  create a code
    POST /register      -> {code, token}           attach an FCM token to a code
    POST /push          -> {code}                  legacy: push a code manually

  Run:  node server.js   (PORT env on cloud hosts; FAKE_PUSH=1 for offline tests)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const CALL_TIMEOUT_MS = 60 * 1000;   // how long a call rings before "No answer"

// ---------------- FCM (optional) ----------------
let admin = null;
try { admin = require('firebase-admin'); } catch (e) { /* not installed */ }

let fcmApp = null;
if (admin) {
  try {
    let cred = null;
    const cfgB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const cfgPath = path.join(__dirname, 'firebase-service-account.json');
    if (cfgB64) {
      cred = admin.credential.cert(JSON.parse(Buffer.from(cfgB64, 'base64').toString('utf8')));
      console.log('FCM: credentials from FIREBASE_SERVICE_ACCOUNT_B64 env var.');
    } else if (fs.existsSync(cfgPath)) {
      cred = admin.credential.cert(require(cfgPath));
      console.log('FCM: credentials from local firebase-service-account.json.');
    }
    if (cred) {
      fcmApp = admin.initializeApp({ credential: cred });
      console.log('FCM enabled — closed apps can be woken with a push.');
    }
  } catch (e) {
    console.log('FCM init failed — push disabled:', e.message);
  }
}
// FAKE_PUSH=1 pretends every push succeeds (used by automated flow tests).
const FAKE_PUSH = process.env.FAKE_PUSH === '1';

// ---------------- storage: Firestore + in-memory fallback ----------------
// codes: code -> { sock: WebSocket|null, fcm: [pushTokens] }
const codes = new Map();
let db = null, firestoreBroken = false;
if (fcmApp) { try { db = fcmApp.firestore(); } catch (e) { db = null; } }

function newRecord() { return { sock: null, fcm: [] }; }
function validCode(c) {
  return typeof c === 'string' && /^[A-Za-z0-9._@#-]{3,32}$/.test(c);
}

async function fsGet(code) {
  if (!db || firestoreBroken) return undefined;          // unknown = treat as absent
  try {
    const snap = await db.collection('codes').doc(code).get();
    return snap.exists ? (snap.data() || {}) : null;     // null = definitely absent
  } catch (e) {
    firestoreBroken = true;
    console.log('Firestore unavailable — codes will be memory-only (lost on restart). Enable Firestore in the Firebase console to persist them. (' + e.message + ')');
    return undefined;
  }
}
async function fsSave(code, rec) {
  if (!db || firestoreBroken) return;
  try {
    await db.collection('codes').doc(code).set({ fcm: rec.fcm.slice(0, 8) });
  } catch (e) {
    firestoreBroken = true;
    console.log('Firestore write failed — staying memory-only. (' + e.message + ')');
  }
}
async function fsDropToken(code, token) {
  if (!db || firestoreBroken) return;
  try {
    await db.collection('codes').doc(code).set(
      { fcm: admin.firestore.FieldValue.arrayRemove(token) }, { merge: true });
  } catch (e) { /* best effort */ }
}

// Adopt a code from Firestore into memory if needed; returns record or null.
async function loadCode(code) {
  let rec = codes.get(code);
  if (rec) return rec;
  const remote = await fsGet(code);
  if (remote) {
    rec = newRecord();
    rec.fcm = Array.isArray(remote.fcm) ? remote.fcm.filter(x => typeof x === 'string') : [];
    codes.set(code, rec);
    return rec;
  }
  return null;
}

// Create a code. Returns {ok:true} or {ok:false, err}.
async function createCode(code) {
  if (codes.has(code)) return { ok: false, err: 'That code is taken. Pick another.' };
  const remote = await fsGet(code);
  if (remote) { codes.set(code, newRecord()); return { ok: false, err: 'That code is taken. Pick another.' }; }
  const rec = newRecord();
  codes.set(code, rec);
  await fsSave(code, rec);
  return { ok: true, code };
}

// ---------------- push ----------------
// Sends a DATA-ONLY FCM message so OUR service worker renders the
// notification (no duplicate OS notifications, full control of click).
// Returns how many tokens accepted it; dead tokens are pruned.
async function pushToCode(code, fromCode) {
  const rec = await loadCode(code);
  if (!fcmApp || !rec || !rec.fcm.length) return 0;
  if (FAKE_PUSH) return rec.fcm.length;

  let sent = 0;
  const dead = [];
  await Promise.all(rec.fcm.map(async (tok) => {
    try {
      await admin.messaging().send({
        token: tok,
        data: { type: 'call', from: fromCode || '', code: code, url: '/' },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: '/' }
        }
      });
      sent++;
    } catch (e) {
      if (/registration-token-not-registered|unregistered|invalid-registration-token|invalid-argument/i.test(e.message || '')) {
        dead.push(tok);
      }
    }
  }));
  for (const tok of dead) {
    const i = rec.fcm.indexOf(tok);
    if (i >= 0) rec.fcm.splice(i, 1);
    await fsDropToken(code, tok);
  }
  return sent;
}

// ---------------- HTTP + static ----------------
const ROOT = path.join(__dirname, '..', 'client');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/ping' || url === '/healthz')) {
      res.writeHead(200); return res.end('ok');
    }
    if (req.method === 'POST' && url === '/create')   return handleCreate(body, res);
    if (req.method === 'POST' && url === '/register') return handleRegister(body, res);
    if (req.method === 'POST' && url === '/push')     return handleLegacyPush(body, res);

    let p = url === '/' ? '/index.html' : url;
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (e, data) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
      res.end(data);
    });
  });
});
server.listen(PORT, () => console.log(`CallKaro server on port ${PORT}`));

async function handleCreate(body, res) {
  let c;
  try { ({ code: c } = JSON.parse(body)); } catch { res.writeHead(400); return res.end('bad'); }
  if (!validCode(c)) {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: false, err: 'Code must be 3-32 chars: letters, numbers, . _ @ # -' }));
  }
  c = c.toLowerCase();
  const r = await createCode(c);
  res.writeHead(200); res.end(JSON.stringify(r));
}

async function handleRegister(body, res) {
  try {
    const { code, token } = JSON.parse(body);
    if (!validCode(code) || !token) { res.writeHead(400); return res.end('bad'); }
    const rec = await loadCode(code.toLowerCase());
    if (!rec) { res.writeHead(400); return res.end('no such code'); }
    if (!rec.fcm.includes(token)) rec.fcm.push(token);
    await fsSave(code.toLowerCase(), rec);
    res.writeHead(200); return res.end('ok');
  } catch { res.writeHead(400); return res.end('bad'); }
}

// Legacy endpoint (older clients push manually). The normal flow has the
// server push by itself inside the `call` handler.
async function handleLegacyPush(body, res) {
  let code = '';
  try { ({ code } = JSON.parse(body)); } catch {}
  code = (code || '').toLowerCase();
  const pushed = await pushToCode(code, '');
  res.writeHead(200); res.end(JSON.stringify({ pushed }));
}

// ---------------- signaling over WebSocket (same port as HTTP) ----------------
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

function send(sock, obj) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj)); }

// Calls waiting for the callee to come online: callerCode -> entry
const pending = new Map();

function clearPending(callerCode) {
  const p = pending.get(callerCode);
  if (p) { clearTimeout(p.timer); pending.delete(callerCode); }
}

// If the callee came online and the caller's offer is held, pair them now.
function tryDeliverPending(p) {
  if (!p || !p.offer) return;
  const tRec = codes.get(p.target);
  if (!tRec || !tRec.sock || tRec.sock._closed) return;
  if (!p.sock || p.sock.readyState !== 1 || p.sock._closed) { clearPending(p.callerCode); return; }

  p.sock.other = tRec.sock;
  tRec.sock.other = p.sock;
  send(tRec.sock, { type: 'incoming', from: p.callerCode });
  send(tRec.sock, { type: 'offer', sdp: p.offer, from: p.callerCode });
  for (const c of p.candidates) send(tRec.sock, { type: 'ice', candidate: c });
  clearPending(p.callerCode);
}

wss.on('connection', (sock) => {
  sock.myCode = null; sock.other = null; sock._closed = false; sock._alive = true;

  sock.on('pong', () => { sock._alive = true; });

  sock.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'ping') return send(sock, { type: 'pong' });

    if (m.type === 'login') {
      const c = (m.code || '').toLowerCase();
      if (!validCode(c)) return send(sock, { type: 'login-fail', err: 'Invalid code.' });
      const rec = await loadCode(c);
      if (!rec) return send(sock, { type: 'login-fail', err: 'No such code. Create it first, or ask its owner.' });
      sock.myCode = c;
      rec.sock = sock;                       // this code is now online
      send(sock, { type: 'logged-in', code: c });
      // Deliver any calls that were waiting for this code to come online.
      for (const p of pending.values()) {
        if (p.target === c) tryDeliverPending(p);
      }
      return;
    }

    if (!sock.myCode) return; // must log in first

    if (m.type === 'call') {
      const target = (m.code || '').toLowerCase();
      if (target === sock.myCode) return send(sock, { type: 'call-fail', err: "You can't call yourself." });
      const tRec = await loadCode(target);
      if (!tRec) return send(sock, { type: 'call-fail', err: 'No such code. Check it and try again.' });

      // Online: pair and relay live (unchanged classic path).
      if (tRec.sock && !tRec.sock._closed) {
        sock.other = tRec.sock;
        tRec.sock.other = sock;
        send(tRec.sock, { type: 'incoming', from: sock.myCode });
        send(sock, { type: 'calling' });
        return;
      }

      // Offline: hold the call + wake them with a push.
      if (!fcmApp || !tRec.fcm.length) {
        return send(sock, { type: 'call-fail',
          err: 'They are not online, and no notification is set up on their side. Ask them to open the site once and enable notifications.' });
      }
      clearPending(sock.myCode);
      const entry = { target, callerCode: sock.myCode, sock, offer: null, candidates: [], timer: null };
      pending.set(sock.myCode, entry);
      entry.timer = setTimeout(() => {
        if (pending.get(sock.myCode) === entry) {
          pending.delete(sock.myCode);
          send(sock, { type: 'call-fail', err: 'No answer.' });
        }
      }, CALL_TIMEOUT_MS);
      send(sock, { type: 'calling' });       // caller starts ringing UI right away
      const sent = await pushToCode(target, sock.myCode);
      if (!sent && pending.get(sock.myCode) === entry) {
        clearPending(sock.myCode);
        send(sock, { type: 'call-fail',
          err: 'Could not deliver the notification (their device may have logged out). Ask them to open the site once and enable notifications.' });
      }
      return;
    }

    if (m.type === 'offer') {
      if (sock.other) return send(sock.other, m);
      const p = pending.get(sock.myCode);
      if (p && p.sock === sock) { p.offer = m.sdp; tryDeliverPending(p); }
      return;
    }

    if (m.type === 'ice') {
      if (sock.other) return send(sock.other, m);
      const p = pending.get(sock.myCode);
      if (p && p.sock === sock && m.candidate) p.candidates.push(m.candidate);
      return;
    }

    if (m.type === 'answer') {
      if (sock.other) send(sock.other, m);
      return;
    }

    if (m.type === 'hangup') {
      // Either canceling a still-ringing call or ending a live one.
      clearPending(sock.myCode);
      if (sock.other) send(sock.other, { type: 'hangup' });
      return;
    }
  });

  sock.on('close', () => {
    sock._closed = true;
    clearPending(sock.myCode);
    if (sock.myCode) {
      const rec = codes.get(sock.myCode);
      if (rec && rec.sock === sock) rec.sock = null;
    }
    if (sock.other) { send(sock.other, { type: 'peer-left' }); sock.other.other = null; }
  });
});

// Kill sockets that stopped answering transport-level pings (dead phones).
setInterval(() => {
  wss.clients.forEach((s) => {
    if (s.readyState !== 1) return;
    if (!s._alive) { try { s.terminate(); } catch {} return; }
    s._alive = false;
    try { s.ping(); } catch {}
  });
}, 30000);
