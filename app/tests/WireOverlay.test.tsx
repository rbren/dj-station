// WireOverlay: anchors wires on the jack socket indicators, draws straight
// lines with the selected color, and re-measures when the DOM shifts
// (e.g. a deck panel growing after async content loads).

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WIRE_COLORS, WireOverlay } from '../src/components/WireOverlay';

const WIRE = {
  from_instance: 'osc1',
  from_jack: 'audio',
  to_instance: 'vca1',
  to_jack: 'in',
};
const KEY = 'osc1:audio->vca1:in';

function fakeRect(x: number, y: number, size = 18): DOMRect {
  return {
    left: x,
    top: y,
    width: size,
    height: size,
    right: x + size,
    bottom: y + size,
    x,
    y,
    toJSON: () => ({}),
  } as DOMRect;
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);
  container.getBoundingClientRect = () => fakeRect(0, 0, 800);
});

function addSocket(jack: string, x: number, y: number) {
  const el = document.createElement('span');
  el.setAttribute('data-jack', jack);
  el.getBoundingClientRect = () => fakeRect(x, y);
  container.appendChild(el);
  return el;
}

describe('WireOverlay', () => {
  it('draws a straight line between the socket indicator centers', async () => {
    addSocket('osc1:output:audio', 100, 20);
    addSocket('vca1:input:in', 300, 200);
    const { getByTestId } = render(<WireOverlay wires={[WIRE]} container={container} />);
    await waitFor(() => expect(getByTestId(`cable-${KEY}`)).toBeTruthy());
    const line = getByTestId(`cable-${KEY}`);
    expect(line.tagName.toLowerCase()).toBe('line');
    expect(line.getAttribute('x1')).toBe('109'); // 100 + 18/2
    expect(line.getAttribute('y1')).toBe('29');
    expect(line.getAttribute('x2')).toBe('309');
    expect(line.getAttribute('y2')).toBe('209');
  });

  it('uses the stored color index for each wire, defaulting to color 0', async () => {
    addSocket('osc1:output:audio', 0, 0);
    addSocket('vca1:input:in', 50, 50);
    const { getByTestId, rerender } = render(<WireOverlay wires={[WIRE]} container={container} />);
    await waitFor(() => expect(getByTestId(`cable-${KEY}`).style.stroke).toBe(WIRE_COLORS[0]));
    rerender(<WireOverlay wires={[WIRE]} container={container} colors={{ [KEY]: 3 }} />);
    await waitFor(() => expect(getByTestId(`cable-${KEY}`).style.stroke).toBe(WIRE_COLORS[3]));
  });

  it('re-measures when the DOM mutates (async panel growth)', async () => {
    const src = addSocket('osc1:output:audio', 100, 20);
    addSocket('vca1:input:in', 300, 200);
    const { getByTestId } = render(<WireOverlay wires={[WIRE]} container={container} />);
    await waitFor(() => expect(getByTestId(`cable-${KEY}`).getAttribute('y1')).toBe('29'));
    // The source jack shifts down 100px (as if content above it loaded in),
    // and some unrelated DOM mutation happens in the container.
    src.getBoundingClientRect = () => fakeRect(100, 120);
    container.appendChild(document.createElement('div'));
    await waitFor(() => expect(getByTestId(`cable-${KEY}`).getAttribute('y1')).toBe('129'));
  });
});
