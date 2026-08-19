// Registry of host-registered custom UIs (PRD §5.3), shared by the rack
// (live modules, RackModule) and the module picker (inert previews).
//
// Most custom UIs are pure functions of the ModuleHandle (paramValue /
// signalTap), so they render fine against the picker's inert preview
// handle — and they ARE the recognizable face of their module. The few
// that reach past the handle on mount are preview-unsafe and keep the
// bare panel silhouette instead.

import type { ComponentType } from 'react';
import AdsrUI from '../../../extensions/adsr/ui-src/AdsrUI';
import CameraUI from '../../../extensions/camera/ui-src/CameraUI';
import EqUI from '../../../extensions/eq/ui-src/EqUI';
import EuclidUI from '../../../extensions/euclid/ui-src/EuclidUI';
import GridSeqUI from '../../../extensions/grid_seq/ui-src/GridSeqUI';
import LfoUI from '../../../extensions/lfo/ui-src/LfoUI';
import QuantizerUI from '../../../extensions/quantizer/ui-src/QuantizerUI';
import ScopeUI from '../../../extensions/scope/ui-src/ScopeUI';
import SeqSwitchUI from '../../../extensions/seq_switch/ui-src/SeqSwitchUI';
import StepSeqUI from '../../../extensions/step_seq/ui-src/StepSeqUI';
import TrigSeqUI from '../../../extensions/trig_seq/ui-src/TrigSeqUI';
import TuringUI from '../../../extensions/turing/ui-src/TuringUI';
import WaveshaperUI from '../../../extensions/waveshaper/ui-src/WaveshaperUI';
import type { ModuleHandle } from '../types';
import { DeckCustomUI } from './DeckPanel';
import { CompressorUI, FilterUI, MixerUI, VcaDualUI, VcaUI } from './LevelMeter';

export type CustomUI = ComponentType<{ handle: ModuleHandle; instanceId?: string }>;

/** Module types with a host-registered custom UI (PRD §5.3). */
export const CUSTOM_UIS: Record<string, CustomUI> = {
  'com.dj.adsr': AdsrUI,
  'com.dj.camera': CameraUI,
  'com.dj.compressor': CompressorUI,
  'com.dj.eq': EqUI,
  'com.dj.euclid': EuclidUI,
  'com.dj.filter': FilterUI,
  'com.dj.grid_seq': GridSeqUI,
  'com.dj.lfo': LfoUI,
  'com.dj.mixer': MixerUI,
  'com.dj.quantizer': QuantizerUI,
  'com.dj.scope': ScopeUI,
  'com.dj.seq_switch': SeqSwitchUI,
  'com.dj.step_seq': StepSeqUI,
  'com.dj.trig_seq': TrigSeqUI,
  'com.dj.turing': TuringUI,
  'com.dj.vca': VcaUI,
  'com.dj.vca_dual': VcaDualUI,
  'com.dj.waveshaper': WaveshaperUI,
  'builtin.deck': DeckCustomUI,
};

/** Custom UIs that must NOT mount against an inert preview handle: they
 *  have mount-time side effects beyond the handle — the camera auto-starts
 *  getUserMedia, the deck polls the deck IPC client for a (nonexistent)
 *  instance. Their previews show the bare panel instead. */
const PREVIEW_UNSAFE = new Set(['com.dj.camera', 'builtin.deck']);

/** The custom UI to render in a picker preview, if any. */
export function previewUI(typeId: string): CustomUI | undefined {
  return PREVIEW_UNSAFE.has(typeId) ? undefined : CUSTOM_UIS[typeId];
}
