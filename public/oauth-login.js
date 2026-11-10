// Consent page for MCP clients. The server re-validates everything; this page is not trusted.
// No Google / GitHub: "Allow" signs in as the shared demo account on the server.
(function () {
  const KEY = 'oauth_req';
  const $ = (id) => document.getElementById(id);
  const PANELS = ['loading', 'err', 'consent', 'done'];
  const show = (id) => PANELS.forEach((p) => { $(p).hidden = p !== id; });
  const fail = (msg) => { $('errmsg').textContent = msg; show('err'); };

  // The request arrives in the query string from /authorize and is moved to sessionStorage.
  function loadRequest() {
    const q = new URLSearchParams(location.search);
    try {
      if (q.get('client_id')) {
        const r = {
          client_id: q.get('client_id') || '',
          redirect_uri: q.get('redirect_uri') || '',
          code_challenge: q.get('code_challenge') || '',
          state: q.get('state') || '',
          resource: q.get('resource') || '',
          ts: Date.now(),
        };
        sessionStorage.setItem(KEY, JSON.stringify(r));
        history.replaceState(null, '', location.pathname); // keep state / challenge out of the address bar
        return r;
      }
      const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (saved && Date.now() - saved.ts < 15 * 60 * 1000) return saved;
    } catch (e) { /* storage blocked */ }
    return null;
  }
  const body = (r) => JSON.stringify({
    client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, state: r.state, resource: r.resource || undefined,
  });

  (async () => {
    const req = loadRequest();
    if (!req) return fail('Open this page from your AI app (use its Connect button). Nothing to approve here.');

    let info;
    try {
      const r = await fetch('/oauth/client-info?' + new URLSearchParams({ client_id: req.client_id, redirect_uri: req.redirect_uri }));
      if (!r.ok) throw new Error('bad');
      info = await r.json();
    } catch (e) {
      return fail('This connection request is invalid or has expired. Go back to your AI app and try again.');
    }
    if (!info.demo_enabled) return fail('The demo account is not set up on this server (DEMO_USER_ID is missing).');

    // textContent only: the app name is chosen by whoever registered the client.
    $('appname').textContent = info.client_name;
    $('dest').textContent = info.redirect_host;
    show('consent');

    const lock = (v) => { $('allow').disabled = v; $('deny').disabled = v; };
    const finish = (url, msg) => {
      try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      $('donemsg').textContent = msg + info.client_name + '...';
      show('done');
      location.replace(url);
    };

    $('allow').onclick = async () => {
      lock(true);
      try {
        const r = await fetch('/oauth/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(req) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.redirect_url) throw new Error(j.error_description || 'Could not approve. Please try again.');
        finish(j.redirect_url, 'Allowed. Returning to ');
      } catch (e) {
        lock(false);
        $('errmsg').textContent = e.message;
        show('err');
        setTimeout(() => show('consent'), 2500);
      }
    };
    $('deny').onclick = async () => {
      lock(true);
      try {
        const r = await fetch('/oauth/deny', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(req) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.redirect_url) throw new Error('Could not send your answer.');
        finish(j.redirect_url, 'Denied. Returning to ');
      } catch (e) { lock(false); fail(e.message); }
    };
  })();
})();
