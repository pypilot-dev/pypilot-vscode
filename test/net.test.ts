import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpStatusError, downloadFile, fetchText, isLoopback, proxyFromEnv } from "../src/net";

describe("proxyFromEnv", () => {
  const gh = new URL("https://github.com/pypilot-dev/pypilot/releases");

  test("uses HTTPS_PROXY (either case), then HTTP_PROXY, for https targets", () => {
    expect(proxyFromEnv(gh, { HTTPS_PROXY: "http://proxy:3128" })?.host).toBe("proxy:3128");
    expect(proxyFromEnv(gh, { https_proxy: "proxy.corp:8080" })?.href).toBe("http://proxy.corp:8080/");
    expect(proxyFromEnv(gh, { HTTP_PROXY: "http://p:1" })?.host).toBe("p:1");
    expect(proxyFromEnv(gh, {})).toBeUndefined();
  });

  test("NO_PROXY: wildcard, domains with subdomains, leading dots and ports", () => {
    const env = { HTTPS_PROXY: "http://proxy:3128" };
    expect(proxyFromEnv(gh, { ...env, NO_PROXY: "*" })).toBeUndefined();
    expect(proxyFromEnv(gh, { ...env, NO_PROXY: "example.com, github.com" })).toBeUndefined();
    expect(proxyFromEnv(new URL("https://api.github.com/x"), { ...env, no_proxy: ".github.com" })).toBeUndefined();
    expect(proxyFromEnv(gh, { ...env, NO_PROXY: "github.com:8443" })?.host).toBe("proxy:3128");
    expect(proxyFromEnv(gh, { ...env, NO_PROXY: "github.com:443" })).toBeUndefined();
    expect(proxyFromEnv(gh, { ...env, NO_PROXY: "notgithub.com" })?.host).toBe("proxy:3128");
  });

  test("loopback is always direct", () => {
    expect(proxyFromEnv(new URL("http://127.0.0.1:8080/x"), { HTTP_PROXY: "http://p:1" })).toBeUndefined();
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });
});

describe("requests against a local server", () => {
  let server: Server;
  let base: string;
  const dir = mkdtempSync(join(tmpdir(), "pypilot-net-test-"));

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/file") {
        res.end("archive-bytes");
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/file" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { Location: "/loop" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("not found page");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("follows redirects", async () => {
    expect(await fetchText(`${base}/redirect`)).toBe("archive-bytes");
    const dest = join(dir, "a");
    await downloadFile(`${base}/redirect`, dest);
    expect(readFileSync(dest, "utf8")).toBe("archive-bytes");
  });

  test("a 404 is an HttpStatusError and leaves no file behind", async () => {
    const err = await fetchText(`${base}/missing`).catch((e) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.status).toBe(404);
    const dest = join(dir, "b");
    await expect(downloadFile(`${base}/missing`, dest)).rejects.toBeInstanceOf(HttpStatusError);
    expect(existsSync(dest)).toBe(false);
  });

  test("gives up on redirect loops", async () => {
    await expect(fetchText(`${base}/loop`)).rejects.toThrow(/Too many redirects/);
  });

  test("refuses plain http to non-loopback hosts", async () => {
    await expect(fetchText("http://example.com/x")).rejects.toThrow(/only https/);
    const dest = join(dir, "c");
    await expect(downloadFile("http://example.com/x", dest)).rejects.toThrow(/only https/);
    expect(existsSync(dest)).toBe(false);
  });
});
