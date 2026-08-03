//! Frame source abstraction: where video frames come from.
//!
//! The gesture pipeline is camera-agnostic: on macOS a real
//! AVFoundation/nokhwa-backed source slots in behind this trait; in tests
//! and headless environments [`crate::TraceFrameSource`] renders synthetic
//! frames from recorded pose-trace fixtures.

use anyhow::Result;

/// One RGB frame (8-bit interleaved, `width * height * 3` bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl Frame {
    pub fn new(width: u32, height: u32) -> Frame {
        Frame {
            width,
            height,
            rgb: vec![0; (width * height * 3) as usize],
        }
    }

    #[inline]
    pub fn put_pixel(&mut self, x: u32, y: u32, rgb: [u8; 3]) {
        if x < self.width && y < self.height {
            let i = ((y * self.width + x) * 3) as usize;
            self.rgb[i..i + 3].copy_from_slice(&rgb);
        }
    }
}

/// Produces frames at a nominal rate. `next_frame` returning `Ok(None)`
/// means the source is exhausted (end of a recorded fixture) or a frame was
/// dropped; live sources block or return the newest frame.
pub trait FrameSource: Send {
    fn fps(&self) -> f32;
    fn next_frame(&mut self) -> Result<Option<Frame>>;
}
