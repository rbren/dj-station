//! wasmtime host for the `wasm-1` module ABI (PRD §5.2), SIMD enabled.

use anyhow::{Context, Result};
use std::path::Path;
use std::sync::Arc;
use wasmtime::{Engine as WtEngine, Instance, Memory, Module as WtModule, Store, TypedFunc};

use crate::module_host::HostModule;

/// Shared wasmtime engine (compilation cache lives here).
#[derive(Clone)]
pub struct WasmRuntime {
    engine: Arc<WtEngine>,
}

impl WasmRuntime {
    pub fn new() -> Result<Self> {
        let mut config = wasmtime::Config::new();
        config.wasm_simd(true);
        let engine = WtEngine::new(&config)?;
        Ok(WasmRuntime {
            engine: Arc::new(engine),
        })
    }

    pub fn compile_file(&self, path: &Path) -> Result<CompiledModule> {
        let module = WtModule::from_file(&self.engine, path)
            .with_context(|| format!("compiling {}", path.display()))?;
        Ok(CompiledModule { module })
    }

    pub fn instantiate(
        &self,
        compiled: &CompiledModule,
        sample_rate: f32,
        block_size: usize,
        n_inputs: usize,
        n_outputs: usize,
    ) -> Result<WasmModuleHost> {
        let mut store: Store<()> = Store::new(&self.engine, ());
        let instance = Instance::new(&mut store, &compiled.module, &[])?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .context("module exports no memory")?;

        let f_new: TypedFunc<(f32, u32), ()> = instance.get_typed_func(&mut store, "mod_new")?;
        let f_in_ptr: TypedFunc<(), u32> = instance.get_typed_func(&mut store, "mod_in_ptr")?;
        let f_out_ptr: TypedFunc<(), u32> = instance.get_typed_func(&mut store, "mod_out_ptr")?;
        let f_process: TypedFunc<(u32, u64), ()> =
            instance.get_typed_func(&mut store, "mod_process")?;
        let f_on_param: TypedFunc<(u32, f32), ()> =
            instance.get_typed_func(&mut store, "mod_on_param")?;
        let f_save: TypedFunc<(), u32> = instance.get_typed_func(&mut store, "mod_save")?;
        let f_load: TypedFunc<u32, ()> = instance.get_typed_func(&mut store, "mod_load")?;
        let f_state_ptr: TypedFunc<(), u32> =
            instance.get_typed_func(&mut store, "mod_state_ptr")?;

        f_new.call(&mut store, (sample_rate, block_size as u32))?;
        let in_ptr = f_in_ptr.call(&mut store, ())? as usize;
        let out_ptr = f_out_ptr.call(&mut store, ())? as usize;
        let state_ptr = f_state_ptr.call(&mut store, ())? as usize;

        Ok(WasmModuleHost {
            store,
            memory,
            f_process,
            f_on_param,
            f_save,
            f_load,
            in_ptr,
            out_ptr,
            state_ptr,
            n_inputs,
            n_outputs,
            block_size,
        })
    }
}

#[derive(Clone)]
pub struct CompiledModule {
    module: WtModule,
}

/// One live WASM module instance (own store + linear memory).
pub struct WasmModuleHost {
    store: Store<()>,
    memory: Memory,
    f_process: TypedFunc<(u32, u64), ()>,
    f_on_param: TypedFunc<(u32, f32), ()>,
    f_save: TypedFunc<(), u32>,
    f_load: TypedFunc<u32, ()>,
    in_ptr: usize,
    out_ptr: usize,
    state_ptr: usize,
    n_inputs: usize,
    n_outputs: usize,
    block_size: usize,
}

impl HostModule for WasmModuleHost {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        connected_mask: u64,
        frames: usize,
    ) {
        let frames = frames.min(self.block_size);
        // Copy inputs into linear memory. WASM linear memory is
        // little-endian; all supported hosts (x86_64/aarch64) are too, so
        // f32 slices can be moved as raw bytes.
        {
            let data = self.memory.data_mut(&mut self.store);
            for (i, buf) in inputs.iter().enumerate().take(self.n_inputs) {
                let start = self.in_ptr + i * self.block_size * 4;
                let src =
                    unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, frames * 4) };
                data[start..start + frames * 4].copy_from_slice(src);
            }
        }
        // A trapped module writes silence rather than crashing the engine.
        if self
            .f_process
            .call(&mut self.store, (frames as u32, connected_mask))
            .is_err()
        {
            for out in outputs.iter_mut().take(self.n_outputs) {
                out[..frames].fill(0.0);
            }
            return;
        }
        // Copy outputs back out (same little-endian rationale as above).
        let data = self.memory.data(&self.store);
        for (o, out) in outputs.iter_mut().enumerate().take(self.n_outputs) {
            let start = self.out_ptr + o * self.block_size * 4;
            let bytes = &data[start..start + frames * 4];
            let dst =
                unsafe { std::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u8, frames * 4) };
            dst.copy_from_slice(bytes);
        }
    }

    fn on_param(&mut self, index: u32, value: f32) {
        let _ = self.f_on_param.call(&mut self.store, (index, value));
    }

    fn save_state(&mut self) -> Vec<u8> {
        let len = self.f_save.call(&mut self.store, ()).unwrap_or(0) as usize;
        let data = self.memory.data(&self.store);
        data[self.state_ptr..self.state_ptr + len].to_vec()
    }

    fn load_state(&mut self, bytes: &[u8]) {
        let n = bytes.len();
        {
            let data = self.memory.data_mut(&mut self.store);
            data[self.state_ptr..self.state_ptr + n].copy_from_slice(bytes);
        }
        let _ = self.f_load.call(&mut self.store, n as u32);
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
