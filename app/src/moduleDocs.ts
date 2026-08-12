// In-app documentation for every module type, keyed by manifest id.
// The DocsPanel derives the authoritative jack/knob lists from the live
// module manifest; this file only adds the human prose: what the module
// does, what each jack/param means (with units), and typical patches.
//
// Signals are volts in the nominal -10..+10 V range unless noted. Pitch
// CV is 1 V/oct (0 V = A4 region), gates/triggers are 0 V low / +10 V
// high with a >= 1 V threshold, and audio is typically +-5 V.
//
// Jack keys may use `#` as a stand-in for a numeric index ("cv#" matches
// cv1..cv16); exact ids win over collapsed ones.

export interface ModuleDoc {
  summary: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  params?: Record<string, string>;
  examples?: string[];
}

/** Docs for a jack id: exact match first, then with digits collapsed to
 *  `#` so numbered families (cv1..cv16) share one entry. */
export function jackDoc(map: Record<string, string> | undefined, id: string): string | undefined {
  if (!map) return undefined;
  return map[id] ?? map[id.replace(/\d+/g, '#')];
}

/** Doc for a module type; macros (abi "macro-1") share one generic entry. */
export function getModuleDoc(typeId: string, abi?: string): ModuleDoc | undefined {
  return MODULE_DOCS[typeId] ?? (abi === 'macro-1' ? MACRO_DOC : undefined);
}

export const MACRO_DOC: ModuleDoc = {
  summary:
    'A user macro: a saved sub-patch collapsed into a single module ' +
    '(select modules, then "Collapse to Module"). Its jacks are the ' +
    'promoted boundary connections of the modules inside; definitions ' +
    'live in the library database and patches pin the version they used. ' +
    'Good for taming rack sprawl and building a personal instrument ' +
    'library: a favorite voice or effect chain becomes one module you can ' +
    'drop into any patch.',
  examples: [
    'Collapse an oscillator + filter + ADSR voice into one reusable "voice" module.',
    'Wrap a send/return effect chain and reuse it across patches.',
  ],
};

export const MODULE_DOCS: Record<string, ModuleDoc> = {
  // ---------------------------------------------------------------- Sources
  'com.dj.oscillator': {
    summary:
      'Basic audio oscillator with sine, saw, square and triangle shapes, ' +
      'exponential FM and hard sync. Output is +-5 V audio. The ' +
      'bread-and-butter starting point for basslines, leads and drones: ' +
      'pair it with a filter and envelope for a classic subtractive voice, ' +
      'or point it at another oscillator\u2019s fm input as a modulator.',
    inputs: {
      pitch: 'Pitch CV, 1 V/oct.',
      fm: 'Exponential FM, added to pitch in 1 V/oct units.',
      sync: 'Hard sync: a rising edge (>= 1 V) resets the phase.',
      waveform: 'Wave select: 0 sine, 1 saw, 2 square, 3 triangle.',
    },
    outputs: { audio: 'Audio out, +-5 V.' },
    examples: [
      'pitch <- Quantizer out, audio -> Filter in for a classic subtractive voice.',
      'audio -> another Oscillator fm for two-operator FM.',
    ],
  },
  'com.dj.vco': {
    summary:
      'Full-featured VCO: simultaneous saw/tri/sine/pulse outputs, linear ' +
      'through-zero-style FM with an index control, PWM and hard sync. ' +
      'Good for rich layered voices (stack its outputs), animated PWM pads ' +
      'and basses, and clangorous FM bells and percussion.',
    inputs: {
      pitch: 'Pitch CV, 1 V/oct.',
      fine: 'Fine tune, volts added to pitch (fractions of an octave).',
      fm: 'FM signal input (audio or CV).',
      fm_index: 'FM depth: how strongly fm modulates the frequency.',
      pwm: 'Pulse width for the pulse output.',
      sync: 'Hard sync trigger: rising edge resets phase.',
    },
    outputs: {
      saw: 'Sawtooth, +-5 V.',
      tri: 'Triangle, +-5 V.',
      sine: 'Sine, +-5 V.',
      pulse: 'Pulse (width set by pwm), +-5 V.',
    },
    examples: [
      'LFO bi -> pwm for movement on the pulse output.',
      'Osc audio -> fm with fm_index up for clangorous FM tones.',
    ],
  },
  'com.dj.wavetable': {
    summary:
      'Wavetable oscillator: morphs through a table of waveforms with the ' +
      'pos control, plus FM and hard sync. Good for evolving digital ' +
      'timbres that static waveforms can\u2019t reach: sweep pos with an ' +
      'LFO or envelope for anything from glassy keys to aggressive ' +
      'modern basses.',
    inputs: {
      pitch: 'Pitch CV, 1 V/oct.',
      fine: 'Fine tune offset.',
      pos: 'Wavetable position: morphs between the table frames.',
      fm: 'FM signal input.',
      fm_index: 'FM depth.',
      sync: 'Hard sync trigger.',
    },
    outputs: { audio: 'Audio out, +-5 V.' },
    examples: ['LFO uni -> pos for slowly evolving timbres.'],
  },
  'com.dj.noise': {
    summary:
      'Noise source with white/pink/red/blue spectra plus a clocked or ' +
      'free-running random CV (sample-and-hold style) output. The raw ' +
      'material for hi-hats, snares, wind and surf textures; the random ' +
      'output is the classic source of unpredictable melodies and ' +
      'stepped modulation.',
    inputs: {
      clock: 'Trigger: samples a new random value on each rising edge.',
      rate: 'Internal random rate (Hz) when no clock is patched.',
    },
    outputs: {
      white: 'White noise, +-5 V.',
      pink: 'Pink noise (-3 dB/oct), +-5 V.',
      red: 'Red/brown noise (-6 dB/oct), +-5 V.',
      blue: 'Blue noise (+3 dB/oct), +-5 V.',
      random: 'Stepped random CV.',
    },
    examples: [
      'random -> Quantizer in for random melodies.',
      'white -> Filter in, Euclidean ch1 -> ADSR gate for hi-hats.',
    ],
  },
  'com.dj.drum': {
    summary:
      'Three-voice analog-style drum machine: kick, snare and hi-hat with ' +
      'per-voice trigger, tune, decay and tone controls. Good for an ' +
      'instant house/techno rhythm section without samples: patch triggers ' +
      'from a sequencer and tune the voices to sit under a playing deck.',
    inputs: {
      kick_trig: 'Kick trigger (rising edge).',
      kick_tune: 'Kick pitch offset, volts.',
      kick_decay: 'Kick decay time, seconds.',
      kick_tone: 'Kick click/attack amount, 0..1.',
      snare_trig: 'Snare trigger (rising edge).',
      snare_tune: 'Snare pitch offset, volts.',
      snare_decay: 'Snare decay time, seconds.',
      snare_tone: 'Snare snappy (noise) amount, 0..1.',
      hat_trig: 'Hi-hat trigger (rising edge).',
      hat_tune: 'Hi-hat pitch offset, volts.',
      hat_decay: 'Hi-hat decay time, seconds.',
      hat_tone: 'Hi-hat tone/brightness, 0..1.',
    },
    outputs: {
      kick: 'Kick voice only, +-5 V.',
      snare: 'Snare voice only, +-5 V.',
      hat: 'Hi-hat voice only, +-5 V.',
      mix: 'Sum of all three voices.',
    },
    examples: [
      'Trigger Sequencer trig1/2/3 -> kick_trig/snare_trig/hat_trig for a drum machine.',
      'Euclidean ch1 -> kick_trig with Clock driving the Euclidean.',
    ],
  },

  // ---------------------------------------------------------------- Shaping
  'com.dj.filter': {
    summary:
      'Multimode filter with simultaneous low-pass, band-pass, high-pass ' +
      'and notch outputs, resonance, drive and selectable topology. The ' +
      'heart of subtractive synthesis: it turns raw buzzy waveforms into ' +
      'plucks, acid lines, soft pads and filter sweeps, and doubles as a ' +
      'tone-shaping EQ stage for drums or a whole mix.',
    inputs: {
      in: 'Audio input.',
      cutoff: 'Cutoff frequency, Hz (exponential response).',
      res: 'Resonance, 0..1 (self-oscillates near the top).',
      drive: 'Input drive/saturation amount.',
      topology: 'Filter topology/character select (stepped).',
    },
    outputs: {
      lp: 'Low-pass output.',
      bp: 'Band-pass output.',
      hp: 'High-pass output.',
      notch: 'Notch output.',
    },
    examples: [
      'Oscillator audio -> in, ADSR env -> cutoff for a plucked voice.',
      'High res + LFO -> cutoff, tap lp for acid lines.',
    ],
  },
  'com.dj.vca': {
    summary:
      'Voltage-controlled amplifier: multiplies the input by the CV. ' +
      'CV at 0 V mutes; full CV passes the signal through. This is what ' +
      'gives notes a beginning and an end \u2014 an envelope on cv shapes ' +
      'loudness into plucks, swells and stabs \u2014 and with an LFO it ' +
      'makes tremolo or rhythmic gating.',
    inputs: {
      in: 'Signal input (audio or CV).',
      cv: 'Gain CV: 0 V = silent, full scale = unity.',
    },
    outputs: { out: 'in scaled by cv.' },
    examples: [
      'Oscillator -> in, ADSR env -> cv: the classic voice output stage.',
      'LFO uni -> cv for tremolo.',
    ],
  },
  'com.dj.vca_dual': {
    summary:
      'Two independent VCAs with selectable linear/exponential response ' +
      'and a CV offset per channel; useful as a stereo pair. Good for ' +
      'fading stereo sources (a deck, an effect return) under one ' +
      'envelope, or as two utility level controls anywhere in the patch.',
    inputs: {
      'in#': 'Channel signal input.',
      'cv#': 'Channel gain CV.',
      'resp#': 'Response curve select: linear or exponential.',
      'offset#': 'Constant added to the channel CV, volts.',
    },
    outputs: { 'out#': 'Channel output: in x (cv + offset).' },
    examples: ['Deck audio_l/audio_r -> in1/in2 with one envelope on both cv inputs.'],
  },
  'com.dj.waveshaper': {
    summary:
      'Nonlinear waveshaper/distortion with multiple transfer-curve modes, ' +
      'drive, DC bias and output level. Good for adding harmonics and ' +
      'attitude: warm a thin sine into a usable bass, crunch drums, or ' +
      'push it hard for aggressive fuzz and broken-speaker textures.',
    inputs: {
      in: 'Audio input.',
      mode: 'Shaping curve select (stepped).',
      drive: 'Amount of gain into the shaper.',
      bias: 'DC offset added before shaping (asymmetry).',
      level: 'Output level.',
    },
    outputs: { out: 'Shaped audio.' },
    examples: ['Oscillator -> in with LFO -> drive for evolving grit.'],
  },
  'com.dj.compressor': {
    summary:
      'Stereo compressor with sidechain input, threshold/ratio/knee, ' +
      'attack/release and makeup gain. The gr output exposes the gain ' +
      'reduction as a CV. Good for gluing a mix together, keeping levels ' +
      'consistent, and \u2014 via the sidechain \u2014 the pumping ' +
      'kick-ducks-everything effect at the core of house and EDM.',
    inputs: {
      in_l: 'Left audio input.',
      in_r: 'Right audio input.',
      sidechain: 'External detector input (compresses in_l/in_r from this signal).',
      threshold: 'Threshold, dB.',
      ratio: 'Compression ratio, 1..20.',
      attack: 'Attack time, seconds.',
      release: 'Release time, seconds.',
      knee: 'Soft knee width, dB.',
      makeup: 'Makeup gain, dB.',
    },
    outputs: {
      out_l: 'Left output.',
      out_r: 'Right output.',
      gr: 'Gain reduction, as a CV (for meters or ducking other signals).',
    },
    examples: ['Drum mix -> sidechain, pads -> in_l/in_r for pumping sidechain ducking.'],
  },

  // ------------------------------------------------------------- Modulation
  'com.dj.adsr': {
    summary:
      'Attack / Decay / Sustain / Release envelope generator. The envelope ' +
      'rises while gate is high and releases when it falls; retrig restarts ' +
      'the attack without dropping the gate. The standard way to give ' +
      'notes shape: snappy settings make plucks and percussion, slow ones ' +
      'make pads and swells \u2014 aim it at a VCA for loudness or a ' +
      'filter cutoff for tone.',
    inputs: {
      gate: 'Gate input: high (>= 1 V) opens the envelope.',
      retrig: 'Trigger: rising edge restarts the attack phase.',
      attack: 'Attack time, seconds.',
      decay: 'Decay time, seconds.',
      sustain: 'Sustain level, 0..1 of full scale.',
      release: 'Release time, seconds.',
    },
    outputs: { env: 'Envelope CV, 0..+10 V.' },
    examples: [
      'MIDI v1_gate -> gate, env -> VCA cv for a keyboard voice.',
      'env -> Filter cutoff for plucks.',
    ],
  },
  'com.dj.lfo': {
    summary:
      'Low-frequency oscillator with multiple shapes, clock sync with ' +
      'ratio, phase offset and reset. Bipolar, unipolar and phase-shifted ' +
      'outputs run simultaneously. The workhorse for adding movement to ' +
      'anything static: filter wobbles, tremolo, vibrato, auto-panning ' +
      'and slow drifting pads \u2014 clock-sync it for dubstep-style ' +
      'tempo-locked wubs.',
    inputs: {
      rate: 'Free-running rate, Hz.',
      shape: 'Waveform select (stepped: sine, tri, saw, square, random...).',
      pw: 'Pulse width / shape skew, 0..1.',
      clock: 'Clock input: rising edges tempo-sync the LFO.',
      ratio: 'Clock-sync ratio (multiply/divide the incoming clock).',
      reset: 'Trigger: resets the LFO phase.',
      phase: 'Phase offset, 0..1 cycles.',
    },
    outputs: {
      bi: 'Bipolar output, +-5 V.',
      uni: 'Unipolar output, 0..+10 V.',
      shifted: 'Copy of bi at the phase offset (for quadrature effects).',
    },
    examples: [
      'bi -> Filter cutoff for wobble; Clock clock -> clock to sync it to tempo.',
      'uni -> VCA cv for tremolo.',
    ],
  },
  'com.dj.function': {
    summary:
      'Function generator (Maths-style): a rise/fall slope that can be a ' +
      'triggered envelope, a gated ASR, a slew limiter on in, or a cycling ' +
      'LFO. End-of-rise / end-of-cycle triggers make it a rhythm tool too. ' +
      'The Swiss-army modulator: percussive envelopes, portamento on ' +
      'pitch CVs, and \u2014 chained via eoc \u2014 self-patched ' +
      'generative rhythms.',
    inputs: {
      in: 'Signal to slew-limit (follows in at the rise/fall rates).',
      trig: 'Trigger: fires one rise+fall cycle.',
      gate: 'Gate: rises while high, falls on release.',
      rise: 'Rise time, seconds.',
      fall: 'Fall time, seconds.',
      curve: 'Curve shape: log through linear to exponential.',
      cycle: 'Switch: self-retrigger (turns the envelope into an LFO).',
    },
    outputs: {
      out: 'Function output, 0..+10 V.',
      eor: 'End-of-rise trigger.',
      eoc: 'End-of-cycle trigger.',
    },
    examples: [
      'trig from a sequencer, out -> VCA cv: a two-stage envelope.',
      'cycle on, eoc -> another Function trig for chained rhythmic ramps.',
    ],
  },
  'com.dj.sample_hold': {
    summary:
      'Sample & hold / track & hold with built-in noise source and slew. ' +
      'Samples in on each trig edge; mode selects sample vs track behavior. ' +
      'The classic recipe for burbling random melodies (clock it, quantize ' +
      'its output) and for turning any moving signal into stepped, ' +
      'rhythmic modulation.',
    inputs: {
      in: 'Signal to sample (defaults to internal noise if unpatched).',
      trig: 'Trigger: sample on rising edge.',
      mode: 'Mode select: sample & hold / track & hold.',
      slew: 'Slew (glide) between held values, seconds.',
    },
    outputs: {
      out: 'Held value.',
      noise: 'Internal white noise, +-5 V.',
    },
    examples: ['Clock -> trig, out -> Quantizer in for stepped random melodies.'],
  },

  // ---------------------------------------------------- Clock & Sequencing
  'com.dj.clock': {
    summary:
      'Master clock: BPM with run/reset, swing and a bar-length setting. ' +
      'Emits the base clock plus divided (/2../16) and multiplied (x2..x4) ' +
      'triggers and a once-per-bar pulse. The heartbeat of any rhythmic ' +
      'patch: it keeps sequencers, LFOs and delays locked to one tempo, ' +
      'and its divisions layer half-time and double-time parts that ' +
      'stay in step.',
    inputs: {
      bpm: 'Tempo, beats per minute.',
      run: 'Run switch: clock emits pulses while high.',
      reset: 'Trigger: restarts the bar/beat counters.',
      swing: 'Swing amount, 0..1: delays every second pulse.',
      beats: 'Beats per bar, 1..16.',
    },
    outputs: {
      clock: 'Beat clock trigger.',
      div2: 'Clock divided by 2.',
      div4: 'Clock divided by 4.',
      div8: 'Clock divided by 8.',
      div16: 'Clock divided by 16.',
      mul2: 'Clock multiplied by 2.',
      mul3: 'Clock multiplied by 3.',
      mul4: 'Clock multiplied by 4.',
      bar: 'One trigger per bar.',
    },
    examples: [
      'clock -> Step Sequencer clock, bar -> its reset for locked phrases.',
      'mul2 -> Trigger Sequencer clock for 8th-note drum patterns.',
    ],
  },
  'com.dj.step_seq': {
    summary:
      '16-step CV/gate sequencer: per-step CV, gate on/off and ratchet ' +
      'count, with length, direction (fwd/rev/pendulum/random) and glide. ' +
      'The main tool for writing melodic lines in the rack: basslines, ' +
      'arpeggios and acid sequences, with ratchets for fills and glide ' +
      'for 303-style slides.',
    inputs: {
      clock: 'Step advance trigger.',
      reset: 'Trigger: jump back to step 1.',
      length: 'Sequence length, 1..16 steps.',
      dir: 'Play direction (stepped: forward, reverse, pendulum, random).',
      glide: 'Portamento between step CVs, seconds.',
      'cv#': 'CV value for step # (volts; feed the out through a Quantizer for notes).',
      'gate#': 'Gate on/off for step #.',
      'ratchet#': 'Ratchet count for step # (retriggers within the step).',
    },
    outputs: {
      cv: 'Current step CV.',
      gate: 'Gate output (high on active steps, ratcheted).',
      eos: 'End-of-sequence trigger.',
      step: 'Current step index as CV.',
    },
    examples: ['Clock clock -> clock, cv -> Quantizer -> Oscillator pitch, gate -> ADSR gate.'],
  },
  'com.dj.trig_seq': {
    summary:
      '8-track trigger sequencer: each track has a pattern (set from the ' +
      'panel grid) and its own length, so tracks can polyrhythm against ' +
      'each other. The drum-programming surface of the rack: draw kick, ' +
      'snare and hat patterns 808-style, and give tracks different ' +
      'lengths for evolving polyrhythms.',
    inputs: {
      clock: 'Step advance trigger for all tracks.',
      reset: 'Trigger: all tracks back to step 1.',
      'pat#': 'Track # pattern (bitmask driven by the panel grid).',
      'len#': 'Track # length in steps.',
    },
    outputs: {
      'trig#': 'Track # trigger output.',
      pos: 'Current step position as CV.',
    },
    examples: ['trig1/trig2/trig3 -> Drum kick_trig/snare_trig/hat_trig.'],
  },
  'com.dj.euclid': {
    summary:
      'Four-channel Euclidean rhythm generator: each channel spreads fill ' +
      'hits evenly across steps with a rotation, a musical way to get ' +
      'interlocking patterns from one clock. Good for grooves you ' +
      'wouldn\u2019t program by hand: world-rhythm and techno patterns ' +
      'emerge from two numbers, and nudging fill or rotation live makes ' +
      'instant variations.',
    inputs: {
      clock: 'Step advance trigger.',
      reset: 'Trigger: back to step 1 on all channels.',
      'steps#': 'Channel # pattern length, 1..32.',
      'fill#': 'Channel # number of hits distributed across the steps.',
      'rot#': 'Channel # pattern rotation.',
    },
    outputs: {
      'ch#': 'Channel # trigger output.',
      or: 'Logical OR of all four channels.',
      'step#': 'Channel # current position as CV.',
    },
    examples: ['ch1 (16/4) kick, ch2 (16/7, rotated) hats: instant techno.'],
  },
  'com.dj.turing': {
    summary:
      'Random looping CV (Turing machine style): a shift register that ' +
      'mutates with probability prob; at prob 0 the loop repeats forever, ' +
      'at full prob it is fully random. Optional built-in quantizer. ' +
      'The generative-melody machine: dial in some chaos until a phrase ' +
      'you like appears, then lock it \u2014 great for self-playing ' +
      'ambient patches and endless hooks.',
    inputs: {
      clock: 'Step advance trigger.',
      prob: 'Mutation probability, 0..1 (0 = locked loop).',
      length: 'Loop length in steps.',
      range: 'CV output range scaling.',
      scale: 'Quantizer scale for the quant output.',
      root: 'Quantizer root note.',
    },
    outputs: {
      cv: 'Raw register CV.',
      bit1: 'Register bit 1 as a gate.',
      bit2: 'Register bit 2 as a gate.',
      quant: 'Quantized CV output (scale/root).',
      reg: 'Register value as CV.',
    },
    examples: ['quant -> Oscillator pitch, bit1 -> ADSR gate: a self-playing melody.'],
  },
  'com.dj.seq_switch': {
    summary:
      'Sequential switch / router: distributes in across outputs o1..o8, or ' +
      'selects one of i1..i8 onto out — stepped by a clock or addressed ' +
      'directly by CV. Per-step mute switches skip steps. Good for ' +
      'evolving patches without touching a knob: rotate one melody across ' +
      'several voices, or cycle different modulators onto one destination ' +
      'for movement that changes every bar.',
    inputs: {
      in: 'Signal to distribute to o1..o8 (1-to-N mode).',
      'i#': 'Input # for N-to-1 selection onto out.',
      clock: 'Step advance trigger.',
      reset: 'Trigger: back to step 1.',
      cv: 'CV addressing: selects the active step directly.',
      steps: 'Number of active steps, 1..8.',
      'm#': 'Mute switch for step # (skipped when on).',
    },
    outputs: {
      'o#': 'Distribution output # (1-to-N mode).',
      out: 'Selected input (N-to-1 mode).',
      step_cv: 'Active step index as CV.',
    },
    examples: [
      'Four LFOs -> i1..i4, Clock -> clock, out -> Filter cutoff for evolving modulation.',
    ],
  },

  // ----------------------------------------------------------------- Effects
  'com.dj.delay': {
    summary:
      'Stereo delay with clock-syncable time, feedback, damping filters and ' +
      'ping-pong mode. Good for adding space and rhythm at once: dub ' +
      'echoes on stabs and vocals, dotted-eighth bounce on melodies, and ' +
      'runaway feedback swells as a transition effect.',
    inputs: {
      in_l: 'Left audio input.',
      in_r: 'Right audio input.',
      time: 'Delay time, seconds (used when no clock is patched).',
      clock: 'Clock input: delay time locks to the clock via div.',
      div: 'Clock division for synced delay time.',
      feedback: 'Feedback amount, 0..1.',
      lowpass: 'Feedback-path low-pass cutoff, Hz (darkens repeats).',
      highpass: 'Feedback-path high-pass cutoff, Hz (thins repeats).',
      mix: 'Dry/wet mix, 0..1.',
      pingpong: 'Switch: alternate repeats left/right.',
    },
    outputs: { out_l: 'Left output.', out_r: 'Right output.' },
    examples: ['Clock clock -> clock with div at 3/16 for a dotted-eighth dub delay.'],
  },
  'com.dj.reverb': {
    summary:
      'Stereo algorithmic reverb with size, decay, damping, diffusion and a ' +
      'freeze switch that holds the tail forever. Good for putting sounds ' +
      'in a space \u2014 from tight rooms on drums to huge ambient washes ' +
      'on pads \u2014 and freeze turns any moment into a sustained drone ' +
      'to play over.',
    inputs: {
      in_l: 'Left audio input.',
      in_r: 'Right audio input.',
      size: 'Room size.',
      decay: 'Tail decay time.',
      damping: 'High-frequency damping in the tail.',
      diffusion: 'Echo density.',
      freeze: 'Switch: infinitely sustain the current tail.',
      mix: 'Dry/wet mix, 0..1.',
    },
    outputs: { out_l: 'Left output.', out_r: 'Right output.' },
    examples: ['Gate the freeze switch from a sequencer for rhythmic frozen washes.'],
  },
  'com.dj.granular': {
    summary:
      'Granular processor: chops the incoming audio into grains with ' +
      'controllable density, size, playback position, pitch and stereo ' +
      'spread; freeze locks the buffer. Good for turning any source into ' +
      'shimmering clouds, stretched ambient beds and glitchy stutters ' +
      '\u2014 freeze a deck mid-phrase and smear it into a texture while ' +
      'the next track comes in.',
    inputs: {
      in_l: 'Left audio input.',
      in_r: 'Right audio input.',
      density: 'Grains per second.',
      size: 'Grain length.',
      position: 'Playback position within the buffer, 0..1.',
      pitch: 'Grain pitch shift, volts (1 V/oct).',
      texture: 'Grain envelope shape.',
      spread: 'Stereo spread of grains, 0..1.',
      feedback: 'Output-to-buffer feedback, 0..1.',
      freeze: 'Switch: stop recording, granulate the held buffer.',
      trig: 'Trigger: spawn a grain manually.',
      mix: 'Dry/wet mix, 0..1.',
    },
    outputs: { out_l: 'Left output.', out_r: 'Right output.' },
    examples: ['Freeze a deck stem and sweep position with an LFO for ambient beds.'],
  },
  'com.dj.modfx': {
    summary:
      'Stereo modulation multi-effect: chorus / flanger / phaser modes with ' +
      'rate, depth, feedback and stereo spread; through_zero enables ' +
      'through-zero flanging. Good for width and motion: chorus thickens ' +
      'pads and unison leads, flanger adds jet-engine sweeps to drums, ' +
      'phaser gives keys and guitars a classic swirl.',
    inputs: {
      in_l: 'Left audio input.',
      in_r: 'Right audio input.',
      mode: 'Effect select: chorus / flanger / phaser (stepped).',
      rate: 'Modulation rate, Hz.',
      depth: 'Modulation depth.',
      feedback: 'Feedback/resonance amount.',
      spread: 'Stereo phase spread of the modulation.',
      through_zero: 'Switch: through-zero flanging.',
      mix: 'Dry/wet mix, 0..1.',
    },
    outputs: { out_l: 'Left output.', out_r: 'Right output.' },
    examples: ['Deck stem_other -> in for wide chorused pads in a live set.'],
  },
  'com.dj.resonator': {
    summary:
      'Physical-modelling resonator (Rings-style): excites a modal / string ' +
      'model with the input or trig, tuned by pitch with structure, ' +
      'brightness, damping and position controls. Good for acoustic-feeling ' +
      'voices no oscillator makes: plucked strings, struck bells, marimbas ' +
      'and gongs \u2014 or feed it a full mix to make everything ring in key.',
    inputs: {
      in: 'Excitation audio input.',
      trig: 'Trigger: strike the resonator.',
      pitch: 'Resonator pitch, 1 V/oct.',
      structure: 'Harmonic structure / inharmonicity.',
      brightness: 'Brightness of the excitation.',
      damping: 'Decay damping.',
      position: 'Excitation position along the string/membrane.',
      mode: 'Resonator model select (stepped).',
      voices: 'Polyphony (stepped).',
      mix: 'Dry/wet mix.',
    },
    outputs: { out_l: 'Left output (odd partials).', out_r: 'Right output (even partials).' },
    examples: ['Euclidean ch2 -> trig, Turing quant -> pitch: generative plucked bells.'],
  },

  // --------------------------------------------------------------- Utilities
  'com.dj.mixer': {
    summary:
      'Six-channel stereo mixer with per-channel level and pan plus a ' +
      'master level. Each channel is an L/R pair; leave R unpatched and ' +
      'it mirrors L, so a mono source pans across the stereo field. Good ' +
      'for summing a multi-oscillator stack into one fat voice, balancing ' +
      'a few parts into a stereo submix, or placing voices in the field.',
    inputs: {
      'in#_l': 'Channel # left input (audio).',
      'in#_r': 'Channel # right input (audio; mirrors L when unpatched).',
      'lvl#': 'Channel # level fader, 0..10 (10 = unity).',
      'pan#': 'Channel # pan/balance, -10 (left) .. +10 (right).',
      master: 'Master output level.',
    },
    outputs: {
      out_l: 'Left mix output.',
      out_r: 'Right mix output.',
    },
    examples: [
      'Sum a three-oscillator stack before one Filter.',
      'Pan two voices apart for instant stereo width.',
    ],
  },
  'com.dj.attenuverter': {
    summary:
      'Eight-channel attenuverter/offset: each channel scales its input by ' +
      '-1..+1 (inverting below zero) and adds a DC offset — the utility ' +
      'knob for taming or flipping any CV. Unpatched channels output just ' +
      'the offset, making it a CV source too. Good for making modulation ' +
      'musical: shrink an LFO to a subtle vibrato, flip an envelope to ' +
      'duck instead of swell, or dial in a fixed voltage by hand.',
    inputs: {
      'in#': 'Channel # input.',
      'atten#': 'Channel # gain, -1..+1 (negative inverts).',
      'offset#': 'Channel # DC offset, volts.',
    },
    outputs: { 'out#': 'Channel # output: in x atten + offset.' },
    examples: [
      'Tame an LFO to +-1 V before a pitch input.',
      'Leave in unpatched and use offset as a manual CV source.',
    ],
  },
  'com.dj.mult': {
    summary:
      'Buffered mult, merge and split in one panel: two 1-to-4 mults, a ' +
      '4-to-1 merge (sum), and a 1-of-4 splitter addressed by split_sel. ' +
      'The plumbing of a patch: send one clock or pitch CV to several ' +
      'destinations at once, or gather several triggers onto one input.',
    inputs: {
      a_in: 'Mult A input (copied to a1..a4).',
      b_in: 'Mult B input (copied to b1..b4).',
      'merge#': 'Merge input # (summed onto merge).',
      split_in: 'Splitter input.',
      split_sel: 'Splitter destination select, 0..3.',
    },
    outputs: {
      'a#': 'Copy # of a_in.',
      'b#': 'Copy # of b_in.',
      merge: 'Sum of merge1..merge4.',
      's#': 'Splitter output # (carries split_in when selected).',
    },
    examples: ['One clock -> a_in, copies to several sequencers.'],
  },
  'com.dj.logic': {
    summary:
      'Logic and comparator toolbox: boolean gates on a/b/c, a threshold ' +
      'comparator, a window comparator and a gate-to-trigger converter. ' +
      'Good for deriving new rhythms from existing ones \u2014 combine two ' +
      'sequencer patterns into a third \u2014 and for turning any CV into ' +
      'gates (e.g. fire an event whenever an LFO crosses a level).',
    inputs: {
      a: 'Logic input A (>= 1 V is true).',
      b: 'Logic input B.',
      c: 'Logic input C.',
      cmp_in: 'Comparator input.',
      threshold: 'Comparator threshold, volts.',
      win_in: 'Window comparator input.',
      win_low: 'Window lower bound, volts.',
      win_high: 'Window upper bound, volts.',
      g2t_in: 'Gate-to-trigger input.',
      trig_ms: 'Emitted trigger length, milliseconds.',
    },
    outputs: {
      and: 'A AND B (AND C when patched).',
      nand: 'NOT (A AND B).',
      or: 'A OR B (OR C).',
      nor: 'NOT (A OR B).',
      xor: 'A XOR B.',
      xnor: 'NOT (A XOR B).',
      not_a: 'NOT A.',
      not_b: 'NOT B.',
      cmp: 'High while cmp_in > threshold.',
      window: 'High while win_low < win_in < win_high.',
      trig: 'Trigger on each rising edge of g2t_in.',
    },
    examples: ['Two Euclidean channels -> a/b; xor gives the hits that do not overlap.'],
  },
  'com.dj.quantizer': {
    summary:
      'Pitch quantizer: snaps the input CV to the nearest note of a scale ' +
      '(scale 0 is a custom scale from the panel keyboard), with root, ' +
      'semitone and octave transpose. Emits a trigger on each note change. ' +
      'What turns raw voltages into music: put it between any modulation ' +
      'source \u2014 random, LFO, sequencer \u2014 and an oscillator and ' +
      'the output always lands in key.',
    inputs: {
      in: 'CV to quantize (1 V/oct).',
      scale: 'Scale select (0 = custom scale from the keyboard).',
      root: 'Root note, semitones.',
      semitones: 'Transpose, semitones.',
      octaves: 'Transpose, octaves.',
      custom: 'Custom-scale bitmask (driven by the panel keyboard).',
    },
    outputs: {
      out: 'Quantized pitch CV, 1 V/oct.',
      trig: 'Trigger on every note change.',
    },
    examples: ['Noise random -> in, out -> Oscillator pitch, trig -> ADSR gate.'],
  },
  'com.dj.gain_native': {
    summary:
      'Sample native (dylib) extension: a simple gain stage. Demonstrates ' +
      'the unsandboxed native module ABI; the boost param adds fixed gain. ' +
      'Musically it\u2019s a utility level trim; its real purpose is as ' +
      'the reference example for writing native extensions.',
    inputs: {
      in: 'Signal input.',
      gain: 'Gain multiplier.',
    },
    outputs: { out: 'in x gain (x boost).' },
    params: { boost: 'Extra fixed gain multiplier.' },
    examples: ['Insert between modules as a utility gain trim.'],
  },

  // --------------------------------------------------------- Analysis & I/O
  'com.dj.scope': {
    summary:
      'Oscilloscope and signal analyzer: displays the input and extracts ' +
      'pitch, level and trigger information as CV outputs. Audio passes ' +
      'through unchanged on thru. Good for understanding a patch \u2014 ' +
      'see what a knob actually does to the wave \u2014 and its pitch/ ' +
      'level/onset outputs let audio itself drive the rack, e.g. a deck ' +
      'triggering envelopes.',
    inputs: {
      in: 'Signal to analyze.',
      hysteresis: 'Trigger-detection hysteresis, volts.',
      window: 'Analysis window length, seconds.',
    },
    outputs: {
      thru: 'Unchanged copy of in.',
      pitch: 'Detected pitch as CV (1 V/oct).',
      hz: 'Detected frequency, Hz-scaled CV.',
      peak: 'Peak level.',
      rms: 'RMS level.',
      trig: 'Trigger on detected onsets.',
    },
    examples: ['Sit inline after an oscillator to watch the waveform while patching.'],
  },
  'com.dj.camera': {
    summary:
      'Live webcam monitor panel. The video preview is pure app-layer ' +
      '(getUserMedia); audio passes through in -> thru so the panel can sit ' +
      'inline in the rack. Camera enablement is per-session and never saved ' +
      'in the patch. Independent of the Gesture module. Good for streaming ' +
      'and recorded performances: keep your framing in view, or just watch ' +
      'your hands while learning controller moves.',
    inputs: { in: 'Audio pass-through input.' },
    outputs: { thru: 'Unchanged copy of in.' },
    examples: ['Drop it anywhere in the rack to keep an eye on yourself while performing.'],
  },

  // ---------------------------------------------------------------- Builtins
  'builtin.audio_out': {
    summary:
      'The rack\u2019s connection to the audio device: whatever arrives at ' +
      'l/r is what you hear. channel_offset picks the first hardware output ' +
      'channel pair on multi-channel interfaces. Every audible patch ends ' +
      'here \u2014 it serves no sound of its own, it\u2019s the speakers.',
    inputs: {
      l: 'Left channel to the audio device.',
      r: 'Right channel to the audio device.',
      channel_offset: 'First hardware output channel (pairs), 0..8.',
    },
    examples: ['Crossfader out_l/out_r -> l/r is the end of every DJ patch.'],
  },
  'builtin.midi': {
    summary:
      'MIDI controller I/O. Learned controls appear on the mapping jacks ' +
      '(map0..) — use the panel\u2019s learn flow to bind knobs/pads. A ' +
      '4-voice polyphonic note allocator feeds the v1..v4 pitch/gate/velocity ' +
      'trios, plus channel-wide wheels and transport. LED feedback mappings ' +
      'are input jacks (led0..) that drive lights on the controller. This ' +
      'is how hardware gets hands-on with the rack: play patches from a ' +
      'keyboard, and put filter sweeps and crossfades under real knobs ' +
      'and faders for live performance.',
    inputs: { 'led#': 'LED feedback: send a CV here to light the mapped control.' },
    outputs: {
      'map#': 'A learned control (CC/note), 0..+10 V.',
      'v#_pitch': 'Voice # note pitch, 1 V/oct.',
      'v#_gate': 'Voice # gate (high while the key is held).',
      'v#_vel': 'Voice # velocity, 0..+10 V.',
      mod: 'Mod wheel (CC1).',
      bend: 'Pitch bend, bipolar.',
      pressure: 'Channel aftertouch.',
      sustain: 'Sustain pedal gate.',
      clock: 'MIDI clock, 24 pulses per quarter note.',
      beat: 'One trigger per beat.',
      transport: 'High while the MIDI transport is running.',
    },
    examples: [
      'v1_pitch/v1_gate -> Oscillator pitch + ADSR gate for a MIDI keyboard voice.',
      'Map a knob to map0 and wire it to Filter cutoff.',
    ],
  },
  'builtin.gesture': {
    summary:
      'Camera gesture control (PRD \u00a77.3): hand tracking is evaluated by ' +
      'the active mode and each named mapping becomes an output jack, like ' +
      'MIDI mappings. Detection runs off the audio thread; values are ' +
      'applied sample-accurately and hold their last value on dropped ' +
      'frames. Good for performing without touching anything: wave a hand ' +
      'to sweep a filter, ride a virtual wheel to nudge a deck, keep ' +
      'playing while your hands are on other gear.',
    outputs: { 'map#': 'A gesture mapping value, as configured in the panel.' },
    examples: ['Add a "wheel" mapping and wire it to a Deck speed for touchless nudging.'],
  },
  'builtin.deck': {
    summary:
      'DJ deck: plays a library track with pitch fader, phase nudge, hot ' +
      'cues, loop and beat-synced outputs. Beatgrids, cues and loops are ' +
      'stored in the track library (not the patch). When stems are analyzed, ' +
      'per-stem outputs and gain params let you remix the track in the rack. ' +
      'The centerpiece of DJing in the rack: beat-match and blend real ' +
      'tracks, and \u2014 because beats and stems are jacks \u2014 let the ' +
      'music drive synths, sequencers and effects around it.',
    inputs: {
      play_gate: 'Play/pause gate: high plays, low pauses.',
      speed: 'Pitch fader, scaled by the pitch_range param.',
      phase_nudge: 'Temporary tempo bend for beat-matching by ear.',
      loop_toggle: 'Trigger: engage/release the saved loop.',
      'cue_trig#': 'Trigger: jump to (or set) hot cue #.',
    },
    outputs: {
      audio_l: 'Track audio, left.',
      audio_r: 'Track audio, right.',
      beat_clock: 'Trigger on every beat of the beatgrid.',
      bar_clock: 'Trigger on every bar.',
      phase: 'Bar phase ramp, 0..+10 V across each bar.',
      bpm: 'Current effective BPM as CV.',
      stem_drums: 'Drums stem (post stem gain).',
      stem_bass: 'Bass stem (post stem gain).',
      stem_vocals: 'Vocals stem (post stem gain).',
      stem_other: 'Other/instruments stem (post stem gain).',
    },
    params: {
      pitch_range: 'Pitch fader range, fraction (0.08 = +-8%).',
      keylock: 'Keep the musical key constant while the tempo changes.',
      reverse: 'Play backwards.',
      slip: 'Slip mode: position keeps advancing under loops/scratches.',
      stem_drums: 'Drums stem gain, 0..1 (0 mutes it in the mix).',
      stem_bass: 'Bass stem gain, 0..1.',
      stem_vocals: 'Vocals stem gain, 0..1.',
      stem_other: 'Other stem gain, 0..1.',
    },
    examples: [
      'audio_l/audio_r -> Crossfader a_l/a_r; second deck to b_l/b_r.',
      'beat_clock -> Euclidean clock to sync a drum machine to the playing track.',
      'stem_vocals -> Reverb for an acapella wash while the drums stay dry.',
    ],
  },
  'builtin.playback': {
    summary:
      'Simple file player: plays a loaded audio file with variable speed ' +
      'and looping — the deck\u2019s minimal sibling for backing tracks and ' +
      'samples. Good for anything that just needs to play: ambient beds ' +
      'and field recordings under a set, loops and one-shots as extra ' +
      'texture, with speed as a quick pitch/time effect.',
    inputs: {
      play_gate: 'Play/pause gate.',
      speed: 'Playback rate multiplier, -2..+2 (negative reverses).',
      loop: 'Switch: loop at end of file.',
    },
    outputs: { out_l: 'Left audio.', out_r: 'Right audio.' },
    examples: ['Loop a texture under a live set with speed at 0.5 for half-time.'],
  },
  'builtin.crossfader': {
    summary:
      'DJ crossfader: blends stereo pair A and pair B under one fader. ' +
      '-10 V is full A, +10 V full B, 0 V an equal-power blend. The heart ' +
      'of the two-deck mix \u2014 smooth transitions and cuts between ' +
      'tracks \u2014 and, driven by CV, an automatic or rhythmic blend ' +
      'between any two stereo sources.',
    inputs: {
      a_l: 'Channel A left.',
      a_r: 'Channel A right.',
      b_l: 'Channel B left.',
      b_r: 'Channel B right.',
      xfade: 'Crossfade position, -10 (A) .. +10 (B).',
    },
    outputs: { out_l: 'Blended left.', out_r: 'Blended right.' },
    examples: [
      'Two decks -> A/B, out -> Audio Output; map xfade to a MIDI fader.',
      'LFO bi -> xfade for automatic back-and-forth blends.',
    ],
  },
};
