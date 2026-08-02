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
    inputs: [{ id: 'ch1', name: 'Ch 1' }],
    outputs: [],
    params: [],
  },
  {
    id: 'com.dj.oscillator',
    name: 'Oscillator',
    version: '0.1.0',
    abi: 'wasm-1',
    inputs: [{ id: 'pitch', name: 'Pitch' }],
    outputs: [{ id: 'audio', name: 'Audio' }],
    params: [],
  },
];

describe('ModuleLibrary', () => {
  it('lists every module type with its io summary', () => {
    render(<ModuleLibrary modules={MODULES} onAdd={() => {}} />);
    expect(screen.getByText('Audio Output')).toBeTruthy();
    expect(screen.getByText('Oscillator')).toBeTruthy();
    expect(screen.getByText('1 in · 1 out')).toBeTruthy();
  });

  it('clicking an entry requests that module type', () => {
    const onAdd = vi.fn();
    render(<ModuleLibrary modules={MODULES} onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('library-add-com.dj.oscillator'));
    expect(onAdd).toHaveBeenCalledWith('com.dj.oscillator');
  });
});

describe('nextInstanceId', () => {
  it('derives a short prefix from the type id and counts up', () => {
    expect(nextInstanceId('com.dj.oscillator', new Set())).toBe('oscillat1');
    expect(nextInstanceId('com.dj.oscillator', new Set(['oscillat1']))).toBe('oscillat2');
    expect(nextInstanceId('builtin.audio_out', new Set())).toBe('audioout1');
  });
});
