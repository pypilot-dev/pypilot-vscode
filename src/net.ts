/**
 * net.ts — the HTTP(S) requests behind engine downloads: JSON, small text
 * files and archives, with redirects, idle timeouts and readable errors.
 * No `vscode` import, so it can be tested against a local server.
 *
 * Proxies: with VS Code's default `http.proxySupport: "override"` the
 * extension host patches Node's `https` module for extensions and applies
 * `http.proxy` / the system proxy / `HTTPS_PROXY` itself, so nothing is
 * needed here. When the user sets `http.proxySupport` to "off", that
 * patching is gone and the downloader calls `setEnvProxy(true)`: requests
 * then honour `HTTPS_PROXY` / `NO_PROXY` like other command-line tools,
 * through an HTTP CONNECT tunnel.
 *
 * Plain `http:` is refused except for loopback hosts (the tests' local
 * release server).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { Duplex } from 'stream';
import * as tls from 'tls';

/** Idle timeouts. `setTimeout` on a request resets on activity, so a
 *  slow-but-moving download never trips them. */
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Redirect chains are followed at most this many times. */
const MAX_REDIRECTS = 5;
/** SHA256SUMS and API answers are small; refuse anything absurd. */
const MAX_TEXT_BYTES = 1024 * 1024;

const USER_AGENT = 'pypilot-vscode';

let envProxyEnabled = false;

/** Route requests through `HTTPS_PROXY` / `NO_PROXY` (see the module doc). */
export function setEnvProxy(enabled: boolean): void {
  envProxyEnabled = enabled;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    // Rate limiting is the common case: unauthenticated GitHub API calls are
    // capped at 60 per hour.
    const hint =
      status === 403 || status === 429 ? ' (GitHub rate limit reached, try again later)' : '';
    super(`Request to ${url} failed with HTTP ${status}${hint}`);
    this.name = 'HttpStatusError';
  }
}

export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * The proxy for `target` from the environment, or undefined for a direct
 * connection. `NO_PROXY` takes `*`, host names (matching subdomains too, with
 * or without a leading dot) and optional `:port` suffixes.
 */
export function proxyFromEnv(target: URL, env: NodeJS.ProcessEnv): URL | undefined {
  if (isLoopback(target.hostname)) return undefined;
  const raw =
    target.protocol === 'https:'
      ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
      : env.http_proxy || env.HTTP_PROXY;
  if (!raw) return undefined;

  const noProxy = (env.no_proxy || env.NO_PROXY || '').toLowerCase();
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const entry of noProxy.split(/[\s,]+/).filter(Boolean)) {
    if (entry === '*') return undefined;
    const [name, entryPort] = entry.replace(/^\*?\./, '').split(':');
    if (entryPort && entryPort !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return undefined;
  }

  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

/** An https agent that reaches its targets through an HTTP CONNECT proxy. */
class TunnelAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false });
  }

  createConnection(
    options: http.RequestOptions & tls.ConnectionOptions,
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const done = callback ?? (() => undefined);
    const fail = (err: Error) => done(err, undefined as unknown as Duplex);
    const host = options.hostname ?? options.host ?? 'localhost';
    const port = Number(options.port ?? 443);
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (this.proxy.username) {
      const creds = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }
    const lib = this.proxy.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: this.proxy.hostname,
      port: this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy ${this.proxy.host} refused CONNECT ${host}:${port} with HTTP ${res.statusCode}`));
        return;
      }
      done(null, tls.connect({ ...options, host, port, socket, servername: options.servername ?? host }));
    });
    req.once('error', (err) => fail(new Error(`Proxy ${this.proxy.host}: ${err.message}`)));
    req.end();
    return undefined;
  }
}

function get(
  url: string,
  headers: Record<string, string>,
  onResponse: (res: http.IncomingMessage) => void
): http.ClientRequest {
  const target = new URL(url);
  const allHeaders = { 'User-Agent': USER_AGENT, ...headers };
  if (target.protocol === 'http:' && isLoopback(target.hostname)) {
    return http.get(target, { headers: allHeaders }, onResponse);
  }
  if (target.protocol !== 'https:') {
    throw new Error(`Refusing to fetch ${url}: only https is allowed`);
  }
  const proxy = envProxyEnabled ? proxyFromEnv(target, process.env) : undefined;
  return https.get(
    target,
    { headers: allHeaders, ...(proxy ? { agent: new TunnelAgent(proxy) } : {}) },
    onResponse
  );
}

/** GET a small body as text, following redirects. Throws `HttpStatusError`
 *  on a non-2xx answer. */
export function fetchText(
  url: string,
  headers: Record<string, string> = {},
  redirectsLeft = MAX_REDIRECTS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let request: http.ClientRequest;
    try {
      request = get(url, headers, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          request.destroy();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects while requesting ${url}`));
            return;
          }
          fetchText(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1).then(
            resolve,
            reject
          );
          return;
        }
        // Without this check a 403/404 body would be parsed as if it were
        // the expected content.
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new HttpStatusError(status, url));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          body += d;
          if (body.length > MAX_TEXT_BYTES) {
            request.destroy(new Error(`Response from ${url} is larger than ${MAX_TEXT_BYTES} bytes`));
          }
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
    } catch (err) {
      reject(err);
      return;
    }
    request.setTimeout(API_TIMEOUT_MS, () => {
      request.destroy(new Error(`Request to ${url} timed out after ${API_TIMEOUT_MS}ms`));
    });
    request.on('error', reject);
  });
}

export async function fetchJson<T>(url: string): Promise<T> {
  const body = await fetchText(url, { Accept: 'application/vnd.github+json' });
  try {
    return JSON.parse(body) as T;
  } catch (e) {
    throw new Error(`Could not parse the response from ${url}: ${e}`);
  }
}

/** Download `url` to `dest`, following redirects. A partial file is deleted
 *  on failure, and an error page is never written as if it were the file. */
export function downloadFile(url: string, dest: string, redirectsLeft = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      file.close(() => {
        fs.rmSync(dest, { force: true });
        reject(err);
      });
    };

    let request: http.ClientRequest;
    try {
      request = get(url, {}, (res) => {
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          const location = res.headers.location;
          res.resume();
          settled = true;
          file.close(() => {
            fs.rmSync(dest, { force: true });
            if (redirectsLeft <= 0) {
              reject(new Error(`Too many redirects while downloading ${url}`));
              return;
            }
            downloadFile(new URL(location, url).toString(), dest, redirectsLeft - 1).then(resolve, reject);
          });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          fail(new HttpStatusError(status, url));
          return;
        }

        res.on('error', fail);
        res.pipe(file);
        file.on('finish', () =>
          file.close((err) => {
            if (settled) return;
            settled = true;
            if (err) {
              reject(err);
              return;
            }
            resolve();
          })
        );
      });
    } catch (err) {
      fail(err as Error);
      return;
    }

    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download of ${url} timed out after ${DOWNLOAD_TIMEOUT_MS}ms of inactivity`));
    });
    request.on('error', fail);
    file.on('error', fail);
  });
}
