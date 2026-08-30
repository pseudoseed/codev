// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * The client holds credentials for N servers, so an XSS here is credential
 * theft rather than defacement. Agent output is text, and React escapes text.
 */
describe('agent output is never injected as markup', () => {
  it('has no dangerouslySetInnerHTML anywhere in the app', () => {
    const offenders = walk(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(offenders).toEqual([]);
  });

  it('declares a restrictive CSP with no unsafe-inline script source', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self';");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("connect-src 'self'");
    // Script execution is the credential-theft path. Styles are not, and a
    // build tool that injects a <style> tag must not be the reason someone
    // later loosens script-src instead.
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
    expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(html).not.toContain('unsafe-eval');
    expect(html).not.toContain('connect-src *');
  });

  it('does not pretend a meta tag can set frame-ancestors', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const meta = /content="([^"]*)"/.exec(html.slice(html.indexOf('Content-Security-Policy')))?.[1] ?? '';
    expect(meta).not.toContain('frame-ancestors');
    const config = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
    expect(config).toContain("frame-ancestors 'none'");
  });
});
