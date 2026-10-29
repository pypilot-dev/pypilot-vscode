import { describe, expect, test } from "bun:test";

import { buildHtml } from "../src/webview/reportPanel";

/** The CSP meta tag as directive → sources. */
function csp(html: string): Map<string, string[]> {
  const content = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  if (!content) throw new Error("no CSP meta tag");
  const directives = new Map<string, string[]>();
  for (const directive of content.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

describe("report panel HTML", () => {
  const md = "# Report\n\n### Error: bad <script>alert(1)</script>\n\nDetail with `code`.\n";

  test("scripts are allowed by nonce only, never unsafe-inline", () => {
    const html = buildHtml(md, { mode: "panel" });
    const policy = csp(html);
    expect(policy.get("default-src")).toEqual(["'none'"]);
    const scriptSrc = policy.get("script-src") ?? [];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toHaveLength(1);
    const nonce = scriptSrc[0].match(/^'nonce-([A-Za-z0-9+/=]+)'$/)?.[1];
    expect(nonce?.length ?? 0).toBeGreaterThanOrEqual(16);

    // Every script element carries that nonce, and there are no inline
    // event handlers (the CSP would block them, breaking the buttons).
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) expect(attrs).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test("a new nonce on every render", () => {
    const nonces = new Set(Array.from({ length: 5 }, () => csp(buildHtml(md, { mode: "panel" })).get("script-src")?.[0]));
    expect(nonces.size).toBe(5);
  });

  test("the exported page has no scripts and no script-src", () => {
    const html = buildHtml(md, { mode: "export" });
    expect(csp(html).has("script-src")).toBe(false);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test("report content is escaped", () => {
    const html = buildHtml(md, { mode: "panel" });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });
});
