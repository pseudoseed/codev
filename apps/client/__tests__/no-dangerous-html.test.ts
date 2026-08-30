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
/**
 * A page holding N machines' credentials must not narrate. Browser consoles are
 * read over shoulders, captured by extensions, and pasted into bug reports, and
 * the natural thing to log while debugging a connection is the request that
 * failed — which carries the credential in a header. Cheaper to forbid the
 * mechanism than to review each call for what it happens to include.
 */
describe('the client never writes to the console', () => {
  it('has no console call anywhere in the app', () => {
    const offenders = walk(SRC)
      .filter((file) => /console\s*\.\s*(log|info|warn|error|debug|trace|dir|table)/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('never puts a credential into a message a human will read', () => {
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      // The credential reaches exactly one place: a request header.
      for (const line of source.split('\n')) {
        if (!line.includes('config.credential')) continue;
        expect(line, `${file}: credential outside a header`)
          .toContain('MACHINE_CREDENTIAL_HEADER');
      }
    }
  });
});

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
