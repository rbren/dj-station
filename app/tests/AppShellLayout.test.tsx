import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom doesn't do layout, so pin the stylesheet directly (the
// WireOverlay stacking pin's pattern). The shell contract: the PAGE never
// scrolls — the header stays pinned and the infinite canvas pans/zooms
// inside its clipped .rack-area. The .rack's min-width/min-height would
// otherwise leak through .rack-area's layout box, grow the body past the
// viewport, and let the user scroll the header away.
describe('app shell layout (CSS-level pin)', () => {
  // vitest runs with app/ (the vite root) as cwd. `rule` joins the bodies
  // of EVERY rule whose selector list contains the exact selector (the
  // shell declarations are split across a grouped height rule and the
  // standalone ones).
  const css = readFileSync('src/styles.css', 'utf-8');
  const rule = (selector: string): string => {
    const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => m[1].split(',').some((s) => s.trim().split('\n').pop()?.trim() === selector))
      .map((m) => m[2]);
    expect(bodies.length, `rule for ${selector}`).toBeGreaterThan(0);
    return bodies.join(';');
  };

  it('pins the shell to the viewport with a 100% height chain', () => {
    // 100% chain, not 100vh: the webview's visual viewport can differ.
    for (const sel of ['html', 'body', '#root', '.app']) {
      expect(rule(sel), `${sel} height`).toMatch(/height:\s*100%/);
    }
    expect(rule('body')).toMatch(/overflow:\s*hidden/);
    expect(rule('.app')).toMatch(/flex-direction:\s*column/);
  });

  it('lets the canvas row shrink instead of inflating the page', () => {
    expect(rule('.app-body')).toMatch(/min-height:\s*0/);
    const rackArea = rule('.rack-area');
    expect(rackArea).toMatch(/overflow:\s*hidden/);
    expect(rackArea).toMatch(/min-height:\s*0/);
    // The old bug: a viewport-relative min-height double-counted the header.
    expect(rackArea).not.toMatch(/100vh/);
  });

  it('inner panels keep their own scrolling', () => {
    expect(rule('.library')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.clip-view')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.docs-body')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.picker-body')).toMatch(/overflow-y:\s*auto/);
    // The Decks bank scrolls its own row of strips; the page must not.
    expect(rule('.decks-view')).toMatch(/min-height:\s*0/);
    expect(rule('.decks-strips')).toMatch(/overflow:\s*auto/);
  });
});
