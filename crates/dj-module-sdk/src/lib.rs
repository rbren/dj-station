//! dj-module-sdk: write dj-station DSP modules in safe Rust.
//!
//! Implement [`Module`] and call [`export_module!`] once. The macro generates
//! the raw `wasm-1` ABI exports the host calls:
//!
//! - `mod_new(sample_rate: f32, block_size: u32)`
//! - `mod_in_ptr() -> *const f32` (contiguous `n_inputs * block_size` f32)
//! - `mod_out_ptr() -> *mut f32` (contiguous `n_outputs * block_size` f32)
//! - `mod_process(frames: u32, connected_mask: u64)`
//! - `mod_on_param(index: u32, value: f32)`
//! - `mod_save() -> u32` (state written to `mod_state_ptr()`, returns length)
//! - `mod_load(len: u32)` (state read from `mod_state_ptr()`)
//! - `mod_state_ptr() -> *mut u8`, `mod_state_capacity() -> u32`

/// Host-provided context at instantiation time.
#[derive(Clone, Copy, Debug)]
pub struct InitCtx {
    pub sample_rate: f32,
    pub block_size: usize,
}

/// Bitmask of which input jacks currently have wires plugged in.
#[derive(Clone, Copy, Debug, Default)]
pub struct InputMask(pub u64);

impl InputMask {
    #[inline]
    pub fn is_connected(&self, input: usize) -> bool {
        self.0 & (1u64 << input) != 0
    }
}

/// Per-block IO passed to [`Module::process`]. Called on the RT thread:
/// no allocation, no blocking, no syscalls.
pub struct ProcessIo<'a> {
    pub inputs: &'a [&'a [f32]],
    pub outputs: &'a mut [&'a mut [f32]],
    pub connected_inputs: InputMask,
}

/// The module trait as seen by extension authors (PRD §5.2).
pub trait Module: Sized {
    const N_INPUTS: usize;
    const N_OUTPUTS: usize;

    fn new(ctx: &InitCtx) -> Self;
    fn process(&mut self, io: &mut ProcessIo);
    fn on_param(&mut self, _index: u32, _value: f32) {}
    /// Serialize internal state for hot reload / patch save.
    fn save_state(&self) -> Vec<u8> {
        Vec::new()
    }
    fn load_state(&mut self, _bytes: &[u8]) {}
}

/// Convert a pitch value (1 unit/octave, 0.0 = C4) to Hz (PRD §4).
#[inline]
pub fn pitch_to_hz(v: f32) -> f32 {
    261.626 * (2.0f32).powf(v)
}

pub const GATE_HIGH: f32 = 1.0;

/// Runtime holder used by the generated exports. Public for macro use only.
#[doc(hidden)]
pub struct Runtime<M: Module> {
    pub module: M,
    pub block_size: usize,
    pub in_buf: Vec<f32>,
    pub out_buf: Vec<f32>,
    pub state_buf: Vec<u8>,
}

#[doc(hidden)]
pub const STATE_CAPACITY: usize = 64 * 1024;

impl<M: Module> Runtime<M> {
    pub fn new(sample_rate: f32, block_size: usize) -> Self {
        let ctx = InitCtx {
            sample_rate,
            block_size,
        };
        Runtime {
            module: M::new(&ctx),
            block_size,
            in_buf: vec![0.0; M::N_INPUTS * block_size],
            out_buf: vec![0.0; M::N_OUTPUTS * block_size],
            state_buf: vec![0u8; STATE_CAPACITY],
        }
    }

    pub fn process(&mut self, frames: usize, mask: u64) {
        let frames = frames.min(self.block_size);
        // Build fixed-size slice tables on the stack (max 64 jacks).
        let mut ins: [&[f32]; 64] = [&[]; 64];
        for (i, slot) in ins.iter_mut().enumerate().take(M::N_INPUTS) {
            let start = i * self.block_size;
            *slot = &self.in_buf[start..start + frames];
        }
        // Split out_buf into per-jack mutable slices.
        let mut outs: [&mut [f32]; 64] = [(); 64].map(|_| &mut [] as &mut [f32]);
        let mut rest: &mut [f32] = &mut self.out_buf;
        for o in outs.iter_mut().take(M::N_OUTPUTS) {
            let (head, tail) = rest.split_at_mut(self.block_size);
            *o = &mut head[..frames];
            // Safety: extend lifetime within this call frame only.
            rest = unsafe { core::mem::transmute::<&mut [f32], &mut [f32]>(tail) };
        }
        let mut io = ProcessIo {
            inputs: &ins[..M::N_INPUTS],
            outputs: &mut outs[..M::N_OUTPUTS],
            connected_inputs: InputMask(mask),
        };
        self.module.process(&mut io);
    }
}

// ---------------------------------------------------------------------------
// native-1 ABI (PRD §5.2 native escape hatch)
// ---------------------------------------------------------------------------

/// Version of the `native-1` C ABI. The host refuses to load a dylib whose
/// vtable reports a different version.
pub const NATIVE_ABI_VERSION: u32 = 1;

/// Name of the versioned entry symbol a `native-1` dylib must export:
/// `extern "C" fn() -> *const NativeVTableV1`.
pub const NATIVE_ENTRY_SYMBOL: &str = "dj_module_entry_v1";

/// The `native-1` ABI vtable. C layout so the host never sees Rust types
/// across the dylib boundary (PRD §5.2). All function pointers are called
/// by the host; `process` runs on the RT thread and must not allocate,
/// block, or perform syscalls (honor system — native modules are trusted,
/// unsandboxed code).
#[repr(C)]
pub struct NativeVTableV1 {
    /// Must equal [`NATIVE_ABI_VERSION`].
    pub abi_version: u32,
    /// Create an instance. Returns an opaque handle (never null on success).
    pub create: unsafe extern "C" fn(sample_rate: f32, block_size: u32) -> *mut core::ffi::c_void,
    pub destroy: unsafe extern "C" fn(inst: *mut core::ffi::c_void),
    /// Per-block processing. `inputs`/`outputs` are arrays of channel
    /// pointers (`n_inputs`/`n_outputs` entries, each `frames` samples).
    pub process: unsafe extern "C" fn(
        inst: *mut core::ffi::c_void,
        inputs: *const *const f32,
        n_inputs: u32,
        outputs: *const *mut f32,
        n_outputs: u32,
        frames: u32,
        connected_mask: u64,
    ),
    pub on_param: unsafe extern "C" fn(inst: *mut core::ffi::c_void, index: u32, value: f32),
    /// Serialize state into `buf` (capacity `cap`); returns bytes written.
    pub save: unsafe extern "C" fn(inst: *mut core::ffi::c_void, buf: *mut u8, cap: u32) -> u32,
    pub load: unsafe extern "C" fn(inst: *mut core::ffi::c_void, buf: *const u8, len: u32),
}

// SAFETY: the vtable is a set of stateless function pointers.
unsafe impl Sync for NativeVTableV1 {}

/// Instance holder used by [`export_native_module!`]. Public for macro use.
#[doc(hidden)]
pub struct NativeInstance<M: Module> {
    pub module: M,
    pub block_size: usize,
}

/// Generate the `native-1` ABI exports (a versioned vtable behind
/// `dj_module_entry_v1`) for a [`Module`] implementation. Build the crate
/// as a `cdylib`.
#[macro_export]
macro_rules! export_native_module {
    ($ty:ty) => {
        #[doc(hidden)]
        mod __dj_native_module_exports {
            use super::*;
            use core::ffi::c_void;

            unsafe extern "C" fn create(sample_rate: f32, block_size: u32) -> *mut c_void {
                let ctx = $crate::InitCtx {
                    sample_rate,
                    block_size: block_size as usize,
                };
                let inst = Box::new($crate::NativeInstance::<$ty> {
                    module: <$ty as $crate::Module>::new(&ctx),
                    block_size: block_size as usize,
                });
                Box::into_raw(inst) as *mut c_void
            }

            unsafe extern "C" fn destroy(inst: *mut c_void) {
                if !inst.is_null() {
                    drop(unsafe { Box::from_raw(inst as *mut $crate::NativeInstance<$ty>) });
                }
            }

            unsafe extern "C" fn process(
                inst: *mut c_void,
                inputs: *const *const f32,
                n_inputs: u32,
                outputs: *const *mut f32,
                n_outputs: u32,
                frames: u32,
                connected_mask: u64,
            ) {
                let inst = unsafe { &mut *(inst as *mut $crate::NativeInstance<$ty>) };
                let frames = (frames as usize).min(inst.block_size);
                let n_in = (n_inputs as usize).min(<$ty as $crate::Module>::N_INPUTS);
                let n_out = (n_outputs as usize).min(<$ty as $crate::Module>::N_OUTPUTS);
                // Fixed-size slice tables on the stack (max 64 jacks) —
                // no allocation on the RT path.
                let mut ins: [&[f32]; 64] = [&[]; 64];
                for i in 0..n_in {
                    let p = unsafe { *inputs.add(i) };
                    ins[i] = unsafe { core::slice::from_raw_parts(p, frames) };
                }
                let mut outs: [&mut [f32]; 64] = [(); 64].map(|_| &mut [] as &mut [f32]);
                for (o, slot) in outs.iter_mut().enumerate().take(n_out) {
                    let p = unsafe { *outputs.add(o) };
                    *slot = unsafe { core::slice::from_raw_parts_mut(p, frames) };
                }
                let mut io = $crate::ProcessIo {
                    inputs: &ins[..n_in],
                    outputs: &mut outs[..n_out],
                    connected_inputs: $crate::InputMask(connected_mask),
                };
                $crate::Module::process(&mut inst.module, &mut io);
            }

            unsafe extern "C" fn on_param(inst: *mut c_void, index: u32, value: f32) {
                let inst = unsafe { &mut *(inst as *mut $crate::NativeInstance<$ty>) };
                $crate::Module::on_param(&mut inst.module, index, value);
            }

            unsafe extern "C" fn save(inst: *mut c_void, buf: *mut u8, cap: u32) -> u32 {
                let inst = unsafe { &mut *(inst as *mut $crate::NativeInstance<$ty>) };
                let state = $crate::Module::save_state(&inst.module);
                let n = state.len().min(cap as usize);
                unsafe { core::ptr::copy_nonoverlapping(state.as_ptr(), buf, n) };
                n as u32
            }

            unsafe extern "C" fn load(inst: *mut c_void, buf: *const u8, len: u32) {
                let inst = unsafe { &mut *(inst as *mut $crate::NativeInstance<$ty>) };
                let bytes = unsafe { core::slice::from_raw_parts(buf, len as usize) };
                $crate::Module::load_state(&mut inst.module, bytes);
            }

            static VTABLE: $crate::NativeVTableV1 = $crate::NativeVTableV1 {
                abi_version: $crate::NATIVE_ABI_VERSION,
                create,
                destroy,
                process,
                on_param,
                save,
                load,
            };

            #[no_mangle]
            pub extern "C" fn dj_module_entry_v1() -> *const $crate::NativeVTableV1 {
                &VTABLE
            }
        }
    };
}

/// Generate the `wasm-1` ABI exports for a [`Module`] implementation.
#[macro_export]
macro_rules! export_module {
    ($ty:ty) => {
        #[doc(hidden)]
        mod __dj_module_exports {
            use super::*;

            static mut RUNTIME: Option<$crate::Runtime<$ty>> = None;

            #[inline]
            fn rt() -> &'static mut $crate::Runtime<$ty> {
                unsafe {
                    #[allow(static_mut_refs)]
                    RUNTIME.as_mut().expect("mod_new not called")
                }
            }

            #[no_mangle]
            pub extern "C" fn mod_new(sample_rate: f32, block_size: u32) {
                unsafe {
                    #[allow(static_mut_refs)]
                    {
                        RUNTIME = Some($crate::Runtime::new(sample_rate, block_size as usize));
                    }
                }
            }

            #[no_mangle]
            pub extern "C" fn mod_in_ptr() -> *mut f32 {
                rt().in_buf.as_mut_ptr()
            }

            #[no_mangle]
            pub extern "C" fn mod_out_ptr() -> *const f32 {
                rt().out_buf.as_ptr()
            }

            #[no_mangle]
            pub extern "C" fn mod_process(frames: u32, connected_mask: u64) {
                rt().process(frames as usize, connected_mask);
            }

            #[no_mangle]
            pub extern "C" fn mod_on_param(index: u32, value: f32) {
                let r = rt();
                $crate::Module::on_param(&mut r.module, index, value);
            }

            #[no_mangle]
            pub extern "C" fn mod_state_ptr() -> *mut u8 {
                rt().state_buf.as_mut_ptr()
            }

            #[no_mangle]
            pub extern "C" fn mod_state_capacity() -> u32 {
                $crate::STATE_CAPACITY as u32
            }

            #[no_mangle]
            pub extern "C" fn mod_save() -> u32 {
                let r = rt();
                let state = $crate::Module::save_state(&r.module);
                let n = state.len().min($crate::STATE_CAPACITY);
                r.state_buf[..n].copy_from_slice(&state[..n]);
                n as u32
            }

            #[no_mangle]
            pub extern "C" fn mod_load(len: u32) {
                let r = rt();
                let n = (len as usize).min($crate::STATE_CAPACITY);
                // Copy out to avoid aliasing module state and the buffer.
                let bytes: Vec<u8> = r.state_buf[..n].to_vec();
                $crate::Module::load_state(&mut r.module, &bytes);
            }
        }
    };
}
