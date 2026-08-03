//! libloading host for the `native-1` module ABI (PRD §5.2, native escape
//! hatch).
//!
//! # Trust model
//!
//! Native modules are **unsandboxed, fully trusted code** (PRD §2 non-goal:
//! no sandboxing guarantees for the native escape hatch). Loading a
//! `dsp.dylib`/`dsp.so` executes arbitrary code with the privileges of the
//! host process. The RT rules for `process` (no allocation, no blocking, no
//! syscalls) are on the honor system — the host verifies the ABI version of
//! the vtable, nothing else. Only install native extensions you trust.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dj_module_sdk::{NativeVTableV1, NATIVE_ABI_VERSION, NATIVE_ENTRY_SYMBOL};

use crate::module_host::HostModule;

/// Caches loaded dylibs by path so every instance of the same extension
/// shares one `libloading::Library` (and the library outlives all of them).
#[derive(Default)]
pub struct NativeRuntime {
    libs: Mutex<HashMap<PathBuf, Arc<libloading::Library>>>,
}

impl NativeRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    fn library(&self, path: &Path) -> Result<Arc<libloading::Library>> {
        let mut libs = self.libs.lock().unwrap();
        if let Some(lib) = libs.get(path) {
            return Ok(lib.clone());
        }
        // SAFETY: loading a native module executes its initializers — this
        // is the documented trust model of the native escape hatch.
        let lib = unsafe { libloading::Library::new(path) }
            .with_context(|| format!("loading native module {}", path.display()))?;
        let lib = Arc::new(lib);
        libs.insert(path.to_path_buf(), lib.clone());
        Ok(lib)
    }

    /// Load `path`, resolve the versioned entry symbol, and instantiate.
    pub fn instantiate(
        &self,
        path: &Path,
        sample_rate: f32,
        block_size: usize,
        n_inputs: usize,
        n_outputs: usize,
    ) -> Result<NativeModuleHost> {
        anyhow::ensure!(
            n_inputs <= 64 && n_outputs <= 64,
            "at most 64 inputs/outputs supported"
        );
        let lib = self.library(path)?;
        // SAFETY: symbol type is fixed by the versioned symbol name.
        let entry: libloading::Symbol<unsafe extern "C" fn() -> *const NativeVTableV1> = unsafe {
            lib.get(NATIVE_ENTRY_SYMBOL.as_bytes())
                .with_context(|| format!("{}: missing {NATIVE_ENTRY_SYMBOL}", path.display()))?
        };
        let vtable = unsafe { entry() };
        anyhow::ensure!(!vtable.is_null(), "{}: null vtable", path.display());
        let abi_version = unsafe { (*vtable).abi_version };
        anyhow::ensure!(
            abi_version == NATIVE_ABI_VERSION,
            "{}: native ABI version {abi_version} (host supports {NATIVE_ABI_VERSION})",
            path.display()
        );
        let inst = unsafe { ((*vtable).create)(sample_rate, block_size as u32) };
        anyhow::ensure!(!inst.is_null(), "{}: create returned null", path.display());
        Ok(NativeModuleHost {
            _lib: lib,
            vtable,
            inst,
            n_inputs,
            n_outputs,
            state_buf: vec![0u8; STATE_CAPACITY],
        })
    }
}

const STATE_CAPACITY: usize = 64 * 1024;

/// One live native module instance. Runs on the RT thread; `process`
/// builds fixed-size pointer tables on the stack (no allocation).
pub struct NativeModuleHost {
    /// Keeps the dylib mapped for as long as the instance lives.
    _lib: Arc<libloading::Library>,
    vtable: *const NativeVTableV1,
    inst: *mut core::ffi::c_void,
    n_inputs: usize,
    n_outputs: usize,
    state_buf: Vec<u8>,
}

// SAFETY: instances are owned by exactly one thread at a time (moved to the
// RT thread via the command queue). Native modules must tolerate being
// called from a different thread than they were created on — part of the
// documented native-1 contract.
unsafe impl Send for NativeModuleHost {}

impl Drop for NativeModuleHost {
    fn drop(&mut self) {
        unsafe { ((*self.vtable).destroy)(self.inst) };
    }
}

impl HostModule for NativeModuleHost {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        connected_mask: u64,
        frames: usize,
    ) {
        let n_in = self.n_inputs.min(inputs.len());
        let n_out = self.n_outputs.min(outputs.len());
        let mut in_ptrs: [*const f32; 64] = [std::ptr::null(); 64];
        for (i, buf) in inputs.iter().enumerate().take(n_in) {
            in_ptrs[i] = buf.as_ptr();
        }
        let mut out_ptrs: [*mut f32; 64] = [std::ptr::null_mut(); 64];
        for (o, buf) in outputs.iter_mut().enumerate().take(n_out) {
            out_ptrs[o] = buf.as_mut_ptr();
        }
        unsafe {
            ((*self.vtable).process)(
                self.inst,
                in_ptrs.as_ptr(),
                n_in as u32,
                out_ptrs.as_ptr(),
                n_out as u32,
                frames as u32,
                connected_mask,
            )
        };
    }

    fn on_param(&mut self, index: u32, value: f32) {
        unsafe { ((*self.vtable).on_param)(self.inst, index, value) };
    }

    fn save_state(&mut self) -> Vec<u8> {
        let n = unsafe {
            ((*self.vtable).save)(
                self.inst,
                self.state_buf.as_mut_ptr(),
                self.state_buf.len() as u32,
            )
        } as usize;
        self.state_buf[..n.min(self.state_buf.len())].to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        unsafe { ((*self.vtable).load)(self.inst, bytes.as_ptr(), bytes.len() as u32) };
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
