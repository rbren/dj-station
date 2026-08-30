// Cmd+M module picker modal: lists every instantiable module type as a
// zoomed-out rendered panel, filterable by category and search; click or
// drag entries onto the canvas.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODULE_DRAG_TYPE,
  ModulePicker,
  nextInstanceId,
  PICKER_SCALE,
} from '../src/components/ModulePicker';
import { BEAT_CLIP_TYPE, type BeatClipEntry } from '../src/beatClip';
import type { MacroPreviewNode } from '../src/engine';
import type { Manifest } from '../src/types';

const macroPreview = vi.fn(async (_id: string): Promise<MacroPreviewNode[] | null> => null);
vi.mock('../src/engine', () => ({
  engine: { macroPreview: (id: string) => macroPreview(id) },
  onMenuAction: () => () => {},
}));

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

// The open tab persists across mounts, so each case starts from clean
// storage rather than whichever tab the previous one left open.
beforeEach(() => localStorage.clear());

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

  it('macro entries render a composite preview of their internal panels', async () => {
    const macro: Manifest = {
      id: 'macro.tone',
      name: 'Tone',
      version: '1',
      abi: 'macro-1',
      category: 'Macros',
      inputs: [{ id: 'pitch', name: 'pitch' }],
      outputs: [{ id: 'out', name: 'out' }],
      params: [],
    };
    macroPreview.mockResolvedValueOnce([
      {
        id: 'osc1',
        ext: 'com.dj.lfo',
        manifest: {
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
        },
        knobs: { rate: { position: 0.5, atten: 1, offset: 0 } },
        position: [0, 0],
      },
      {
        id: 'vca1',
        ext: 'com.dj.vca',
        manifest: {
          id: 'com.dj.vca',
          name: 'VCA',
          version: '0.1.0',
          abi: 'wasm-1',
          category: 'Shaping',
          inputs: [{ id: 'in', name: 'In' }],
          outputs: [{ id: 'out', name: 'Out' }],
          params: [],
        },
        knobs: {},
        position: [180, 20],
      },
    ]);
    render(<ModulePicker modules={[macro]} onAdd={vi.fn()} onClose={vi.fn()} />);
    // The composite replaces the synthesized interface panel: both
    // internal panels render (custom UIs included), laid out by the
    // definition's saved positions.
    await waitFor(() => expect(screen.getByTestId('macro-preview-macro.tone')).toBeTruthy());
    expect(macroPreview).toHaveBeenCalledWith('macro.tone');
    expect(screen.getByTestId('lfo-ui')).toBeTruthy();
    const vca = screen.getByTestId('module-preview-macro.tone/vca1');
    expect(vca.style.left).toBe('180px');
    expect(vca.style.top).toBe('20px');
    expect(screen.queryByTestId('module-preview-macro.tone')).toBeNull();
  });

  it('macro entries fall back to the interface panel when no preview is available', async () => {
    const macro: Manifest = {
      id: 'macro.empty',
      name: 'Empty',
      version: '1',
      abi: 'macro-1',
      category: 'Macros',
      inputs: [{ id: 'in', name: 'in' }],
      outputs: [],
      params: [],
    };
    macroPreview.mockResolvedValueOnce(null); // headless / engine unavailable
    render(<ModulePicker modules={[macro]} onAdd={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(macroPreview).toHaveBeenCalledWith('macro.empty'));
    expect(screen.getByTestId('module-preview-macro.empty')).toBeTruthy();
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

  it('the Deprecated tag only appears when a module carries the flag', () => {
    renderPicker();
    expect(screen.queryByTestId('picker-category-Deprecated')).toBeNull();
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

// A module whose manifest sets `deprecated` is kept for the patches that
// still use it, but stays out of the search everyone else does: only the
// Deprecated tag lists it.
describe('ModulePicker deprecated modules', () => {
  const oldFilter: Manifest = {
    id: 'com.dj.filter_v1',
    name: 'Filter (old)',
    version: '0.1.0',
    abi: 'wasm-1',
    category: 'Shaping',
    deprecated: true,
    inputs: [{ id: 'in', name: 'In' }],
    outputs: [{ id: 'out', name: 'Out' }],
    params: [],
  };
  // The sole module of its category, so its pill has nothing to list.
  const oldReverb: Manifest = {
    ...oldFilter,
    id: 'com.dj.reverb_v1',
    name: 'Reverb (old)',
    category: 'Effects',
  };

  function renderPickerWith(onAdd = vi.fn()) {
    render(
      <ModulePicker modules={[...MODULES, oldFilter, oldReverb]} onAdd={onAdd} onClose={vi.fn()} />,
    );
    return onAdd;
  }

  it('stays out of the default gallery, the search and its own category', () => {
    renderPickerWith();
    expect(screen.getByTestId('library-add-com.dj.filter')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.filter_v1')).toBeNull();

    const search = screen.getByTestId('library-search');
    fireEvent.change(search, { target: { value: 'filter' } });
    expect(screen.getByTestId('library-add-com.dj.filter')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.filter_v1')).toBeNull();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('picker-category-Shaping'));
    expect(screen.queryByTestId('library-add-com.dj.filter_v1')).toBeNull();
  });

  it('a category holding nothing but deprecated modules has no pill', () => {
    renderPickerWith();
    expect(screen.getByTestId('picker-category-Shaping')).toBeTruthy();
    expect(screen.queryByTestId('picker-category-Effects')).toBeNull();
  });

  it('the Deprecated tag lists the retired modules and nothing else', () => {
    const onAdd = renderPickerWith();
    fireEvent.click(screen.getByTestId('picker-category-Deprecated'));
    expect(screen.getByTestId('library-add-com.dj.filter_v1')).toBeTruthy();
    expect(screen.getByTestId('library-add-com.dj.reverb_v1')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.filter')).toBeNull();
    // Grouped under their real categories, and each entry says why it is
    // on screen.
    const headings = [...document.querySelectorAll('.picker-group-title')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(['Shaping', 'Effects']);
    expect(screen.getByTestId('picker-deprecated-com.dj.filter_v1')).toBeTruthy();

    // The search box narrows the tag's listing like any other.
    const search = screen.getByTestId('library-search');
    fireEvent.change(search, { target: { value: 'filter' } });
    expect(screen.getByTestId('library-add-com.dj.filter_v1')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.reverb_v1')).toBeNull();

    // A retired module still instantiates — that is the point of keeping it.
    fireEvent.click(screen.getByTestId('library-add-com.dj.filter_v1'));
    expect(onAdd).toHaveBeenCalledWith('com.dj.filter_v1');

    // Clicking the tag again goes back to the current modules.
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('picker-category-Deprecated'));
    expect(screen.getByTestId('library-add-com.dj.filter')).toBeTruthy();
    expect(screen.queryByTestId('library-add-com.dj.filter_v1')).toBeNull();
  });
});

describe('ModulePicker macro management', () => {
  const macro: Manifest = {
    id: 'macro.tone',
    name: 'Tone Stack',
    version: '3',
    abi: 'macro-1',
    inputs: [],
    outputs: [{ id: 'out', name: 'Out' }],
    params: [],
  };

  function renderWithMacro(overrides: Partial<Parameters<typeof ModulePicker>[0]> = {}) {
    const onAdd = vi.fn();
    const onRenameMacro = vi.fn();
    const onDeleteMacro = vi.fn();
    render(
      <ModulePicker
        modules={[...MODULES, macro]}
        onAdd={onAdd}
        onClose={vi.fn()}
        onRenameMacro={onRenameMacro}
        onDeleteMacro={onDeleteMacro}
        {...overrides}
      />,
    );
    return { onAdd, onRenameMacro, onDeleteMacro };
  }

  /** The full right-button gesture as the Tauri webview delivers it:
   *  unlike Chrome/Firefox (which fire `auxclick` for non-primary
   *  buttons), WebKit follows `contextmenu` with a `click` on the same
   *  target — and React delivers it to onClick like any left click, so
   *  without the gesture guard the entry adds the module. There is no
   *  fresh button-0 mousedown in this stream; that's what distinguishes
   *  it from a real left click. */
  function rightClick(el: HTMLElement) {
    fireEvent.mouseDown(el, { button: 2 });
    fireEvent.contextMenu(el, { clientX: 40, clientY: 50 });
    fireEvent.mouseUp(el, { button: 2 });
    fireEvent.click(el);
  }

  it('right-clicking a macro opens the manage menu and does NOT add it', () => {
    const { onAdd } = renderWithMacro();
    rightClick(screen.getByTestId('library-add-macro.tone'));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId('context-menu')).toBeTruthy();
    expect(screen.getByTestId('picker-macro-rename')).toBeTruthy();
    expect(screen.getByTestId('picker-macro-delete')).toBeTruthy();
  });

  it('left-clicking a macro still adds it, including after a menu gesture', () => {
    const { onAdd } = renderWithMacro();
    const entry = screen.getByTestId('library-add-macro.tone');
    fireEvent.mouseDown(entry, { button: 0 });
    fireEvent.mouseUp(entry, { button: 0 });
    fireEvent.click(entry, { button: 0 });
    expect(onAdd).toHaveBeenCalledWith('macro.tone');

    // A right-click (menu) followed by a fresh left-click: the guard that
    // swallows WebKit's paired click must not eat the next real click.
    onAdd.mockClear();
    rightClick(entry);
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' }); // dismiss the menu
    fireEvent.mouseDown(entry, { button: 0 });
    fireEvent.mouseUp(entry, { button: 0 });
    fireEvent.click(entry, { button: 0 });
    expect(onAdd).toHaveBeenCalledWith('macro.tone');
  });

  it("right-clicking a non-macro entry doesn't add it either", () => {
    const { onAdd } = renderWithMacro();
    rightClick(screen.getByTestId('library-add-com.dj.oscillator'));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('right-click without macro management wired opens no menu and adds nothing', () => {
    const { onAdd } = renderWithMacro({ onRenameMacro: undefined, onDeleteMacro: undefined });
    rightClick(screen.getByTestId('library-add-macro.tone'));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('Rename Macro… prompts for a name and calls onRenameMacro', () => {
    const { onRenameMacro } = renderWithMacro();
    rightClick(screen.getByTestId('library-add-macro.tone'));
    fireEvent.click(screen.getByTestId('picker-macro-rename'));
    const input = screen.getByTestId('macro-rename-input') as HTMLInputElement;
    expect(input.value).toBe('Tone Stack');
    fireEvent.change(input, { target: { value: 'Warm Tone' } });
    fireEvent.click(screen.getByTestId('macro-rename-confirm'));
    expect(onRenameMacro).toHaveBeenCalledWith('macro.tone', 'Warm Tone');
    expect(screen.queryByTestId('macro-rename-dialog')).toBeNull();
  });

  it('Delete Macro… confirms before calling onDeleteMacro', () => {
    const { onDeleteMacro } = renderWithMacro();
    rightClick(screen.getByTestId('library-add-macro.tone'));
    fireEvent.click(screen.getByTestId('picker-macro-delete'));
    expect(onDeleteMacro).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('macro-delete-confirm'));
    expect(onDeleteMacro).toHaveBeenCalledWith('macro.tone');
    expect(screen.queryByTestId('macro-delete-dialog')).toBeNull();
  });
});

describe('ModulePicker clips tab', () => {
  const CLIPS: BeatClipEntry[] = [
    {
      projectId: 'p1',
      projectName: 'Night Bus',
      clipId: '1',
      name: 'intro loop',
      bpm: 128,
      beats: 8,
      stems: ['vocals', 'drums', 'bass', 'other'],
    },
    {
      projectId: 'p2',
      projectName: 'Sunroom',
      clipId: '3',
      name: 'chorus stack',
      bpm: 92.5,
      beats: 4,
      stems: ['drums', 'bass'],
    },
  ];

  const beatClipModule: Manifest = {
    id: BEAT_CLIP_TYPE,
    name: 'Beat Clip',
    version: '0.1.0',
    abi: 'native',
    category: 'Sources',
    inputs: [{ id: 'clock', name: 'Clock' }],
    outputs: [{ id: 'audio_l', name: 'L' }],
    params: [],
  };

  function renderClips(clips: BeatClipEntry[] = CLIPS) {
    const onAdd = vi.fn();
    const onAddClip = vi.fn();
    const view = render(
      <ModulePicker
        modules={[...MODULES, beatClipModule]}
        clips={clips}
        onAdd={onAdd}
        onAddClip={onAddClip}
        onClose={vi.fn()}
      />,
    );
    return { ...view, onAdd, onAddClip };
  }

  it('is a tab of its own, listing every clip with its project and length', () => {
    renderClips();
    // The gallery is module types: clips appear once the tab is picked.
    expect(screen.queryByTestId('picker-clip-p1-1')).toBeNull();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    expect(screen.getByText('intro loop')).toBeTruthy();
    expect(screen.getByText('Night Bus')).toBeTruthy();
    expect(screen.getByText('8 beats')).toBeTruthy();
    expect(screen.getByText('128.0 BPM')).toBeTruthy();
    expect(screen.getByTestId('picker-clip-p2-3')).toBeTruthy();
    // A list, not a gallery of tiles — and not a module category either.
    expect(screen.getByTestId('picker-clip-list').tagName).toBe('UL');
    expect(screen.queryByTestId('picker-category-Clips')).toBeNull();
    expect(screen.queryByTestId('picker-categories')).toBeNull();
    // The tab replaces the module gallery rather than adding to it.
    expect(screen.queryByTestId('module-preview-com.dj.oscillator')).toBeNull();
  });

  it('says what each clip is made of, so a drum loop is not mistaken for a mix', () => {
    renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    // Two clips from two projects: one cut from whole mixes, one that is
    // only the rhythm section. The row says which without opening it.
    expect(screen.getByTestId('picker-clip-stems-p1-1').textContent).toBe('mix');
    expect(screen.getByTestId('picker-clip-stems-p2-3').textContent).toBe('drumsbass');
  });

  it('reopens on the tab that was used last', () => {
    const first = renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    first.unmount();

    renderClips();
    expect(screen.getByTestId('picker-clip-list')).toBeTruthy();
    expect(screen.getByTestId('picker-tab-clips').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('picker-tab-modules'));
    expect(screen.queryByTestId('picker-clip-list')).toBeNull();
    expect(screen.getByTestId('library-add-com.dj.oscillator')).toBeTruthy();
  });

  it('clicking a clip imports it as a Beat Clip module', () => {
    const { onAddClip, onAdd } = renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    fireEvent.click(screen.getByTestId('picker-clip-p2-3'));
    expect(onAddClip).toHaveBeenCalledWith(CLIPS[1]);
    // A clip is not a module type: the plain add path stays untouched.
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('types straight into the search box, which keeps the focus across tabs', () => {
    renderClips();
    expect(document.activeElement).toBe(screen.getByTestId('library-search'));
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    expect(document.activeElement).toBe(screen.getByTestId('library-search'));
  });

  it('arrows walk the list, Enter drops the row under the cursor', () => {
    const { onAddClip } = renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    // The first entry is selected without touching anything.
    expect(screen.getByTestId('picker-clip-p1-1').dataset.active).toBe('true');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByTestId('picker-clip-p2-3').dataset.active).toBe('true');
    expect(screen.getByTestId('picker-clip-p1-1').dataset.active).toBeUndefined();
    // The ends hold: no wrapping past the last or before the first.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByTestId('picker-clip-p2-3').dataset.active).toBe('true');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(screen.getByTestId('picker-clip-p1-1').dataset.active).toBe('true');

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAddClip).toHaveBeenCalledWith(CLIPS[0]);
  });

  it('a search re-aims the cursor at the first match, so Enter takes it', () => {
    const { onAddClip } = renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'o' } });
    expect(screen.getByTestId('picker-clip-p1-1').dataset.active).toBe('true');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAddClip).toHaveBeenCalledWith(CLIPS[0]);
  });

  it('Enter with nothing matching adds nothing', () => {
    const { onAddClip } = renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'zzz' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAddClip).not.toHaveBeenCalled();
  });

  it('the arrow keys leave the module gallery alone', () => {
    const { onAddClip } = renderClips();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAddClip).not.toHaveBeenCalled();
  });

  it('the Beat Clip module type itself is not in the module gallery', () => {
    renderClips();
    expect(screen.queryByTestId(`library-add-${BEAT_CLIP_TYPE}`)).toBeNull();
    expect(screen.getByTestId('library-add-com.dj.oscillator')).toBeTruthy();
  });

  it('search filters clips by name or project, and says when nothing matches', () => {
    renderClips();
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'sunroom' } });
    expect(screen.getByTestId('picker-clip-p2-3')).toBeTruthy();
    expect(screen.queryByTestId('picker-clip-p1-1')).toBeNull();
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('picker-no-clips')).toBeTruthy();
  });

  it('an empty Clips tab points at the Beatify tab', () => {
    renderClips([]);
    fireEvent.click(screen.getByTestId('picker-tab-clips'));
    expect(screen.getByTestId('picker-no-clips').textContent).toContain('Beatify');
  });
});

describe('nextInstanceId', () => {
  it('derives a short prefix from the type id and counts up', () => {
    expect(nextInstanceId('com.dj.oscillator', new Set())).toBe('oscillat1');
    expect(nextInstanceId('com.dj.oscillator', new Set(['oscillat1']))).toBe('oscillat2');
    expect(nextInstanceId('builtin.audio_out', new Set())).toBe('audioout1');
  });
});
