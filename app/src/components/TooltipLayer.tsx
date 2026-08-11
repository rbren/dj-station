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
    // While a drag started on the anchor is in flight, the tooltip stays
    // pinned (knob drags show the live value); hover retargeting resumes
    // on mouseup.
    let dragging = false;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      dragging = false;
      setTip(null);
    };

    const retarget = (target: HTMLElement | null) => {
      const anchor = target?.closest?.('[data-tip]') as HTMLElement | null;
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

    const onOver = (e: MouseEvent) => {
      if (dragging) return;
      retarget(e.target as HTMLElement);
    };

    // A mousedown ON the tooltip's anchor starts a drag: keep the tooltip
    // alive so live values (knob drags) stay visible. Mousedowns anywhere
    // else still dismiss it — it should never sit over a menu.
    const onDown = (e: MouseEvent) => {
      if (current && current.contains(e.target as Node)) {
        dragging = true;
        return;
      }
      clear();
    };

    // Drag over: hide if the pointer ended up off the anchor (or retarget
    // to whatever anchor it landed on).
    const onUp = (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      retarget(e.target as HTMLElement);
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mouseup', onUp);
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
