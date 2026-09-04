/*
  CONFIG — fill the TURN part (free). The server URL is taken from the page
  address automatically, so no change needed there.

  TURN = lets calls cross different networks (home <-> office, or phone on
  mobile data). Get free credentials from https://metered.ca (free 1 GB/month):
    sign up -> TURN Credentials -> you get a turn: URL + username + credential.
  Until you fill this, calls only work on the SAME Wi-Fi.
*/
window.APP_CONFIG = {
  // Leave empty to auto-detect from the page URL (works on laptop AND cloud).
  SIGNAL_HOST: "",
  // Leave empty to use the same port as the page (cloud hosts use one port).
  SIGNAL_PORT: "",

  // Public free TURN relay (metered.ca, no signup). Works across networks
  // (home <-> office, mobile data). For private/secret calls later, swap this
  // for your own TURN (coturn) or a metered API key.
  turnServers: [
    { urls: "turn:openrelay.metered.ca:80",
      username: "openrelay-project",
      credential: "OZfGxR9KZb" },
    { urls: "turns:openrelay.metered.ca:443",
      username: "openrelay-project",
      credential: "OZfGxR9KZb" }
  ]
};
