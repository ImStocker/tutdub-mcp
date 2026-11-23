/**
 * Browser-based login / logout for the CLI.
 *
 * login:
 *   1. start a loopback HTTP listener on 127.0.0.1:<ephemeral port>
 *   2. POST /auth/cli/sessions { name, redirect_uri, state }
 *   3. open <frontend>/app/cli-login?session=<id> in the default browser
 *   4. wait for the code (loopback redirect) OR poll status until approved
 *   5. POST /auth/cli/exchange { code | session_id+state } -> td_cli_ token
 *   6. persist to the config file
 *
 * The loopback listener is kept alive until the browser actually lands on
 * it (bounded by a grace period): the frontend redirects ~0.5s after the
 * user clicks "Authorize", which can lose the exchange race against status
 * polling - stopping the listener at that point would show the user
 * ERR_CONNECTION_REFUSED instead of a confirmation page.
 *
 * logout:
 *   POST /auth/cli/logout with the stored token (server-side revoke),
 *   then clear the local config - local clear always happens.
 */

import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { apiRequest, type CliSession, type TokenResponse } from './api';
import { getSettings, saveConfig, type Settings } from './config';

const POLL_INTERVAL_MS = 1500;
/** Overall login deadline (server sessions live 10 min). */
const LOGIN_TIMEOUT_MS = 9 * 60_000;
/**
 * How long the callback listener stays up after a successful exchange so
 * the browser redirect still lands on a live server. The redirect fires
 * ~0.5s after approval, so this is a generous backstop for slow browsers.
 */
const BROWSER_GRACE_MS = 5000;
/** Grace on failure: just enough for an already in-flight redirect. */
const FAILURE_GRACE_MS = 500;
/** Settle time for the confirmation page before closing the socket. */
const CALLBACK_FLUSH_MS = 150;

export interface LoginOptions {
  server?: string;
  frontend?: string;
  /** Device label; defaults to the machine hostname. */
  name?: string;
  /** Do not open a browser; print the URL instead. */
  noBrowser?: boolean;
  /** Test hook: override the browser grace period. */
  browserGraceMs?: number;
  log?: (line: string) => void;
}

/** Outcome of the login flow, used to word the confirmation page. */
type FlowPhase = 'pending' | 'ok' | 'failed';

/** Opens a URL in the platform browser; never throws. */
async function openBrowser(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'win32'
      ? (['cmd', ['/c', 'start', '', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  try {
    Bun.spawn([cmd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    /* caller prints the URL as fallback */
  }
}

interface CallbackResult {
  code: string;
  state: string | null;
}

/**
 * Minimal self-contained page so the browser never shows a raw error.
 */
function page(title: string, heading: string, body: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${title}</title>` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b1020;' +
    'color:#e5e9f0;display:grid;place-items:center;min-height:100vh;margin:0}' +
    'main{text-align:center;padding:2rem;max-width:26rem}' +
    'h1{font-size:1.35rem;margin:0 0 .6rem}' +
    'p{color:#9aa4bd;line-height:1.55;margin:0}' +
    'code{background:#1a2238;padding:.1em .4em;border-radius:5px}</style></head>' +
    `<body><main><h1>${heading}</h1><p>${body}</p></main></body></html>`
  );
}

const PAGE_SIGNED_IN = () =>
  page(
    'TutDub - signed in',
    'You are signed in',
    'You can close this tab and return to your terminal - the CLI is now connected.',
  );
const PAGE_FAILED = () =>
  page(
    'TutDub',
    'Sign-in did not complete',
    'Return to your terminal and run <code>tutdub-mcp login</code> again.',
  );
const PAGE_WAITING = () =>
  page(
    'TutDub CLI',
    'Waiting for authorization',
    'Approve the request on the TutDub page you opened, then return to your terminal.',
  );

/**
 * Starts a loopback listener that resolves with the code the frontend
 * redirects to after the user approves the session. Every request gets an
 * HTML page (success, failure or "waiting") so the user never sees a
 * browser error page while the listener is up.
 */
function startLoopback(
  state: string,
  phase: () => FlowPhase,
): { redirectUri: string; result: Promise<CallbackResult>; stop: () => void } {
  let resolveResult: (v: CallbackResult) => void = () => {};
  const result = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });

  // Port 0 -> OS assigns a free port; we learn it from Bun.serve.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const html = (body: string, status = 200) =>
        new Response(body, {
          status,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });

      if (url.pathname !== '/callback') {
        // Favicon requests, probes, curious users: keep it friendly.
        return html(PAGE_WAITING());
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code || returnedState !== state) {
        // Do NOT abort the flow here: status polling is still running as a
        // fallback, so just explain and keep listening.
        return html(
          page(
            'TutDub',
            'This sign-in link is incomplete',
            'Return to your terminal - if the CLI is still waiting, approve the request again.',
          ),
          400,
        );
      }

      resolveResult({ code, state: returnedState });
      // If the flow already failed by the time the browser arrives, say so
      // instead of claiming success.
      return html(phase() === 'failed' ? PAGE_FAILED() : PAGE_SIGNED_IN());
    },
  });

  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    result,
    stop: () => server.stop(true),
  };
}

export async function login(opts: LoginOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const settings = getSettings({ server: opts.server, frontend: opts.frontend });
  const name = (opts.name ?? hostname()).slice(0, 100);
  const state = randomBytes(16).toString('hex');
  const browserGraceMs = opts.browserGraceMs ?? BROWSER_GRACE_MS;

  let phase: FlowPhase = 'pending';
  const pollState = { cancelled: false };
  const { redirectUri, result, stop } = startLoopback(state, () => phase);

  /**
   * Stops the callback listener only after the browser had its chance to
   * land on it (the redirect can lose the exchange race against status
   * polling), so the user gets a confirmation page instead of
   * ERR_CONNECTION_REFUSED. Always runs - including on failure - so the
   * listener can never leak and keep the process alive.
   */
  const finishListener = async (graceMs: number): Promise<void> => {
    pollState.cancelled = true;
    const landed = await Promise.race([
      result.then(() => true, () => false),
      sleep(graceMs).then(() => false),
    ]);
    if (landed) await sleep(CALLBACK_FLUSH_MS); // let the page flush
    stop();
  };

  let succeeded = false;
  try {
    let session: CliSession;
    try {
      session = await apiRequest<CliSession>(settings.server, '/auth/cli/sessions', {
        method: 'POST',
        body: { name, redirect_uri: redirectUri, state },
      });
    } catch (err) {
      throw new Error(
        `Could not start a login session on ${settings.server}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const loginUrl = `${settings.frontend}/cli-login?session=${encodeURIComponent(session.id)}`;
    log(`\nOpen this URL to authorize the CLI:\n\n  ${loginUrl}\n`);
    if (!opts.noBrowser) {
      await openBrowser(loginUrl);
      log('Waiting for authorization in the browser (Ctrl+C to abort)…');
    }

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    const exchange = async (body: Record<string, unknown>): Promise<TokenResponse> => {
      // Whichever path (redirect or polling) wins, the session is single-use;
      // the loser's exchange fails with INVALID_CODE which we ignore.
      return apiRequest<TokenResponse>(settings.server, '/auth/cli/exchange', {
        method: 'POST',
        body: { ...body, name },
      });
    };

    const winner = await Promise.race([
      result.then((cb) => exchange({ code: cb.code })),
      pollForApproval(settings, session.id, state, deadline, log, pollState).then((proof) =>
        // null = cancelled, or the loopback path already exchanged: park
        // this branch so only the remaining path can settle the race.
        proof ? exchange(proof) : new Promise<never>(() => {}),
      ),
    ]);

    saveConfig({
      server: settings.server,
      frontend: settings.frontend,
      token: winner.token,
      tokenName: winner.name,
    });
    log(`\nLogged in as "${winner.name}". Token saved to the config file.`);
    log('Run `tutdub-mcp whoami` to verify, `tutdub-mcp logout` to revoke.');
    succeeded = true;
  } finally {
    phase = succeeded ? 'ok' : 'failed';
    await finishListener(succeeded ? browserGraceMs : FAILURE_GRACE_MS);
  }
}

/**
 * Polls session status until approved/expired. Resolves with the proof
 * body for the exchange endpoint (session_id + state path), or `null`
 * when the poller is no longer needed (cancelled, or the loopback path
 * already completed the exchange).
 */
async function pollForApproval(
  settings: Settings,
  sessionId: string,
  state: string,
  deadline: number,
  log: (line: string) => void,
  pollState: { cancelled: boolean },
): Promise<Record<string, unknown> | null> {
  let announcedPending = false;
  while (!pollState.cancelled && Date.now() < deadline) {
    let session: CliSession;
    try {
      session = await apiRequest<CliSession>(
        settings.server,
        `/auth/cli/sessions/${encodeURIComponent(sessionId)}`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('Not found')) {
        throw new Error('Login session expired. Run `tutdub-mcp login` again.');
      }
      await sleep(POLL_INTERVAL_MS, pollState);
      continue;
    }
    if (pollState.cancelled) return null;

    if (session.status === 'approved') {
      return { session_id: sessionId, state };
    }
    if (session.status === 'exchanged') {
      // The loopback path already completed the exchange - stop polling
      // instead of spinning until the deadline (which would keep the
      // process alive long after a successful login).
      return null;
    }
    if (session.status === 'expired') {
      throw new Error('Login session expired. Run `tutdub-mcp login` again.');
    }
    if (!announcedPending) {
      announcedPending = true;
      log('Session pending… approve the request in your browser.');
    }
    await sleep(POLL_INTERVAL_MS, pollState);
  }
  if (pollState.cancelled) return null;
  throw new Error('Login timed out. Run `tutdub-mcp login` again.');
}

/**
 * setTimeout promise that resolves early once `pollState` is cancelled, so
 * an abandoned poller never keeps the event loop (and the process) alive
 * after login has finished.
 */
function sleep(ms: number, pollState?: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (pollState?.cancelled || Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    setTimeout(tick, Math.min(50, ms));
  });
}

/** Revokes the server-side token (best effort) and clears local config. */
export async function logout(opts: { log?: (line: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const settings = getSettings();
  if (!settings.token) {
    log('Already logged out.');
    return;
  }
  try {
    await apiRequest(settings.server, '/auth/cli/logout', {
      method: 'POST',
      token: settings.token,
    });
    log('Token revoked on the server.');
  } catch (err) {
    log(
      `Could not reach the server to revoke (${err instanceof Error ? err.message : String(err)}); clearing local credentials anyway.`,
    );
  }
  saveConfig({ token: undefined, tokenName: undefined, email: undefined });
}

/** GET /auth/cli/me - verifies the stored token and caches the email. */
export async function whoami(
  settings: Settings,
): Promise<{ id: string; name: string; email: string }> {
  const { user } = await apiRequest<{ user: { id: string; name: string; email: string } }>(
    settings.server,
    '/auth/cli/me',
    { token: settings.token },
  );
  saveConfig({ email: user.email });
  return user;
}
