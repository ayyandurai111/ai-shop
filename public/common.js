// Shared authentication and session management for AI Shop.
const TOKEN_KEY = 'demo_token';

/**
 * Returns the stored access token if present and not expired locally.
 */
async function getToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (t && t.token && Number(t.exp) > Date.now() + 10000) {
      return t.token;
    }
  } catch (e) {
    /* ignore malformed json */
  }
  localStorage.removeItem(TOKEN_KEY);
  return null;
}

/**
 * Verifies session validity with the backend server.
 * If token is revoked or expired on the server, cleans up localStorage and returns null.
 */
async function verifySession() {
  const tok = await getToken();
  if (!tok) return null;
  try {
    const res = await fetch('/demo/session', {
      headers: { Authorization: 'Bearer ' + tok },
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.authenticated) return tok;
    } else if (res.status === 401) {
      // Token revoked or expired on server
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
  } catch (e) {
    // If network error, preserve local token
    return tok;
  }
  return tok;
}

/**
 * Performs demo login by creating a new session token on the server.
 */
async function demoLogin() {
  const r = await fetch('/demo/session', { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j.error_description || j.error || 'Demo login failed');
  }
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 })
  );
  return j.access_token;
}

/**
 * Revokes the current session token on the server and clears client storage.
 */
async function demoLogout() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    const tok = raw ? JSON.parse(raw)?.token : null;
    if (tok) {
      await fetch('/demo/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + tok,
        },
        body: JSON.stringify({ token: tok }),
      }).catch(() => {});
    }
  } catch (e) {
    /* ignore network errors during logout */
  }
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Ensures user is authenticated; if not, immediately redirects to /login.
 */
async function requireAuthOrRedirect() {
  const tok = await verifySession();
  if (!tok) {
    window.location.replace('/login');
    return null;
  }
  return tok;
}

/**
 * Helper to wrap fetch calls with bearer auth and handle 401 unauthenticated automatically.
 */
async function authFetch(url, options = {}) {
  const tok = await getToken();
  if (!tok) {
    await demoLogout();
    window.location.replace('/login');
    throw new Error('Unauthenticated');
  }
  const opts = { ...options };
  opts.headers = {
    ...(opts.headers || {}),
    Authorization: 'Bearer ' + tok,
  };
  const res = await fetch(url, opts);
  if (res.status === 401) {
    await demoLogout();
    window.location.replace('/login');
    throw new Error('Session expired or invalidated. Redirecting to login.');
  }
  return res;
}
