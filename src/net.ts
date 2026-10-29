/**
 * net.ts — the HTTP(S) requests behind engine downloads: JSON, small text
 * files and archives, with redirects, idle timeouts and readable errors.
 * No `vscode` import, so it can be tested against a local server.
 *
 * Plain `http:` is refused except for loopback hosts (the tests' local
 * release server).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

/** Idle timeouts. `setTimeout` on a request resets on activity, so a
 *  slow-but-moving download never trips them. */
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Redirect chains are followed at most this many times. */
const MAX_REDIRECTS = 5;
/** SHA256SUMS and API answers are small; refuse anything absurd. */
const MAX_TEXT_BYTES = 1024 * 1024;

const USER_AGENT = 'pypilot-vscode';

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
  return https.get(target, { headers: allHeaders }, onResponse);
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
