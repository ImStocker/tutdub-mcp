/**
 * Integration test for the browser login flow against a mock TutDub
 * server: session creation, approval, both exchange paths (loopback code
 * and status polling), config persistence and logout.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, logout } from '../src/auth';
import { loadConfig } from '../src/config';

interface MockSession {
  id: string;
  status: 'pending' | 'approved' | 'exchanged' | 'expired';
  name: string;
  state: string | null;
  redirectUri: string;
  code: string | null;
}

function startMockServer(): {
  url: string;
  sessions: Map<string, MockSession>;
  stop: () => void;
  approve: (id: string) => void;
  /** When the (first) successful exchange happened, for race assertions. */
  exchangedAt: () => number | null;
} {
  const sessions = new Map<string, MockSession>();
  let counter = 0;
  let exchangedAt: number | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (method === 'POST' && path === '/auth/cli/sessions') {
        const body = (await req.json()) as {
          name: string;
          redirect_uri: string;
          state: string;
        };
        const id = `sess-${++counter}`;
        sessions.set(id, {
          id,
          status: 'pending',
          name: body.name,
          state: body.state,
          redirectUri: body.redirect_uri,
          code: null,
        });
        return json({ id, status: 'pending', name: body.name, expiresAt: new Date().toISOString() });
      }

      if (method === 'GET' && path.startsWith('/auth/cli/sessions/')) {
        const id = decodeURIComponent(path.split('/').pop()!);
        const s = sessions.get(id);
        if (!s) return json({ error: 'Session not found', code: 'NOT_FOUND' }, 404);
        return json({ id: s.id, status: s.status, name: s.name, expiresAt: new Date().toISOString() });
      }

      if (method === 'POST' && path === '/auth/cli/exchange') {
        const body = (await req.json()) as {
          code?: string;
          session_id?: string;
          state?: string;
          name?: string;
        };
        let session: MockSession | undefined;
        if (body.code) {
          session = [...sessions.values()].find(
            (s) => s.status === 'approved' && s.code === body.code,
          );
        } else if (body.session_id) {
          session = sessions.get(body.session_id);
          if (
            !session ||
            session.status !== 'approved' ||
            session.state !== body.state
          ) {
            return json({ error: 'The code is invalid or has expired', code: 'INVALID_CODE' }, 400);
          }
        }
        if (!session || session.status !== 'approved') {
          return json({ error: 'The code is invalid or has expired', code: 'INVALID_CODE' }, 400);
        }
        session.status = 'exchanged';
        exchangedAt ??= Date.now();
        return json({ token: `td_cli_mock${counter}token`, name: body.name ?? session.name });
      }

      if (method === 'POST' && path === '/auth/cli/logout') {
        return json({ success: true });
      }

      return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    sessions,
    stop: () => server.stop(true),
    approve: (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      s.status = 'approved';
      // code path: mimic server generating a one-time code
      s.code = 'AB12-CD34-EF56';
    },
    exchangedAt: () => exchangedAt,
  };
}

describe('login flow (integration)', () => {
  let configHome: string;
  let mock: ReturnType<typeof startMockServer>;
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'tutdub-mcp-cfg-'));
    process.env.TUTDUB_CONFIG_HOME = configHome;
    process.env.TUTDUB_SERVER_URL = ''; // force config/default path
    delete process.env.TUTDUB_SERVER_URL;
    delete process.env.TUTDUB_TOKEN;
    mock = startMockServer();
    process.env.TUTDUB_SERVER_URL = mock.url;
    logs.length = 0;
  });

  afterEach(() => {
    mock.stop();
    delete process.env.TUTDUB_CONFIG_HOME;
    delete process.env.TUTDUB_SERVER_URL;
    rmSync(configHome, { recursive: true, force: true });
  });

  test('completes via the status-polling path and persists the token', async () => {
    // Approve shortly after the session appears (simulates the user click).
    // No browser redirect in this test -> the grace period is shortened.
    const approver = setTimeout(() => {
      for (const id of mock.sessions.keys()) mock.approve(id);
    }, 300);

    await login({ noBrowser: true, name: 'test-device', log, browserGraceMs: 100 });
    clearTimeout(approver);

    const cfg = loadConfig();
    expect(cfg.token).toStartWith('td_cli_');
    expect(cfg.tokenName).toBe('test-device');
    expect(cfg.server).toBe(mock.url);
    expect(logs.join('\n')).toContain('Logged in as "test-device"');

    // Config file exists and holds the token.
    const raw = readFileSync(join(configHome, 'config.json'), 'utf8');
    expect(raw).toContain('td_cli_');

    // Sessions are burned: exactly one exchange happened.
    const statuses = [...mock.sessions.values()].map((s) => s.status);
    expect(statuses).toEqual(['exchanged']);
  }, 20_000);

  test('serves the confirmation page when the browser lands after polling won', async () => {
    // Regression: the frontend redirects ~0.5s after approval, but a status
    // poll inside that window can complete the exchange first. The old code
    // stopped the loopback listener as soon as the exchange race settled,
    // so the browser got ERR_CONNECTION_REFUSED ("This site can't be
    // reached"). The listener must stay up until the redirect lands.
    const approveAt = setTimeout(() => {
      for (const id of mock.sessions.keys()) mock.approve(id);
    }, 200);

    // Browser redirect lands well after the next poll (t≈1.5s) exchanged.
    let callbackStatus = 0;
    let callbackBody = '';
    const startedAt = Date.now();
    const redirectAt = setTimeout(() => {
      void (async () => {
        for (const s of mock.sessions.values()) {
          const res = await fetch(
            `${s.redirectUri}?code=${encodeURIComponent(s.code!)}&state=${encodeURIComponent(s.state!)}`,
          );
          callbackStatus = res.status;
          callbackBody = await res.text();
        }
      })();
    }, 2100);

    await login({ noBrowser: true, name: 'late-browser', log });
    clearTimeout(approveAt);
    clearTimeout(redirectAt);

    // The exchange was won by status polling, before the browser arrived...
    const exchangedAt = mock.exchangedAt();
    expect(exchangedAt).not.toBeNull();
    expect(exchangedAt! - startedAt).toBeLessThan(2100);
    expect(loadConfig().token).toStartWith('td_cli_');
    expect(logs.join('\n')).toContain('Logged in as "late-browser"');
    // ...yet the listener was still alive and served the confirmation page.
    expect(callbackStatus).toBe(200);
    expect(callbackBody).toContain('You are signed in');
  }, 20_000);

  test('completes via the loopback redirect (code) path', async () => {
    // Approve + fetch the loopback callback ourselves (what the browser
    // redirect would do), racing the poller exactly like production.
    let page = '';
    const cb = setTimeout(() => {
      for (const s of mock.sessions.values()) {
        mock.approve(s.id);
        // Fire the loopback callback with the code the frontend received.
        void (async () => {
          const res = await fetch(
            `${s.redirectUri}?code=${encodeURIComponent(s.code!)}&state=${encodeURIComponent(s.state!)}`,
          );
          page = await res.text();
        })();
      }
    }, 300);

    await login({ noBrowser: true, name: 'loopback-device', log });
    clearTimeout(cb);

    const cfg = loadConfig();
    expect(cfg.token).toStartWith('td_cli_');
    expect([...mock.sessions.values()].map((s) => s.status)).toEqual(['exchanged']);
    expect(page).toContain('You are signed in');
  }, 20_000);

  test('logout revokes server-side and clears local config', async () => {
    const approver = setTimeout(() => {
      for (const id of mock.sessions.keys()) mock.approve(id);
    }, 300);
    await login({ noBrowser: true, log, browserGraceMs: 100 });
    clearTimeout(approver);
    expect(loadConfig().token).toStartWith('td_cli_');

    await logout({ log });
    expect(loadConfig().token).toBeUndefined();
    expect(logs.join('\n')).toContain('Token revoked on the server');
  }, 20_000);

  test('fails clearly when the session is never approved', async () => {
    // No approval -> polling keeps going until the server marks it expired.
    // Speed this up: mark the session expired after a moment.
    const expirer = setTimeout(() => {
      for (const s of mock.sessions.values()) s.status = 'expired';
    }, 500);
    await expect(login({ noBrowser: true, log })).rejects.toThrow(
      /expired/i,
    );
    clearTimeout(expirer);
    expect(loadConfig().token).toBeUndefined();
  }, 20_000);
});
