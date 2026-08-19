// Cmd+M module picker modal: lists every instantiable module type as a
// zoomed-out rendered panel, filterable by category and search; click or
// drag entries onto the canvas.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MODULE_DRAG_TYPE,
  ModulePicker,
  nextInstanceId,
  PICKER_SCALE,
} from '../src/components/ModulePicker';
import type { Manifest } from '../src/types';

const MODULES: Manifest[] = [
  {
    id: 'builtin.audio_out',
    name: 'Audio Output',
    version: '0.1.0',
    abi: 'native',
    category: 'Analysis & I/O',
    inputs: [{ id: 'ch1', name: 'Ch 1' }],
    outputs: [],
    params: [],
  },
  {
    id: 'com.dj.oscillator',
    name: 'Oscillator',
    version: '0.1.0',
    abi: 'wasm-1',
    category: 'Sources',
    inputs: [
      {
        id: 'pitch',
        name: 'Pitch',
        default: 4,
        knob: { style: 'continuous', min: 0, max: 10, curve: 'linear' },
      },
    ],
    outputs: [{ id: 'audio', name: 'Audio' }],
    params: [],
  },
  {
    id: 'com.dj.filter',
    name: 'Multimode Filter',
    version: '0.1.0',
    abi: 'wasm-1',
    category: 'Shaping',
    inputs: [{ id: 'in', name: 'In' }],
    outputs: [{ id: 'out', name: 'Out' }],
    params: [],
  },
];

function renderPicker(onAdd = vi.fn(), onClose = vi.fn()) {
  render(<ModulePicker modules={MODULES} onAdd={onAdd} onClose={onClose} />);
  return { onAdd, onClose };
}

describe('ModulePicker', () => {
  it('lists every module type as a zoomed-out rendered panel', () => {
    renderPicker();
    // Name appears in both the caption and the preview panel's own header.
    expect(screen.getAllByText('Audio Output').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Oscillator').length).toBeGreaterThanOrEqual(2);
    // The preview is the real ModulePanel, scaled down.
    const panel = screen.getByTestId('module-preview-com.dj.oscillator');
    expect(panel).toBeTruthy();
    const wrapper = panel.closest('.picker-preview-panel') as HTMLElement;
    expect(wrapper.style.transform).toBe(`scale(${PICKER_SCALE})`);
    // Preview knobs sit at the input's manifest default (4/10 linear).
    expect(screen.getByTestId('knob-pitch')).toBeTruthy();
  });

  it('previews render the module custom UI against an inert handle', () => {
    const lfo: Manifest = {
      id: 'com.dj.lfo',
      name: 'LFO',
      version: '0.1.0',
      abi: 'wasm-1',
      category: 'Modulation',
      inputs: [
        {
          id: 'rate',
          name: 'Rate',
          default: 2,
          knob: { style: 'continuous', min: 0.01, max: 2000, curve: 'exp' },
        },
      ],
      outputs: [{ id: 'bi', name: 'Bipolar' }],
      params: [],
    };
    render(<ModulePicker modules={[lfo]} onAdd={vi.fn()} onClose={vi.fn()} />);
    // The LFO's shape preview (its recognizable face) is in the preview.
    expect(screen.getByTestId('lfo-ui')).toBeTruthy();
  });

  it('preview-unsafe custom UIs (camera, deck) fall back to the bare panel', () => {
    const camera: Manifest = {
      id: 'com.dj.camera',
      name: 'Camera',
      version: '0.1.0',
      abi: 'wasm-1',
      category: 'Analysis & I/O',
      inputs: [{ id: 'in', name: 'In' }],
      outputs: [{ id: 'thru', name: 'Thru' }],
      params: [],
    };
    render(<ModulePicker modules={[camera]} onAdd={vi.fn()} onClose={vi.fn()} />);
    // No getUserMedia grab from a gallery preview: the custom UI is absent.
    expect(screen.queryByTestId('camera-ui')).toBeNull();
    expect(screen.getByTestId('module-preview-com.dj.camera')).toBeTruthy();
  });

  it('clicking an entry requests that module type', () => {
    const { onAdd } = renderPicker();
    fireEvent.click(screen.getByTestId('library-add-com.dj.oscillator'));
    expect(onAdd).toHaveBeenCalledWith('com.dj.oscillator');
  });

  it('entries are draggable and export the module type', () => {
    renderPicker();
    const entry = screen.getByTestId('library-add-com.dj.oscillator');
    expect(entry.getAttribute('draggable')).toBe('true');
    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, v: string) {
        this.data[type] = v;
      },
      effectAllowed: '',
    };
    fireEvent.dragStart(entry, { dataTransfer });
    expect(dataTransfer.data[MODULE_DRAG_TYPE]).toBe('com.dj.oscillator');
    // While dragging, the modal hides itself so the rack can take the drop.
    expect(screen.getByTestId('module-picker').className).toContain('module-picker-dragging');
    fireEvent.dragEnd(entry);
    expect(screen.getByTestId('module-picker').className).not.toContain('module-picker-dragging');
  });

  it('groups entries under category headings in display order', () => {
    renderPicker();
    const headings = [...document.querySelectorAll('.picker-group-title')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(['Sources', 'Shaping', 'Analysis & I/O']);
  });

  it('the category filter narrows the gallery (click again to clear)', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('picker-category-Sources'));
    expect(screen.getByTestId('library-add-com.dj.oscillator')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.filter')).toBeNull();
    fireEvent.click(screen.getByTestId('picker-category-Sources'));
    expect(screen.getByTestId('library-add-com.dj.filter')).toBeTruthy();
    fireEvent.click(screen.getByTestId('picker-category-Shaping'));
    fireEvent.click(screen.getByTestId('picker-category-all'));
    expect(screen.getByTestId('library-add-com.dj.oscillator')).toBeTruthy();
  });

  it('search filters by name, id and category', () => {
    renderPicker();
    const search = screen.getByTestId('library-search');
    fireEvent.change(search, { target: { value: 'filt' } });
    expect(screen.getByTestId('library-add-com.dj.filter')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.oscillator')).toBeNull();

    fireEvent.change(search, { target: { value: 'sources' } });
    expect(screen.getByTestId('library-add-com.dj.oscillator')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.filter')).toBeNull();

    fireEvent.change(search, { target: { value: 'nope' } });
    expect(screen.getByTestId('library-no-results')).toBeTruthy();
  });

  it('Escape, the ✕ button and a backdrop click all close the picker', () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('module-picker-close'));
    fireEvent.click(screen.getByTestId('module-picker'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('clicks inside the dialog do not close it', () => {
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByTestId('library-search'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('nextInstanceId', () => {
  it('derives a short prefix from the type id and counts up', () => {
    expect(nextInstanceId('com.dj.oscillator', new Set())).toBe('oscillat1');
    expect(nextInstanceId('com.dj.oscillator', new Set(['oscillat1']))).toBe('oscillat2');
    expect(nextInstanceId('builtin.audio_out', new Set())).toBe('audioout1');
  });
});
