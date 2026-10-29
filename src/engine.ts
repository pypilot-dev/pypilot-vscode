/**
 * engine.ts — the pure parts of engine distribution: versions, the engine
 * pin in package.json, release asset names, SHA-256 checks and SHA256SUMS
 * parsing. No `vscode` import, so `bun test` covers all of it.
 *
 * The pin is the `pypilotEngine` field of package.json:
 *
 *   "pypilotEngine": { "version": "1.2.2", "sha256": { "<asset>": "<hex>" } }
 *
 * It is a contract with the engine's release-coordination workflow, which
 * bumps it on each engine release: never rename or reshape it.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';

export type Version = [number, number, number];

/** `pypilot.engineUpdates`: which engine releases the update check offers. */
export type EngineUpdatePolicy = 'pinned' | 'latest';

export interface EnginePin {
  version: string;
  /** Lowercase hex SHA-256 per release asset name. */
  sha256: Record<string, string>;
}

/** Name of the checksum asset the engine release workflow uploads. */
export const SHA256SUMS_ASSET = 'SHA256SUMS';

/** `"pypilot 1.2.2"`, `"v1.2.2"` or `"1.2.2"` → `[1, 2, 2]`. */
export function parseVersion(text: string): Version | undefined {
  const m = text.trim().match(/(?:^|pypilot\s+)v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

export function fmtVersion([ma, mi, pa]: Version): string {
  return `${ma}.${mi}.${pa}`;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Read and validate the pin from a parsed package.json. Throws on a missing
 * or malformed pin: an extension build without one must fail loudly rather
 * than quietly fall back to "latest".
 */
export function readEnginePin(packageJson: unknown): EnginePin {
  const raw = (packageJson as { pypilotEngine?: unknown } | undefined)?.pypilotEngine as
    | { version?: unknown; sha256?: unknown }
    | undefined;
  if (!raw || typeof raw.version !== 'string' || !parseVersion(raw.version)) {
    throw new Error('package.json has no valid "pypilotEngine.version"');
  }
  if (!raw.sha256 || typeof raw.sha256 !== 'object') {
    throw new Error('package.json has no "pypilotEngine.sha256" table');
  }
  const sha256: Record<string, string> = {};
  for (const [name, hex] of Object.entries(raw.sha256 as Record<string, unknown>)) {
    const h = typeof hex === 'string' ? hex.toLowerCase() : '';
    if (!HEX64.test(h)) {
      throw new Error(`package.json "pypilotEngine.sha256" entry for ${name} is not a SHA-256 hex digest`);
    }
    sha256[name] = h;
  }
  return { version: fmtVersion(parseVersion(raw.version)!), sha256 };
}

/** Release asset name for a platform, or undefined when no engine build exists. */
export function assetForPlatform(platform: string, arch: string): string | undefined {
  const slug =
    platform === 'linux' && arch === 'x64'
      ? 'linux-x64'
      : platform === 'linux' && arch === 'arm64'
        ? 'linux-arm64'
        : platform === 'darwin' && arch === 'x64'
          ? 'darwin-x64'
          : platform === 'darwin' && arch === 'arm64'
            ? 'darwin-arm64'
            : platform === 'win32' && arch === 'x64'
              ? 'windows-x64'
              : undefined;
  if (!slug) return undefined;
  return `pypilot-${slug}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

/**
 * Parse a `sha256sum`-style file: `<hex>  <name>` per line (`<hex> *<name>`
 * in binary mode is accepted too). Blank lines and `#` comments are skipped;
 * malformed lines are ignored rather than trusted.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    const name = m[2].trim().replace(/^\.\//, '');
    sums.set(name, m[1].toLowerCase());
  }
  return sums;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly asset: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}. ` +
        'The download was deleted and nothing was installed. Retry later; if it keeps happening, ' +
        'report it at https://github.com/pypilot-dev/pypilot-vscode/issues.'
    );
    this.name = 'ChecksumMismatchError';
  }
}

/** Hash `file`; on mismatch delete it and throw `ChecksumMismatchError`. */
export async function verifySha256(file: string, asset: string, expected: string): Promise<void> {
  const want = expected.toLowerCase();
  let actual: string;
  try {
    actual = await sha256File(file);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (actual !== want) {
    fs.rmSync(file, { force: true });
    throw new ChecksumMismatchError(asset, want, actual);
  }
}

/**
 * Which engine version the update check should offer, if any.
 *
 * - "pinned": the pin, when it is newer than what is installed. A new
 *   extension release carries a new pin, so updating the extension is what
 *   brings a new engine.
 * - "latest": the newer of the pin and the latest release (when known).
 *
 * Never offers a downgrade: a PATH or locally built helper newer than the
 * pin is left alone.
 */
export function selectUpdateTarget(
  policy: EngineUpdatePolicy,
  installed: Version,
  pinned: Version,
  latest?: Version
): Version | undefined {
  let target = pinned;
  if (policy === 'latest' && latest && compareVersions(latest, target) > 0) {
    target = latest;
  }
  return compareVersions(target, installed) > 0 ? target : undefined;
}

/**
 * The SHA-256 a download must match, from the pin when it covers this
 * version and asset. Undefined means "look it up in the release's SHA256SUMS".
 */
export function pinnedSha256(pin: EnginePin, version: string, asset: string): string | undefined {
  return pin.version === version ? pin.sha256[asset] : undefined;
}
