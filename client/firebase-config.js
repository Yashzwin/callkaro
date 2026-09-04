/*
  Firebase web config for Home Call push notifications.
  - Copy your real values from the Firebase console (Project settings -> General).
  - VAPID key from Project settings -> Cloud Messaging -> Web Push certificates.

  When apiKey starts with "PASTE", the client skips push init (signaling
  still works over WebSocket — just no wake-up of closed tabs).
*/
window.FIREBASE_CONFIG = {
  apiKey: "PASTE_apiKey",
  authDomain: "PASTE_authDomain",
  projectId: "PASTE_projectId",
  storageBucket: "PASTE_storageBucket",
  messagingSenderId: "PASTE_messagingSenderId",
  appId: "PASTE_appId",
  measurementId: "PASTE_measurementId"
};
window.FIREBASE_VAPID = "PASTE_VAPID_KEY";
