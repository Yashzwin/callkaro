/*
  Home Call — own-code signaling + push server.

  PERSONAL CODES:
    - A person creates a unique code (letters/numbers, anything they want).
    - They give that code to the people they want to call.
    - To call, you type the OTHER person's code.
    - Codes are unique: if someone tries to create one that exists, they're told
      to pick another.

  SIGNALING:
    - WebSocket relays SDP/ICE between caller <-> callee (peer-to-peer audio).
    - Media never touches this server.

  PUSH:
    - /register stores an FCM token per code (so a closed app can be woken).
    - /push (sent by the caller) wakes the callee's app/phone via FCM.

  Run:  node server.js   (set PORT env on cloud hosts)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ---- FCM (optional) ----
let admin = null, fcmApp = null;
try {
  admin = require('firebase-admin');
  // 1) Try local file (dev)
  const cfgPath = path.join(__dirname, 'firebase-service-account.json');
  // 2) Try env var (cloud) - base64 encoded service account JSON
  const cfgB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  let cred = null;
  if (cfgB64) {
    try {
      const json = Buffer.from(cfgB64, 'base64').toString('utf8');
      cred = admin.credential.cert(JSON.parse(json));
      console.log('FCM credentials loaded from FIREBASE_SERVICE_ACCOUNT_B64 env var.');
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_B64:', e.message);
    }
  } else if (fs.existsSync(cfgPath)) {
    cred = admin.credential.cert(require(cfgPath));
    console.log('FCM credentials loaded from local firebase-service-account.json.');
  }
  if (cred) {
    fcmApp = admin.initializeApp({ credential: cred });
    console.log('FCM enabled (push to closed apps works).');
  } else {
    console.log('No FCM credentials — push disabled; WS signaling still works.');
  }
} catch (e) {
  console.log('firebase-admin not installed or init failed — push disabled.');
}

// ---- codes: code -> { ws, fcmTokens:[], peers mapping implicit } ----
const codes = new Map();   // code -> { sock: WebSocket|null, fcm: [tokens] }

function newCodeRecord() { return { sock: null, fcm: [] }; }

function validCode(c) {
  // allow letters, numbers, and a few symbols; 3..32 chars
  return typeof c === 'string' && /^[A-Za-z0-9._@#-]{3,32}$/.test(c);
}

// ---- static file server for the client ----
const ROOT = path.join(__dirname, '..', 'client');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/create') return handleCreate(body, res);
    if (req.method === 'POST' && url === '/register') return handleRegister(body, res);
    if (req.method === 'POST' && url === '/push')    return handlePush(body, res);

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
server.listen(PORT, () => console.log(`HTTP client at http://localhost:${PORT}`));

function handleCreate(body, res) {
  let c;
  try { ({ code: c } = JSON.parse(body)); } catch { return res.writeHead(400), res.end('bad'); }
  if (!validCode(c)) return res.writeHead(400), res.end(JSON.stringify({ ok:false, err:'Code must be 3-32 chars: letters, numbers, . _ @ # -' }));
  c = c.toLowerCase();
  if (codes.has(c)) return res.writeHead(200), res.end(JSON.stringify({ ok:false, err:'That code is taken. Pick another.' }));
  codes.set(c, newCodeRecord());
  res.writeHead(200); res.end(JSON.stringify({ ok:true, code:c }));
}

function handleRegister(body, res) {
  try {
    const { code, token, kind } = JSON.parse(body);
    if (!code || !token) return res.writeHead(400), res.end('bad');
    const rec = codes.get(code.toLowerCase());
    if (!rec) return res.writeHead(400), res.end('no such code');
    if (!rec.fcm.includes(token)) rec.fcm.push(token);
    res.writeHead(200); res.end('ok');
  } catch { res.writeHead(400); res.end('bad'); }
}

async function handlePush(body, res) {
  let code = '';
  try { ({ code } = JSON.parse(body)); } catch {}
  code = (code || '').toLowerCase();
  const rec = codes.get(code);
  if (!fcmApp || !rec || !rec.fcm.length) {
    res.writeHead(200);
    return res.end(JSON.stringify({ pushed: 0, note: 'FCM not configured or no tokens' }));
  }
  let ok = 0;
  await Promise.all(rec.fcm.map(async (tok) => {
    try {
      await admin.messaging().send({
        token: tok,
        // For web push, we need notification payload + data payload
        notification: {
          title: '📞 Incoming Call',
          body: code + ' is calling you',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          vibrate: [300, 100, 300, 100, 300],
          requireInteraction: true,
          tag: 'incoming-call',
        },
        data: {
          type: 'call',
          code: code,
          url: '/'
        },
        android: { priority: 'high', directBootOk: true, ttl: 60 },
        webpush: {
          headers: {
            Urgency: 'high',
          },
          fcmOptions: {
            link: '/'
          }
        }
      });
      ok++;
    } catch (e) {}
  }));
  res.writeHead(200); res.end(JSON.stringify({ pushed: ok }));
}

// ---- signaling over WebSocket (same port as HTTP) ----
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

function send(sock, obj) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj)); }

wss.on('connection', (sock) => {
  sock.myCode = null; sock.other = null; sock._closed = false;

  sock.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'login') {
      const c = (m.code || '').toLowerCase();
      const rec = codes.get(c);
      if (!rec) { send(sock, { type:'login-fail', err:'No such code. Ask the owner to create it.' }); return; }
      sock.myCode = c;
      rec.sock = sock;        // this code is now online
      send(sock, { type:'logged-in', code:c });
      return;
    }

    if (m.type === 'call') {
      const target = (m.code || '').toLowerCase();
      const rec = codes.get(target);
      if (!rec || !rec.sock || rec.sock._closed) {
        send(sock, { type:'call-fail', err:'That person is not online right now.' });
        return;
      }
      sock.other = rec.sock;
      rec.sock.other = sock;
      send(rec.sock, { type:'incoming' });        // callee gets "someone is calling"
      send(sock,    { type:'calling' });           // caller knows it's ringing
      return;
    }

    if (m.type === 'answer' || m.type === 'offer' || m.type === 'ice' || m.type === 'hangup') {
      if (sock.other) send(sock.other, m);
    }
  });

  sock.on('close', () => {
    sock._closed = true;
    if (sock.myCode) { const rec = codes.get(sock.myCode); if (rec && rec.sock === sock) rec.sock = null; }
    if (sock.other) { send(sock.other, { type:'peer-left' }); sock.other.other = null; }
  });
});

console.log(`Home Call server on port ${PORT}`);
