import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChecksumMismatchError,
  assetForPlatform,
  compareVersions,
  parseSha256Sums,
  parseVersion,
  pinnedSha256,
  readEnginePin,
  selectUpdateTarget,
  sha256File,
  verifySha256,
} from "../src/engine";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "pypilot-engine-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("versions", () => {
  test("parses helper output, tags and bare versions", () => {
    expect(parseVersion("pypilot 1.2.2")).toEqual([1, 2, 2]);
    expect(parseVersion("pypilot 1.10.0\n")).toEqual([1, 10, 0]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.9.12")).toEqual([0, 9, 12]);
    expect(parseVersion("pypilot")).toBeUndefined();
    expect(parseVersion("something 1.2.3")).toBeUndefined();
  });

  test("compares numerically, not lexically", () => {
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([1, 2, 2], [1, 2, 2])).toBe(0);
    expect(compareVersions([0, 9, 0], [1, 0, 0])).toBeLessThan(0);
  });
});

describe("engine pin", () => {
  test("package.json pins a version with a hash for every published asset", () => {
    const pin = readEnginePin(pkg);
    expect(parseVersion(pin.version)).toBeDefined();
    const published = [
      assetForPlatform("win32", "x64"),
      assetForPlatform("linux", "x64"),
      assetForPlatform("darwin", "arm64"),
      assetForPlatform("darwin", "x64"),
    ] as string[];
    expect(Object.keys(pin.sha256).sort()).toEqual(published.sort());
    for (const hex of Object.values(pin.sha256)) expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects a missing or malformed pin", () => {
    expect(() => readEnginePin({})).toThrow(/pypilotEngine.version/);
    expect(() => readEnginePin({ pypilotEngine: { version: "1.2.2" } })).toThrow(/sha256/);
    expect(() => readEnginePin({ pypilotEngine: { version: "1.2.2", sha256: { a: "xyz" } } })).toThrow(
      /not a SHA-256/,
    );
  });

  test("normalises the version and hex digests", () => {
    const pin = readEnginePin({ pypilotEngine: { version: "v2.0.0", sha256: { a: "AB".repeat(32) } } });
    expect(pin).toEqual({ version: "2.0.0", sha256: { a: "ab".repeat(32) } });
  });

  test("only the pinned version gets its hash from the pin", () => {
    const pin = { version: "1.2.2", sha256: { "pypilot-linux-x64.tar.gz": "a".repeat(64) } };
    expect(pinnedSha256(pin, "1.2.2", "pypilot-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(pinnedSha256(pin, "1.3.0", "pypilot-linux-x64.tar.gz")).toBeUndefined();
    expect(pinnedSha256(pin, "1.2.2", "pypilot-linux-arm64.tar.gz")).toBeUndefined();
  });
});

describe("assetForPlatform", () => {
  test("names the release archives", () => {
    expect(assetForPlatform("win32", "x64")).toBe("pypilot-windows-x64.zip");
    expect(assetForPlatform("linux", "x64")).toBe("pypilot-linux-x64.tar.gz");
    expect(assetForPlatform("darwin", "arm64")).toBe("pypilot-darwin-arm64.tar.gz");
    expect(assetForPlatform("win32", "arm64")).toBeUndefined();
    expect(assetForPlatform("freebsd", "x64")).toBeUndefined();
  });
});

describe("selectUpdateTarget", () => {
  test("pinned: offers the pin only when it is newer", () => {
    expect(selectUpdateTarget("pinned", [1, 2, 0], [1, 2, 2])).toEqual([1, 2, 2]);
    expect(selectUpdateTarget("pinned", [1, 2, 2], [1, 2, 2])).toBeUndefined();
    // A newer PATH or local build is never downgraded.
    expect(selectUpdateTarget("pinned", [1, 3, 0], [1, 2, 2])).toBeUndefined();
    // What GitHub calls latest is ignored in pinned mode.
    expect(selectUpdateTarget("pinned", [1, 2, 2], [1, 2, 2], [1, 4, 0])).toBeUndefined();
  });

  test("latest: offers the newer of pin and latest release", () => {
    expect(selectUpdateTarget("latest", [1, 2, 2], [1, 2, 2], [1, 4, 0])).toEqual([1, 4, 0]);
    expect(selectUpdateTarget("latest", [1, 0, 0], [1, 2, 2], [1, 1, 0])).toEqual([1, 2, 2]);
    expect(selectUpdateTarget("latest", [1, 0, 0], [1, 2, 2], undefined)).toEqual([1, 2, 2]);
    expect(selectUpdateTarget("latest", [1, 5, 0], [1, 2, 2], [1, 4, 0])).toBeUndefined();
  });
});

describe("parseSha256Sums", () => {
  test("reads sha256sum output: text and binary mode, CRLF, comments", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const text = [
      "# engine v1.3.0",
      `${a}  pypilot-linux-x64.tar.gz`,
      `${b} *pypilot-windows-x64.zip`,
      "",
      "not a line",
      `${"c".repeat(63)}  short.tar.gz`,
    ].join("\r\n");
    const sums = parseSha256Sums(text);
    expect(sums.get("pypilot-linux-x64.tar.gz")).toBe(a);
    expect(sums.get("pypilot-windows-x64.zip")).toBe("b".repeat(64));
    expect(sums.has("short.tar.gz")).toBe(false);
    expect(sums.size).toBe(2);
  });

  test("accepts ./-prefixed names", () => {
    const sums = parseSha256Sums(`${"d".repeat(64)}  ./pypilot-darwin-x64.tar.gz\n`);
    expect(sums.get("pypilot-darwin-x64.tar.gz")).toBe("d".repeat(64));
  });
});

describe("hash verification", () => {
  const content = Buffer.from("fake engine archive\n");
  const good = createHash("sha256").update(content).digest("hex");

  test("sha256File matches node:crypto", async () => {
    const file = join(tmp, "a.bin");
    writeFileSync(file, content);
    expect(await sha256File(file)).toBe(good);
  });

  test("a matching archive is kept (expected hash is case-insensitive)", async () => {
    const file = join(tmp, "ok.tar.gz");
    writeFileSync(file, content);
    await verifySha256(file, "ok.tar.gz", good.toUpperCase());
    expect(existsSync(file)).toBe(true);
  });

  test("a mismatching archive is deleted and refused", async () => {
    const file = join(tmp, "bad.tar.gz");
    writeFileSync(file, content);
    const err = await verifySha256(file, "bad.tar.gz", "0".repeat(64)).catch((e) => e);
    expect(err).toBeInstanceOf(ChecksumMismatchError);
    expect(err.message).toContain("nothing was installed");
    expect(err.actual).toBe(good);
    expect(existsSync(file)).toBe(false);
  });
});
