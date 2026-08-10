// Real tooltips replacing the browser's native `title` popups: any element
// with a `data-tip` attribute gets a styled tooltip after a short hover
// delay. One global layer listens on the document, so components only set
// the attribute — no per-site wiring, and (unlike `title`) the text updates
// live while shown (jack telemetry changes every frame).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY_MS = 350;
/** While visible, re-read the anchor's data-tip so live values stay fresh. */
const REFRESH_MS = 100;

interface Tip {
  anchor: HTMLElement;
  text: string;
  x: number;
  y: number;
}

function placeFor(anchor: HTMLElement): { x: number; y: number } {
  const r = anchor.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom + 6 };
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      setTip(null);
    };

    const onOver = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      if (anchor === current) return;
      if (timer) clearTimeout(timer);
      timer = null;
      current = anchor;
      setTip(null);
      if (!anchor) return;
      timer = setTimeout(() => {
        const text = anchor.getAttribute('data-tip');
        if (text) setTip({ anchor, text, ...placeFor(anchor) });
      }, SHOW_DELAY_MS);
    };

    // Hide on any interaction: the tooltip should never sit over a menu or
    // linger through a drag.
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousedown', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousedown', clear, true);
      window.removeEventListener('blur', clear);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!tip) return;
    const id = setInterval(() => {
      if (!tip.anchor.isConnected) {
        setTip(null);
        return;
      }
      const text = tip.anchor.getAttribute('data-tip');
      if (!text) setTip(null);
      else if (text !== tip.text) setTip({ ...tip, text, ...placeFor(tip.anchor) });
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      className="tooltip"
      role="tooltip"
      data-testid="tooltip"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
