// Left-hand module library: lists every instantiable module type and adds
// instances with generated ids.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModuleLibrary, nextInstanceId } from '../src/components/ModuleLibrary';
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
    inputs: [{ id: 'pitch', name: 'Pitch' }],
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

describe('ModuleLibrary', () => {
  it('lists every module type with its io summary', () => {
    render(<ModuleLibrary modules={MODULES} onAdd={() => {}} />);
    expect(screen.getByText('Audio Output')).toBeTruthy();
    expect(screen.getByText('Oscillator')).toBeTruthy();
    expect(screen.getByText('1 in · 0 out')).toBeTruthy();
    expect(screen.getAllByText('1 in · 1 out')).toHaveLength(2);
  });

  it('clicking an entry requests that module type', () => {
    const onAdd = vi.fn();
    render(<ModuleLibrary modules={MODULES} onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('library-add-com.dj.oscillator'));
    expect(onAdd).toHaveBeenCalledWith('com.dj.oscillator');
  });

  it('groups entries under category headings in display order', () => {
    render(<ModuleLibrary modules={MODULES} onAdd={() => {}} />);
    const headings = screen
      .getAllByRole('button', { expanded: true })
      .map((b) => b.textContent ?? '');
    expect(headings[0]).toContain('Sources');
    expect(headings[1]).toContain('Shaping');
    expect(headings[2]).toContain('Analysis & I/O');
  });

  it('collapsing a category hides its entries', () => {
    render(<ModuleLibrary modules={MODULES} onAdd={() => {}} />);
    fireEvent.click(screen.getByTestId('library-category-Sources'));
    expect(screen.queryByTestId('library-add-com.dj.oscillator')).toBeNull();
    expect(screen.getByTestId('library-add-com.dj.filter')).toBeTruthy();
  });

  it('search filters by name, id and category', () => {
    render(<ModuleLibrary modules={MODULES} onAdd={() => {}} />);
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

  it('search reveals matches inside collapsed categories', () => {
    render(<ModuleLibrary modules={MODULES} onAdd={() => {}} />);
    fireEvent.click(screen.getByTestId('library-category-Sources'));
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'osc' } });
    expect(screen.getByTestId('library-add-com.dj.oscillator')).toBeTruthy();
  });
});

describe('nextInstanceId', () => {
  it('derives a short prefix from the type id and counts up', () => {
    expect(nextInstanceId('com.dj.oscillator', new Set())).toBe('oscillat1');
    expect(nextInstanceId('com.dj.oscillator', new Set(['oscillat1']))).toBe('oscillat2');
    expect(nextInstanceId('builtin.audio_out', new Set())).toBe('audioout1');
  });
});
