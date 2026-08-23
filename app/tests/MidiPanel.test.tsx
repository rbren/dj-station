// MIDI mapping editor: notes/CCs only become output jacks once explicitly
// mapped, mappings are removable, and note mappings can be bound to
// computer-keyboard keys (keydown = note on, keyup = note off).

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MidiPanel, noteName } from '../src/components/MidiPanel';
import { RackKeysContext } from '../src/keyScope';

const noop = () => {};

beforeEach(() => {
  localStorage.clear();
});

describe('noteName', () => {
  it('follows the MIDI convention (60 = C4)', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(0)).toBe('C-1');
  });
});

describe('MidiPanel', () => {
  it('shows no mapped jacks until a control is added', () => {
    render(<MidiPanel instance="midi1" mappings={[]} onAdd={noop} onRemove={noop} onMidi={noop} />);
    expect(screen.getByText(/No controls mapped/)).toBeTruthy();
  });

  it('adds a note mapping for the selected note number', () => {
    const onAdd = vi.fn();
    render(
      <MidiPanel instance="midi1" mappings={[]} onAdd={onAdd} onRemove={noop} onMidi={noop} />,
    );
    fireEvent.change(screen.getByTestId('midi-add-num'), { target: { value: '64' } });
    fireEvent.click(screen.getByTestId('midi-add'));
    expect(onAdd).toHaveBeenCalledWith('note', 64, 'E4');
  });

  it('adds a cc mapping and dodges duplicate names', () => {
    const onAdd = vi.fn();
    render(
      <MidiPanel
        instance="midi1"
        mappings={[{ name: 'cc7', kind: 'cc', num: 7 }]}
        onAdd={onAdd}
        onRemove={noop}
        onMidi={noop}
      />,
    );
    fireEvent.change(screen.getByTestId('midi-add-kind'), { target: { value: 'cc' } });
    fireEvent.change(screen.getByTestId('midi-add-num'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('midi-add'));
    expect(onAdd).toHaveBeenCalledWith('cc', 7, 'cc7_2');
  });

  it('removes a mapping', () => {
    const onRemove = vi.fn();
    render(
      <MidiPanel
        instance="midi1"
        mappings={[{ name: 'C4', kind: 'note', num: 60 }]}
        onAdd={noop}
        onRemove={onRemove}
        onMidi={noop}
      />,
    );
    fireEvent.click(screen.getByTestId('midi-remove-C4'));
    expect(onRemove).toHaveBeenCalledWith('C4');
  });

  it('binds a keyboard key and plays note on/off while held', () => {
    const onMidi = vi.fn();
    render(
      <MidiPanel
        instance="midi1"
        mappings={[{ name: 'C4', kind: 'note', num: 60 }]}
        onAdd={noop}
        onRemove={noop}
        onMidi={onMidi}
      />,
    );
    // capture a key binding
    fireEvent.click(screen.getByTestId('midi-key-C4'));
    expect(screen.getByTestId('midi-key-C4').textContent).toContain('press a key');
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByTestId('midi-key-C4').textContent).toBe('a');
    expect(onMidi).not.toHaveBeenCalled();

    // held key sends note on exactly once (key repeat suppressed)
    fireEvent.keyDown(window, { key: 'a' });
    expect(onMidi).toHaveBeenLastCalledWith([0x90, 60, 100]);
    fireEvent.keyDown(window, { key: 'a', repeat: true });
    expect(onMidi).toHaveBeenCalledTimes(1);

    // release sends note off
    fireEvent.keyUp(window, { key: 'a' });
    expect(onMidi).toHaveBeenLastCalledWith([0x80, 60, 0]);
    expect(onMidi).toHaveBeenCalledTimes(2);

    // unbound keys do nothing
    fireEvent.keyDown(window, { key: 'z' });
    expect(onMidi).toHaveBeenCalledTimes(2);
  });

  it('key bindings go quiet off the rack page, sending note-off for held keys', () => {
    const onMidi = vi.fn();
    localStorage.setItem('dj-midi-keys:midi1', JSON.stringify({ C4: 'a' }));
    const at = (active: boolean) => (
      <RackKeysContext.Provider value={active}>
        <MidiPanel
          instance="midi1"
          mappings={[{ name: 'C4', kind: 'note', num: 60 }]}
          onAdd={noop}
          onRemove={noop}
          onMidi={onMidi}
        />
      </RackKeysContext.Provider>
    );
    const { rerender } = render(at(true));
    fireEvent.keyDown(window, { key: 'a' });
    expect(onMidi).toHaveBeenLastCalledWith([0x90, 60, 100]);

    // Leaving the rack page releases the held note; keys pressed on other
    // pages play nothing.
    rerender(at(false));
    expect(onMidi).toHaveBeenLastCalledWith([0x80, 60, 0]);
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyUp(window, { key: 'a' });
    expect(onMidi).toHaveBeenCalledTimes(2);

    // Back on the rack the binding plays again.
    rerender(at(true));
    fireEvent.keyDown(window, { key: 'a' });
    expect(onMidi).toHaveBeenLastCalledWith([0x90, 60, 100]);
    expect(onMidi).toHaveBeenCalledTimes(3);
  });

  it('persists key bindings per instance in localStorage', () => {
    const mappings = [{ name: 'C4', kind: 'note', num: 60 }];
    const { unmount } = render(
      <MidiPanel instance="midi1" mappings={mappings} onAdd={noop} onRemove={noop} onMidi={noop} />,
    );
    fireEvent.click(screen.getByTestId('midi-key-C4'));
    fireEvent.keyDown(window, { key: 'q' });
    unmount();
    render(
      <MidiPanel instance="midi1" mappings={mappings} onAdd={noop} onRemove={noop} onMidi={noop} />,
    );
    expect(screen.getByTestId('midi-key-C4').textContent).toBe('q');
  });

  it('adds an LED feedback mapping with a led_-prefixed name (M4)', () => {
    const onAddLed = vi.fn();
    render(
      <MidiPanel
        instance="midi1"
        mappings={[]}
        ledMappings={[]}
        onAdd={noop}
        onRemove={noop}
        onAddLed={onAddLed}
        onRemoveLed={noop}
        onMidi={noop}
      />,
    );
    fireEvent.change(screen.getByTestId('midi-add-kind'), { target: { value: 'cc' } });
    fireEvent.change(screen.getByTestId('midi-add-num'), { target: { value: '16' } });
    fireEvent.click(screen.getByTestId('midi-add-led'));
    expect(onAddLed).toHaveBeenCalledWith('cc', 16, 'led_cc16');
  });

  it('lists and removes LED mappings (M4)', () => {
    const onRemoveLed = vi.fn();
    render(
      <MidiPanel
        instance="midi1"
        mappings={[]}
        ledMappings={[{ name: 'led_cc16', kind: 'cc', num: 16 }]}
        onAdd={noop}
        onRemove={noop}
        onAddLed={noop}
        onRemoveLed={onRemoveLed}
        onMidi={noop}
      />,
    );
    expect(screen.getByTestId('midi-led-led_cc16')).toBeTruthy();
    fireEvent.click(screen.getByTestId('midi-led-remove-led_cc16'));
    expect(onRemoveLed).toHaveBeenCalledWith('led_cc16');
  });

  it('hides the LED button without an onAddLed handler', () => {
    render(<MidiPanel instance="midi1" mappings={[]} onAdd={noop} onRemove={noop} onMidi={noop} />);
    expect(screen.queryByTestId('midi-add-led')).toBeNull();
  });
});
