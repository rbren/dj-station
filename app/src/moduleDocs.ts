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
    '(select modules, then "Collapse to Macro"). Its jacks are the ' +
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
      'linear through-zero FM and hard sync. Output is +-5 V audio. The ' +
      'bread-and-butter starting point for basslines, leads and drones: ' +
      'pair it with a filter and envelope for a classic subtractive voice, ' +
      'or point it at another oscillator\u2019s fm input as a modulator.',
    inputs: {
      pitch:
        'Which note to play: 1 V/oct pitch CV (0 V = C4). Patch a sequencer, ' +
        'quantizer or MIDI pitch output here for melodies.',
      fm:
        'FM signal input (audio or CV): linear through-zero FM, so the pitch ' +
        'you play stays put while the timbre changes. +-5 V swings the ' +
        'frequency by +-100 % per unit of fm_index; past that the frequency ' +
        'goes negative and the phase runs backwards.',
      fm_index:
        'FM depth: how strongly fm modulates the frequency. 0 (the default) ' +
        'is no FM at all \u2014 turn it up to hear the fm input.',
      sync: 'Hard sync: a rising edge (>= 1 V) resets the phase.',
      waveform: 'Wave select: 0 sine, 1 saw, 2 square, 3 triangle.',
    },
    outputs: {
      audio:
        'The tone itself, +-5 V audio. It drones continuously \u2014 patch it ' +
        'through a filter and/or VCA to shape it into notes.',
    },
    examples: [
      'pitch <- Quantizer out, audio -> Filter in for a classic subtractive voice.',
      'audio -> another Oscillator fm with fm_index up for two-operator FM.',
    ],
  },
  'com.dj.vco': {
    summary:
      'Full-featured VCO: simultaneous saw/tri/sine/pulse outputs, linear ' +
      'through-zero-style FM with an index control, PWM and hard sync. ' +
      'Good for rich layered voices (stack its outputs), animated PWM pads ' +
      'and basses, and clangorous FM bells and percussion.',
    inputs: {
      pitch: 'Which note to play: 1 V/oct pitch CV (0 V = C4).',
      fine: 'Fine tune, volts added to pitch (fractions of an octave).',
      fm: 'FM signal input (audio or CV).',
      fm_index: 'FM depth: how strongly fm modulates the frequency.',
      pwm:
        'Pulse width for the pulse output: 0 V is a square wave, away from ' +
        'that it thins out. Wire an LFO here for classic PWM movement.',
      sync: 'Hard sync trigger: rising edge resets phase.',
    },
    outputs: {
      saw:
        'Sawtooth, +-5 V: bright and buzzy with every harmonic \u2014 the ' +
        'classic raw material for filtered basses and leads.',
      tri: 'Triangle, +-5 V: mellow and flute-like, only soft odd harmonics.',
      sine: 'Sine, +-5 V: just the fundamental \u2014 clean sub-bass, or an FM modulator.',
      pulse:
        'Pulse, +-5 V: hollow and reedy. Its width follows pwm; modulating ' +
        'that width animates the timbre.',
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
      pitch: 'Which note to play: 1 V/oct pitch CV (0 V = C4).',
      fine: 'Fine tune: a small pitch offset for detuning against another oscillator.',
      pos: 'Wavetable position: morphs between the table frames.',
      fm: 'FM signal input.',
      fm_index: 'FM depth: how strongly the fm signal modulates the frequency.',
      sync: 'Hard sync: a rising edge resets the wave phase (tearing sync leads).',
    },
    outputs: {
      audio: 'The morphing tone, +-5 V audio; shape it with a filter and VCA.',
    },
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
      white:
        'White noise (equal energy per Hz), +-5 V: bright hiss \u2014 the raw ' +
        'material for hats and snares.',
      pink: 'Pink noise (-3 dB/oct), +-5 V: darker and natural \u2014 wind, surf, vinyl air.',
      red: 'Red/brown noise (-6 dB/oct), +-5 V: deep rumble with almost no top end.',
      blue: 'Blue noise (+3 dB/oct), +-5 V: extra-bright sizzle for crisp hats.',
      random:
        'Stepped random CV: a new value on every clock edge (or at rate). ' +
        'Quantize it for random melodies, or slew it for drifting modulation.',
    },
    examples: [
      'random -> Quantizer in for random melodies.',
      'white -> Filter in, Euclidean ch1 -> ADSR gate for hi-hats.',
    ],
  },
  'com.dj.spectral_noise': {
    summary:
      'Noise whose spectrum is the instrument: one output shaped by the ' +
      'first two terms of a spectral polynomial about the tilt frequency ' +
      '\u2014 a straight slope (tilt) plus a bell on the pivot ' +
      '(curvature). The classic colours are single tilt values (0 white, ' +
      '-3 pink, -6 red/brown, +3 blue, +6 violet) and ship as built-in ' +
      'presets in the right-click menu, with grey and green using the ' +
      'curvature term. The level is normalized, so changing colour is a ' +
      'change of tone and never of loudness.',
    inputs: {
      tilt:
        'Spectral slope in dB per octave through the pivot: 0 white, -3 ' +
        'pink, -6 red/brown, +3 blue, +6 violet.',
      pivot:
        'Tilt frequency: the point the slope turns about and the centre of ' +
        'the curvature bell. The slope spans about five octaves either ' +
        'side of it and flattens beyond.',
      curve:
        'Curvature in dB: a bell on the pivot, positive for a boost, ' +
        'negative for a scoop \u2014 the quadratic term, bounded.',
    },
    outputs: {
      out: 'The shaped noise, ~2 V RMS whatever the colour.',
    },
    examples: [
      'Right-click the panel \u2192 Presets \u2192 Pink for a wind/surf bed.',
      'LFO bi -> curve for a slowly breathing resonant band.',
      'out -> Filter in, Euclidean ch1 -> ADSR gate for tuned percussion.',
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
      kick_tune:
        'Kick pitch, 1 V/oct around 52 Hz: down for deeper subs, up for ' + 'tighter house thumps.',
      kick_decay: 'Kick decay time, seconds.',
      kick_tone: 'Kick click/attack amount, 0..1.',
      snare_trig: 'Snare trigger (rising edge).',
      snare_tune: 'Snare pitch, 1 V/oct around 185 Hz.',
      snare_decay: 'Snare decay time, seconds.',
      snare_tone: 'Snare snappy (noise) amount, 0..1.',
      hat_trig: 'Hi-hat trigger (rising edge).',
      hat_tune: 'Hi-hat filter pitch, 1 V/oct around 6.5 kHz: down = trashier, up = crisper.',
      hat_decay: 'Hi-hat decay time, seconds.',
      hat_tone: 'Hi-hat tone/brightness, 0..1.',
    },
    outputs: {
      kick: 'The kick voice alone \u2014 give it its own filter, compressor or mixer channel.',
      snare: 'The snare voice alone, for separate processing (reverb sends love snares).',
      hat: 'The hi-hat voice alone.',
      mix:
        'All three voices summed (at -6 dB so simultaneous hits fit the ' +
        'rails) \u2014 the one-cable output when you don\u2019t need per-voice ' +
        'processing.',
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
      in: 'The sound to filter \u2014 an oscillator, drum voice or whole mix.',
      cutoff:
        'Where the filter acts: cutoff frequency as 1 V/oct pitch CV. Sweep ' +
        'it with an envelope or LFO \u2014 this is THE knob on a filter.',
      res: 'Resonance, 0..1 (self-oscillates near the top).',
      drive:
        'Gain into the filter core. In ladder/OTA topologies pushing past 1 ' +
        'saturates, adding grit and compression.',
      topology: 'Filter topology/character select (stepped).',
    },
    outputs: {
      lp:
        'Low-pass: keeps what\u2019s below the cutoff. The classic warm ' +
        'output \u2014 basses, plucks, acid lines.',
      bp: 'Band-pass: keeps a band around the cutoff, cutting lows and highs \u2014 nasal, vocal tones.',
      hp: 'High-pass: keeps what\u2019s above the cutoff \u2014 thins a sound down to its sparkle.',
      notch: 'Notch: cuts a band at the cutoff and passes the rest \u2014 subtle phasey sweeps.',
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
      'in#': 'Channel # signal input, audio or CV.',
      'cv#':
        'Channel # gain CV: 0 V mutes, full scale is unity. Patch an ' + 'envelope or LFO here.',
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
      in: 'The sound to distort; hotter signals hit the curve harder.',
      mode: 'Shaping curve select (stepped).',
      drive: 'Amount of gain into the shaper.',
      bias: 'DC offset added before shaping (asymmetry).',
      level: 'Output trim, 0..2: pull back after heavy drive to keep levels sane downstream.',
    },
    outputs: { out: 'Shaped audio.' },
    examples: ['Oscillator -> in with LFO -> drive for evolving grit.'],
  },
  'com.dj.eq': {
    summary:
      'Four-band parametric EQ: four peaking bells in series, each with ' +
      'frequency (1 V/oct), gain in dB and Q (bandwidth). A band at 0 dB ' +
      'is transparent, so unused bands cost nothing. Drag the handles on ' +
      'the response plot (scroll to change Q), or use the knobs \u2014 ' +
      'both edit the same values. Carve mixes, notch resonances, or ' +
      'modulate a band frequency for wah-like sweeps.',
    inputs: {
      in: 'The sound to equalize \u2014 a single voice or a whole mix.',
      'freq#': 'Band # center frequency (1 V/oct, 0 = C4).',
      'gain#': 'Band # boost/cut in dB (0 = bypass).',
      'q#': 'Band # Q: higher = narrower bell.',
    },
    outputs: { out: 'Equalized audio.' },
    examples: [
      'Mixer -> in, cut 300 Hz mud and boost 3 kHz presence.',
      'LFO -> freq2 with gain2 boosted for a slow wah sweep.',
    ],
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
      threshold:
        'Level (dB) where compression starts: signal above it gets squashed. ' +
        'Lower it to compress more of the signal.',
      ratio:
        'How hard to squash above the threshold, 1..20: 2 is gentle glue, ' +
        '4 punchy drums, 20 is a limiter.',
      attack:
        'How fast the compressor clamps down, seconds: slower lets drum ' +
        'transients punch through before the squash.',
      release:
        'How fast it lets go, seconds: this times the \u201cpumping\u201d ' +
        '\u2014 short is aggressive, long is smooth.',
      knee: 'Soft knee width, dB: widens the onset of compression around the threshold.',
      makeup: 'Output gain, dB: brings the compressed signal back up to level.',
    },
    outputs: {
      out_l: 'Compressed left channel.',
      out_r: 'Compressed right channel.',
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
      'filter cutoff for tone. A playhead dot rides the drawn curve while ' +
      'a gate is open, so you can see which stage the envelope is in; it ' +
      'dims when the envelope retriggers too fast to follow.',
    inputs: {
      gate: 'Gate input: high (>= 1 V) opens the envelope.',
      retrig: 'Trigger: rising edge restarts the attack phase.',
      attack:
        'Attack time, seconds: gate-on to full level. Short = percussive, ' +
        'long = swelling pads.',
      decay: 'Decay time, seconds: the fall from the attack peak down to the sustain level.',
      sustain: 'Sustain level, 0..1 of full scale.',
      release: 'Release time, seconds: the fade-out after the gate falls.',
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
      rate:
        'Speed in Hz when no clock is patched: below 1 Hz for slow drifts, ' +
        'up to audio rate for FM-like effects.',
      shape: 'Waveform select (stepped: sine, tri, saw, square, random...).',
      pw: 'Pulse width / shape skew, 0..1.',
      clock: 'Clock input: rising edges tempo-sync the LFO.',
      ratio: 'Clock-sync ratio (multiply/divide the incoming clock).',
      reset: 'Trigger: resets the LFO phase.',
      phase: 'Phase offset, 0..1 cycles.',
    },
    outputs: {
      bi: 'Bipolar output, +-5 V: swings around zero \u2014 natural for vibrato and panning.',
      uni: 'Unipolar output, 0..+10 V: positive only \u2014 natural for VCA levels and filter opens.',
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
      eor: 'Fires the instant the rise completes \u2014 sequence a second event off the first.',
      eoc:
        'Fires when the fall completes. With cycle on, patch it to another ' +
        'module\u2019s trig for chained self-playing rhythms.',
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
      out: 'The held voltage: steps to a new value on each trigger \u2014 stepped, rhythmic modulation.',
      noise: 'Internal white noise, +-5 V.',
    },
    examples: ['Clock -> trig, out -> Quantizer in for stepped random melodies.'],
  },

  // ---------------------------------------------------- Clock & Sequencing
  'com.dj.clock_mult': {
    summary:
      'Clock multiplier/divider and the rack\u2019s clock source: follows an ' +
      'incoming clock and re-times it by a continuous ratio, -64 to +64 ' +
      'output pulses per input pulse (1x by default). Multiplications are ' +
      'predicted from the last two clock edges, divisions land on the ' +
      'clock\u2019s own edges. With nothing patched in (or before the first ' +
      'edge arrives) it free-runs as if fed a 2 Hz clock, so one on its own ' +
      'is a clock at any tempo.',
    inputs: {
      clock: 'Clock to follow; its rate is measured between the last two rising edges.',
      mult:
        'Ratio: output pulses per input pulse, -64..+64 with any fraction ' +
        'in between (0.5 = every other pulse, 2.5 = five pulses every two). ' +
        'Decimal thirds snap to exact ones and read as 1/3 and 2/3. A ' +
        'negative ratio runs the grid backwards at the same rate; 0 stops it.',
    },
    outputs: { out: 'Trigger stream at the input rate times the selected ratio.' },
    examples: [
      'Clock Multiplier at 3x -> Trigger Sequencer for triplet hats.',
      'Drop one unpatched at 2x for a 4 Hz (240 BPM) clock with no master clock.',
      'Chain a second one at 0.25 off the first for a bar reset.',
    ],
  },
  'com.dj.poisson': {
    summary:
      'Poisson Clock: triggers whose spacing is drawn from a gamma ' +
      'distribution \u2014 a clock with a mean rate but no grid. Rate sets ' +
      'the average events per second; density (k) sets how regular they ' +
      'are: k = 1 is an exact Poisson process (memoryless, exponential ' +
      'gaps), k above 1 tightens toward a steady clock (spread = 1/\u221ak) ' +
      'and k below 1 goes clumpy \u2014 bursts separated by long silences. ' +
      'Patch a clock in and the mean rate follows its tempo, so a whole ' +
      'rack can drift around one pulse.',
    inputs: {
      rate: 'Mean events per second when free-running (0.05..50 Hz).',
      density:
        'Gamma shape k: 1 = Poisson, higher tightens toward a regular ' +
        'clock, lower clumps events into bursts.',
      clock:
        'Clock to take the mean rate from \u2014 one event per incoming ' +
        'pulse on average, measured between its last two rising edges. ' +
        'Wired, it replaces the rate knob.',
    },
    outputs: {
      out: 'Trigger per event (5 ms, shortened so fast events stay separate).',
    },
    examples: [
      'Poisson Clock -> Drum trigger for hand-percussion fills that never repeat.',
      'Clock mul4 -> its clock in, density high -> a hi-hat that breathes instead of marching.',
      'Density low into a Random CV clock for clumped, gestural modulation.',
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
      clock:
        'Advances one step per rising edge \u2014 patch the master clock (or a division) here.',
      reset: 'Trigger: jump back to step 1.',
      length: 'Sequence length, 1..16 steps.',
      dir: 'Play direction (stepped: forward, reverse, pendulum, random).',
      glide: 'Portamento between step CVs, seconds.',
      'cv#': 'CV value for step # (volts; feed the out through a Quantizer for notes).',
      'gate#': 'Gate on/off for step #.',
      'ratchet#': 'Ratchet count for step # (retriggers within the step).',
    },
    outputs: {
      cv:
        'The active step\u2019s CV value \u2014 through a Quantizer into an ' +
        'oscillator pitch is the classic melody path.',
      gate: 'Gate output (high on active steps, ratcheted).',
      cvgate:
        'CV AND gate: the step CV while the gate is high, 0 V otherwise \u2014 a one-wire melody.',
      eos: 'End-of-sequence trigger.',
      step: 'Playhead position as a rising CV \u2014 drive a second module in lockstep.',
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
      'trig#':
        'Fires on track #\u2019s active steps \u2014 patch to drum triggers or envelope gates.',
      pos: 'Current step position as CV.',
    },
    examples: ['trig1/trig2/trig3 -> Drum kick_trig/snare_trig/hat_trig.'],
  },
  'com.dj.grid_seq': {
    summary:
      '8x16 grid sequencer: click cells on the panel grid to turn them ' +
      'on/off; shift+click a cell to add ratchets (cycles 1\u20134 retriggers ' +
      'within the column, shown as a number on the cell). When the playhead ' +
      'reaches a column, every on row emits on its output. In gate mode all ' +
      'rows emit the level voltage (10 V by default) \u2014 an instant drum ' +
      'machine. In scale mode each row is a note on a C major scale ' +
      '(row 1 = C4, ascending to the octave), so the grid becomes a ' +
      'piano-roll melody writer.',
    inputs: {
      clock: 'Advances the playhead one column per rising edge.',
      reset: 'Trigger: back to column 1.',
      'row#': 'Row # pattern (bitmask driven by the panel grid).',
      'rata#':
        'Row # ratchet bitplane A (with plane B: cell ratchet count = 1 + A + 2B, set by shift+click).',
      'ratb#': 'Row # ratchet bitplane B (see rata#).',
      level: 'Output voltage of an on cell in gate mode (default 10 V).',
      mode: 'gate: rows emit level volts. scale: rows emit C-major pitches, 1 V/oct.',
    },
    outputs: {
      'out#': 'Row #\u2019s output \u2014 level volts (gate) or its scale pitch (scale).',
      pos: 'Current column position as CV.',
    },
    examples: [
      'Gate mode: out1/out2/out3 -> Drum kick_trig/snare_trig/hat_trig.',
      'Scale mode: sum rows through a Mult into an Oscillator pitch for grid melodies.',
    ],
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
      clock: 'Advances all channels one step per rising edge.',
      reset: 'Trigger: back to step 1 on all channels.',
      'steps#': 'Channel # pattern length, 1..32.',
      'fill#': 'Channel # number of hits distributed across the steps.',
      'rot#': 'Channel # pattern rotation.',
    },
    outputs: {
      'ch#': 'Channel #\u2019s Euclidean pattern as triggers \u2014 patch to drums or envelopes.',
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
      clock: 'Advances the register one step per rising edge.',
      prob: 'Mutation probability, 0..1 (0 = locked loop).',
      length: 'Loop length in steps.',
      range: 'CV output range scaling.',
      scale: 'Quantizer scale for the quant output.',
      root: 'Quantizer root note.',
    },
    outputs: {
      cv: 'The looping random voltage, unquantized \u2014 modulation that repeats and mutates.',
      bit1: 'One register bit as a gate: a looping random rhythm that mutates with prob.',
      bit2: 'Another register bit as a gate \u2014 a related but different rhythm to bit1.',
      quant: 'Quantized CV output (scale/root).',
      reg: 'The whole register read as one stepped CV, wider-ranging than cv.',
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
      clock: 'Advances to the next step per rising edge.',
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
      feedback:
        'How much of each repeat is fed back, 0..1: 0 is a single echo, ' +
        'near 1 endless dub tails.',
      lowpass: 'Feedback-path low-pass cutoff, Hz (darkens repeats).',
      highpass: 'Feedback-path high-pass cutoff, Hz (thins repeats).',
      mix: 'Dry/wet mix, 0..1.',
      pingpong: 'Switch: alternate repeats left/right.',
    },
    outputs: {
      out_l: 'Delayed left channel (includes the dry signal per mix).',
      out_r: 'Delayed right channel.',
    },
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
      size: 'Room size: small for tight ambience, large for halls and washes.',
      decay: 'How long the tail rings: turn up for ambient washes, down for drum rooms.',
      damping: 'High-frequency damping in the tail.',
      diffusion: 'Echo density: low is grainy early reflections, high a smooth wash.',
      freeze: 'Switch: infinitely sustain the current tail.',
      mix: 'Dry/wet mix, 0..1.',
    },
    outputs: {
      out_l: 'Reverberated left channel (includes the dry signal per mix).',
      out_r: 'Reverberated right channel.',
    },
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
      density: 'Grains per second: sparse pointillism at low values, a smooth cloud at high.',
      size: 'Grain length: short is buzzy and granular, long smears into texture.',
      position: 'Playback position within the buffer, 0..1.',
      pitch: 'Grain pitch shift, volts (1 V/oct).',
      texture: 'Grain envelope shape.',
      spread: 'Stereo spread of grains, 0..1.',
      feedback: 'Output-to-buffer feedback, 0..1.',
      freeze: 'Switch: stop recording, granulate the held buffer.',
      trig: 'Trigger: spawn a grain manually.',
      mix: 'Dry/wet mix, 0..1.',
    },
    outputs: {
      out_l: 'Granulated left channel (includes the dry signal per mix).',
      out_r: 'Granulated right channel.',
    },
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
      depth: 'Modulation depth: how far the sweep travels \u2014 subtle shimmer to full whoosh.',
      feedback: 'Feedback/resonance amount.',
      spread: 'Stereo phase spread of the modulation.',
      through_zero: 'Switch: through-zero flanging.',
      mix: 'Dry/wet mix, 0..1.',
    },
    outputs: {
      out_l: 'Processed left channel (includes the dry signal per mix).',
      out_r: 'Processed right channel.',
    },
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
      damping: 'How fast partials fade: low rings like a bell, high chokes like palm muting.',
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
      'Six-channel stereo mixer with per-channel level, pan, mute and ' +
      'solo plus a master level. Each channel is an L/R pair; leave R ' +
      'unpatched and it mirrors L, so a mono source pans across the ' +
      'stereo field. Solo follows the console law — the moment any ' +
      'channel is soloed the rest go quiet — while mute stands on its ' +
      'own, so a muted channel stays silent even when soloed. Good for ' +
      'summing a multi-oscillator stack into one fat voice, balancing a ' +
      'few parts into a stereo submix, or auditioning one part alone.',
    inputs: {
      'in#_l': 'Channel # left input (audio).',
      'in#_r': 'Channel # right input (audio; mirrors L when unpatched).',
      'lvl#': 'Channel # level fader, 0..10 (10 = unity).',
      'pan#': 'Channel # pan/balance, -10 (left) .. +10 (right).',
      'mute#': 'Channel # mute: on (or a gate >= 1 V) silences it.',
      'solo#':
        'Channel # solo: while any solo is on, only soloed (and ' + 'un-muted) channels are heard.',
      master: 'Master output level.',
    },
    outputs: {
      out_l: 'Left mix output.',
      out_r: 'Right mix output.',
    },
    examples: [
      'Sum a three-oscillator stack before one Filter.',
      'Pan two voices apart for instant stereo width.',
      'Solo one channel to audition a part, or gate a mute from an LFO ' +
        'square for rhythmic drop-outs.',
    ],
  },
  'com.dj.alias': {
    summary:
      'A nameable pass-through: one input, one output, audio bit-identical. ' +
      'Double-click the title to rename it, then drop it inline to label a ' +
      'signal — "kick bus", "to filter" — or park it as a named patch point ' +
      'so long wires read like a schematic. It never changes the sound.',
    inputs: { in: 'Signal input (any signal: audio, CV, gates).' },
    outputs: { out: 'The input, passed through unchanged.' },
    examples: [
      'Name the drum submix "kick bus" where three wires converge.',
      'Park one at the rack edge as a labelled patch point for a send.',
    ],
  },
  'com.dj.attenuverter1': {
    summary:
      'Single-channel attenuverter/offset: scales its input by -1..+1 ' +
      '(inverting below zero) and adds a DC offset — the one-column ' +
      'version of the Attenuverter 8 for when a patch needs just one ' +
      'channel. Unpatched, it outputs just the offset, making it a ' +
      'compact manual CV source too.',
    inputs: {
      in: 'Signal input.',
      atten: 'Gain, -1..+1 (negative inverts).',
      offset: 'DC offset, volts.',
    },
    outputs: { out: 'Output: in x atten + offset.' },
    examples: [
      'Tame an LFO to +-1 V before a pitch input.',
      'Leave in unpatched and use offset as a manual CV source.',
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
      hysteresis:
        'How far the signal must swing to close one cycle of the pitch ' +
        'detector, as a FRACTION of the measured peak (not volts), so one ' +
        'setting works at any level. Turn it down and bright harmonics ' +
        'wiggling around the zero crossing get counted as cycles \u2014 the ' +
        'reading jumps an octave (or two) high; turn it up and quiet or ' +
        'decaying cycles never reach it \u2014 the reading drops an octave ' +
        'or stops voicing. 0.15 suits most tones; raise it for a noisy or ' +
        'harmonically rich source, lower it for a soft sine. It only ' +
        'affects pitch/hz/trig \u2014 never peak, rms or thru.',
      window:
        'Time constant of the peak and rms level followers, in seconds: ' +
        'peak jumps to a new maximum instantly and falls back over this ' +
        'time, rms averages over it. Short (5\u201320 ms) reads individual ' +
        'hits \u2014 a kick becomes a spike worth triggering off; long ' +
        '(0.2\u20130.5 s) reads loudness \u2014 the smooth envelope you ' +
        'would duck a bassline with. It is not a buffer length: the ' +
        'displayed waveform and spectrum always come from the last 43 ms ' +
        'the engine captured, and the pitch detector ignores it entirely.',
      bins:
        'How many log-spaced bars the panel\u2019s spectrum is drawn with ' +
        '(16\u2013144, in steps of 8). Fewer, wider bars read like a ' +
        'graphic-EQ display; more, narrower ones separate partials that ' +
        'sit close together. Purely a display control \u2014 no jack\u2019s ' +
        'value changes with it \u2014 and the underlying FFT stays at 1024 ' +
        'bins (~23 Hz apart), so past ~64 bars the bottom octaves run out ' +
        'of resolution and neighbouring bars start reading the same bin.',
    },
    outputs: {
      thru: 'Unchanged copy of in.',
      pitch:
        'Detected pitch as CV (1 V/oct), held at its last reading while ' +
        'the input has no pitch.',
      hz:
        'Detected frequency, Hz-scaled CV (1 V per 100 Hz) \u2014 0 V when ' +
        'the input has no fundamental to report, e.g. noise or silence.',
      peak:
        'Peak level of the input as a CV: it jumps to every new maximum ' +
        'and falls back over the window time \u2014 spikes on transients, ' +
        'good for triggering off hits.',
      rms:
        'Average loudness (RMS) of the input over the window, as a smooth ' +
        'CV \u2014 an envelope follower: wire it (inverted) into a VCA to ' +
        'duck other signals with the music.',
      trig:
        'A 1 ms pulse at the start of every detected period \u2014 a sync ' +
        'trigger at the input\u2019s own frequency, silent while there is ' +
        'no pitch to lock to.',
    },
    examples: [
      'Sit inline after an oscillator to watch the waveform while patching.',
      'Spectrum view with bins at 144: see an FM pair\u2019s sidebands as separate bars.',
    ],
  },
  'com.dj.camera': {
    summary:
      'Live webcam monitor panel. The video preview is pure app-layer ' +
      '(getUserMedia); the module has no jacks — it exists to host the ' +
      'panel. The camera and hand tracking start automatically ' +
      'when the module loads (per-session, never saved in the patch \u2014 ' +
      'switching either off sticks for the session). Hand ' +
      'tracking (MediaPipe, fully local — no network) draws both hands\u2019 ' +
      'landmark skeletons over the mirrored feed with fingertips and L/R ' +
      'labels highlighted; the overlay and a diagnostics readout (fps, ' +
      'inference cost, latency, active delegate) are toggleable. Good for ' +
      'streaming and recorded performances: keep your framing in view, or ' +
      'watch your hands while learning controller moves.',
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
      mute: 'Kill switch: while on (>= 1 V), this output mixes nothing to the device.',
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
  'builtin.launchcontrol': {
    summary:
      'The Novation Launch Control XL as CV: eight columns matching the ' +
      'surface, each with three knobs (send A, send B, pan), a mixer-style ' +
      'fader and two buttons. Knobs and faders read 0..+10 V (fader down = ' +
      '0 V); the buttons are gates, 10 V while held. The panel light shows ' +
      'whether the controller is plugged in, and Active decides which ' +
      'module it drives \u2014 only one at a time, so several of these can ' +
      'sit on the rack as saved control layouts and you hand the surface ' +
      'to whichever one you are playing. Values hold when the controller ' +
      'goes away, so unplugging never jumps the patch. The panel is a ' +
      'picture of the surface: every jack wears a live dial, fader cap or ' +
      'lit pad, so you can see where the hardware is standing without ' +
      'looking down. Wiring one of these outputs sets the input it lands ' +
      'on to Override, not CV \u2014 the physical control IS the value, so ' +
      'the knob it is wired to goes inert and follows the surface ' +
      '(right-click that input and set Wire mode back to CV to have the ' +
      'surface add to the knob instead).',
    outputs: {
      'c#_a': 'Column #, top knob (Send A), 0..+10 V.',
      'c#_b': 'Column #, middle knob (Send B), 0..+10 V.',
      'c#_pan': 'Column #, bottom knob (Pan/Device), 0..+10 V.',
      'c#_fader': 'Column #, fader: 0 V down, +10 V up.',
      'c#_focus': 'Column #, upper button: 10 V while held.',
      'c#_ctrl': 'Column #, lower button: 10 V while held.',
    },
    params: {
      active: 'Which module the controller drives (exclusive; the panel button).',
    },
    examples: [
      'c1_fader -> Mixer lvl1: real faders on a six-channel mix.',
      'c1_a -> Filter cutoff, c1_b -> resonance: a knob per column, a voice per column.',
      'c1_focus -> ADSR gate for finger-drumming; c1_ctrl -> sequencer reset.',
    ],
  },
  'builtin.qwerty': {
    summary:
      'The computer keyboard as a gate source: one output jack per ' +
      'alphanumeric key plus the space bar, arranged like the physical ' +
      'QWERTY rows. Holding a key holds its jack at 10 V; releasing ' +
      'drops it to 0 V (typing into text fields and app shortcuts with ' +
      'cmd/ctrl are ignored). The shared note output turns the keyboard ' +
      'into a melodic instrument: each key has its own pitch (semitones ' +
      'ascending left to right, bottom row to top; space is the lowest ' +
      'note) and the CV holds the last key pressed, while the gate ' +
      'output is high whenever any key is down. No hardware needed: ' +
      'trigger envelopes, drums and sequencer resets straight from the ' +
      'keys under your fingers.',
    outputs: {
      '#': 'Gate: 10 V while the number-row key is held.',
      space: 'Gate: 10 V while the space bar is held.',
      note: 'Pitch CV (1 V/oct) of the last key pressed; holds until the next press.',
      gate: '10 V while any key is held; falls when the last key is released.',
    },
    examples: [
      'note -> Oscillator pitch and space -> ADSR gate: play the keyboard like a mono synth.',
      'z/x/c -> drum trig inputs for finger-drumming a beat.',
      'q -> sequencer reset: tap to restart the pattern on the downbeat.',
    ],
  },
  'builtin.choreo': {
    summary:
      'A beat-indexed multi-track timeline for choreographing a whole ' +
      'song: hundreds or thousands of beats, advanced one beat per clock ' +
      'rising edge. Each named track is an output jack. Boolean tracks ' +
      'emit 0/10 V gates; continuous tracks draw a \u221210..+10 V curve ' +
      'interpolated between beats; note tracks are a monophonic scale ' +
      'grid (1\u20133 octaves, selectable scale and base note) with two ' +
      'jacks \u2014 1 V/oct pitch and a 0\u201310 V velocity gate. Click ' +
      'cells to toggle, cmd/ctrl+click a note to set velocity, drag the ' +
      'handle to reorder tracks.',
    inputs: {
      clock: 'Rising edge advances one beat (wraps at the end).',
      reset: 'Rising edge re-arms; the next clock plays beat 1.',
    },
    outputs: {
      't#': "A track's value; note tracks also own the next slot for velocity.",
    },
    examples: [
      'Clock \u2192 choreo; note track pitch \u2192 oscillator, velocity \u2192 VCA cv.',
      'A continuous track wired to filter cutoff sweeps builds across the song.',
    ],
  },
  'builtin.hands': {
    summary:
      'Hand-tracking CV outputs, fed by the Camera module\u2019s tracker ' +
      '(which starts automatically): every Hands module in the rack ' +
      'receives the landmarks. Positions are engine-space (mirror ' +
      'view, X right, Y up, center origin) scaled to 0\u201310 V ' +
      '(frame-center = 5 V). Visibility ' +
      'changes are debounced over two frames, so one glitchy frame ' +
      'doesn\u2019t thrash the outputs; when a hand really leaves the ' +
      'frame its values decay to 0 V over 10 ms while its seen-gate drops. ' +
      'Pinch is scale-invariant (thumb\u2013index distance over palm span, ' +
      '0 V touching to ~6 V spread); rotation is the thumb\u2019s signed ' +
      'angle off the palm axis \u2014 flared out is positive for both hands.',
    outputs: {
      cx: 'Centroid X over all visible hands, 0\u201310 V (center = 5 V).',
      cy: 'Centroid Y over all visible hands, 0\u201310 V (center = 5 V).',
      lx: 'Left-hand centroid X, 0\u201310 V (center = 5 V).',
      ly: 'Left-hand centroid Y, 0\u201310 V (center = 5 V).',
      rx: 'Right-hand centroid X, 0\u201310 V (center = 5 V).',
      ry: 'Right-hand centroid Y, 0\u201310 V (center = 5 V).',
      dx: 'Right minus left centroid X, \u00b110 V.',
      dy: 'Right minus left centroid Y, \u00b110 V.',
      l_pinch: 'Left thumb\u2013forefinger pinch, scale-invariant, 0\u201310 V.',
      r_pinch: 'Right thumb\u2013forefinger pinch, scale-invariant, 0\u201310 V.',
      l_rot: 'Left thumb rotation: out is positive, tucked negative, \u00b110 V.',
      r_rot: 'Right thumb rotation: out is positive, tucked negative, \u00b110 V.',
      l_seen: 'Gate: 10 V while the left hand is tracked.',
      r_seen: 'Gate: 10 V while the right hand is tracked.',
    },
    examples: [
      'Wire r_pinch to a filter cutoff and play it like a theremin.',
      'dx between your hands into an LFO rate: spread arms = faster wobble.',
      'Gate a delay send with l_seen so echoes only run while your hand is up.',
    ],
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
  'builtin.audio': {
    summary:
      'Plays any track from the library and runs a beat clock at its ' +
      'tempo. BPM and speed are one tempo in two units: moving either ' +
      'moves the other, so pushing the BPM up plays the track faster and ' +
      'the clock stays locked to what you hear. Loading a track takes the ' +
      'BPM the library analysed and sets speed back to 1x. The panel ' +
      'shows the track as a waveform with a playhead, and the track ' +
      'loops until you switch looping off.',
    inputs: {
      play: 'Play/pause switch (rising edge restarts a finished track).',
      bpm: 'Clock tempo in BPM; drags the speed control with it.',
      speed: 'Playback rate, 1x = the file\u2019s own tempo; drags BPM with it.',
      loop: 'Repeat the track at its end (on by default); the clock restarts each pass.',
    },
    outputs: {
      audio_l: 'Left audio.',
      audio_r: 'Right audio.',
      clock: 'Trigger per beat at the BPM tempo (free-running while paused).',
    },
    examples: [
      'clock -> Step Sequencer clock: the pattern locks to the loaded track.',
      'audio_l/audio_r -> Audio Output; ride the BPM control to tempo-match a jam.',
    ],
  },
  'builtin.decks': {
    summary:
      'Eight Beatify clips on one clock \u2014 the bank behind the Decks ' +
      'tab. Every slot is stretched to the bank\u2019s tempo (not sped ' +
      'up, so nothing changes pitch) and started on the shared grid, so a ' +
      'two-beat clip and an eight-beat clip come round on the same beat. ' +
      'A slot arrives muted, with a level, three tone controls, mute and ' +
      'monitor \u2014 the same six controls a Launch Control XL column ' +
      'carries, which is what the surface drives when Follow is on. A ' +
      'monitored deck leaves the live mix for the monitor pair, which the ' +
      'app plays out of its own device: it is a cue, so nothing else ' +
      'changes. Queue and Drop are the mute taken on the grid: a queued ' +
      'deck starts the next time its clip\u2019s own first beat comes ' +
      'round \u2014 always from the top of its loop \u2014 a dropped one ' +
      'plays its clip out first, and pressing again takes the arm back. ' +
      'Beats ' +
      'of silence can be hung on the end of a clip and the whole clip ' +
      'shifted a beat at a time, both on that same grid. Load clips on the ' +
      'Decks tab; the bank is an ordinary module, so it keeps playing ' +
      'wherever you are. The rack is the bank\u2019s effects loop: each ' +
      'deck has a SEND pair that always carries its audio, a RETURN pair ' +
      'that \u2014 once wired \u2014 makes whatever sits between them that ' +
      'deck\u2019s insert (its own path leaves the mix, so nothing is ' +
      'heard twice), and a CV output under each tone control. Patching a ' +
      'tone CV takes that band OFF the deck (it sits flat) and the knob ' +
      'drives the rack instead. On the Decks tab all of these sit on the ' +
      'deck strips themselves.',
    inputs: {
      bpm: 'Tempo of the whole bank \u2014 every slot is stretched to it.',
      reset: 'Park the bank on beat 0.',
      'd#_in_l':
        'Deck # return, left: wire the deck\u2019s send back in here and ' +
        'the modules in between become its insert.',
      'd#_in_r': 'Deck # return, right.',
    },
    outputs: {
      audio_l: 'Left of the live bank mix, at the live master\u2019s level.',
      audio_r: 'Right of the live bank mix.',
      mon_l:
        'Left of the cue mix \u2014 the decks switched to Monitor, at the ' +
        'monitor master\u2019s level.',
      mon_r: 'Right of the cue mix \u2014 the decks switched to Monitor.',
      clock: 'One pulse per beat of the bank\u2019s own clock.',
      'd#_l': 'Deck # send, left \u2014 always carries the deck\u2019s audio.',
      'd#_r': 'Deck # send, right.',
      'd#_high':
        'Deck #\u2019s HIGH knob as CV. Patched, the knob leaves the ' +
        'band (it sits flat) and drives the rack instead.',
      'd#_mid': 'Deck #\u2019s MID knob as CV (patched = the band sits flat).',
      'd#_low': 'Deck #\u2019s LOW knob as CV (patched = the band sits flat).',
    },
    params: {
      surface:
        'Whether this bank follows the Launch Control XL: one column per ' +
        'slot, knobs high/mid/low, fader level, buttons mute and monitor.',
    },
    examples: [
      'audio_l/audio_r -> Audio Output: the eight decks as one mix.',
      'd1_l/d1_r -> Resonator -> d1_in_l/d1_in_r: the resonator is deck 1\u2019s insert.',
      'd1_low -> VCA cv: deck 1\u2019s LOW knob rides a rack level instead of its band.',
      'clock -> Step Sequencer clock: the rack runs on the bank\u2019s beat.',
      'Step Sequencer trigger -> reset: drop the whole bank back on cue.',
    ],
  },
  'builtin.beat_clip': {
    summary:
      'Plays a clip built in the Beatify tab, locked to a clock. Import ' +
      'one from the Clips tab of the module picker and the module arrives ' +
      'loaded with that clip and the tempo its project is laid out at. ' +
      'The clock does the rest: the gap between its last two ticks is the ' +
      'beat, so the clip runs at whatever tempo the patch is running at ' +
      '\u2014 stretched, not sped up, so its pitch stays put \u2014 and ' +
      'every tick re-anchors the phase: the clip starts ON a tick and ' +
      'comes back around on one, never in between. It waits for two ticks ' +
      'before the first sound, since one tick cannot say how fast to go. ' +
      'Reset parks it at beat 0 to wait for the next tick.',
    inputs: {
      clock: 'A rising edge is a beat: it sets the tempo and the phase.',
      reset: 'Back to beat 0, silent until the next clock edge.',
      bpm: 'Tempo the clip was rendered at \u2014 what one of its beats means.',
    },
    outputs: { audio_l: 'Left audio.', audio_r: 'Right audio.' },
    examples: [
      'Clock -> clock: every clip in the rack rides one tempo.',
      'Step Sequencer trigger -> reset: drop the clip back to its head on cue.',
    ],
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
