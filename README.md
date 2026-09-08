# CallKaro

Call any device by its **code** — browser to browser, no SIM, no app store.
Rings even when the other person's browser/app is **closed** (FCM web push).

## How it works

- Each person picks a personal code (e.g. `dad#1`). Call someone by typing their code.
- Calls are peer-to-peer WebRTC audio; this server only does signaling (WebSocket)
  and push notifications (Firebase Cloud Messaging).
- **Ringing when closed:** if the callee isn't connected, the server holds the
  caller's offer for 60 s and sends an FCM push. When the callee taps the
  notification, the page auto-logs-in (saved code) and the server hands over the
  held call.

## Deploy (Render)

`render.yaml` deploys automatically. Required env var:

- `FIREBASE_SERVICE_ACCOUNT_B64` — the Firebase service-account JSON, base64-encoded.

## Firebase console setup (one-time)

1. **Cloud Messaging:** already configured (server key + web VAPID key in `client/firebase-config.js`).
2. **Firestore (recommended):** create a Firestore database in the same project.
   The server stores codes + push tokens there, so they survive Render restarts
   and sleep. Without it, everything works but codes are lost on every restart
   (the server logs a warning with the exact enable link).

## Local run

```bash
cd server
npm install
node server.js        # http://localhost:8080  (client served from ../client)
```

## Notes

- Push rings work on Android Chrome out of the box. On iPhone/iPad the site must
  be added to the Home Screen first (iOS 16.4+ requirement for web push).
- Free Render instances sleep after ~15 min idle; the first caller may wait
  ~30–60 s while it wakes (the app shows "Waking the server…"). Point a free
  uptime monitor at `/ping` every 10 min to keep it awake 24/7.
