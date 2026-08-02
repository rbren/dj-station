//! Host-side module interface: what the graph executor calls per block.

/// A module instance as hosted by the engine (WASM or built-in native).
///
/// `process` runs on the RT thread: implementations must not allocate,
/// block, or perform syscalls.
pub trait HostModule: Send {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        connected_mask: u64,
        frames: usize,
    );

    fn on_param(&mut self, _index: u32, _value: f32) {}

    /// Serialize state for hot reload / persistence. Allocates; only called
    /// during swaps (tolerated glitch window) or off the RT thread.
    fn save_state(&mut self) -> Vec<u8> {
        Vec::new()
    }

    fn load_state(&mut self, _bytes: &[u8]) {}

    /// Downcasting hook (used by the executor for built-in modules).
    fn as_any(&self) -> &dyn std::any::Any;
}
