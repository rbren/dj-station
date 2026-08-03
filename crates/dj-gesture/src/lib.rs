//! Gesture control pipeline (PRD §7.3, milestone M5).
//!
//! Webcam frames become control signals in three stages, all off the RT
//! thread:
//!
//! 1. A [`FrameSource`] produces RGB frames. On macOS this will be the
//!    AVFoundation camera; in tests/headless environments it is
//!    [`TraceFrameSource`], which renders synthetic frames from recorded
//!    pose-trace fixtures (small JSON files checked into the test tree).
//! 2. A [`HandDetector`] turns a frame into a [`Detection`]: per-hand named
//!    landmarks (`L.index.tip`, `R.thumb.tip`, ... — the 21-point
//!    MediaPipe-Hands topology). The tested default is the deterministic
//!    [`MarkerDetector`]; a MediaPipe-Hands-class ONNX model is plumbed in
//!    behind `--features onnx` (see [`onnx`]).
//! 3. A [`GestureProcessor`] evaluates the module's mappings against each
//!    detection through an extensible [`ModeRegistry`] (Wheel and Landmark
//!    modes ship first) and emits per-mapping output values, which the
//!    engine ships to the RT graph over the same lock-free path as MIDI.

pub mod detect;
pub mod fixtures;
pub mod frame;
pub mod landmark;
pub mod marker;
pub mod mode;
pub mod modes;
#[cfg(feature = "onnx")]
pub mod onnx;
pub mod processor;
pub mod trace;
pub mod wheel;

pub use detect::{Detection, Hand, HandDetector, Point};
pub use frame::{Frame, FrameSource};
pub use landmark::{landmark_index, parse_point_name, point_name, Handedness, N_LANDMARKS};
pub use marker::MarkerDetector;
pub use mode::{GestureMode, MappingEval, ModeCtx, ModeRegistry};
pub use modes::{LandmarkMode, WheelMode};
pub use processor::{GestureProcessor, MappingDef, MAX_MAPPINGS};
pub use trace::{PoseTrace, TraceFrame, TraceFrameSource, TraceHand};
pub use wheel::{Wheel, WheelLayout, ZONES_PER_WHEEL};

/// Gate output level (§4 conventions, matching MIDI note gates): high is
/// 10.0, low is 0.0 (high ≥ 1.0 per the host convention).
pub const GATE_HIGH: f32 = 10.0;
