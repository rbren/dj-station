//! Extension hot reload and the patch-directory watcher — split out of the old monolithic engine.rs; methods on [`Engine`] only.

use super::*;

impl Engine {
    // ------------------------------------------------------------------
    // Hot reload
    // ------------------------------------------------------------------

    /// Recompile an extension's dsp.wasm and swap it into every live node
    /// using it: save_state -> new instance -> load_state -> atomic swap at
    /// a block boundary (PRD §5.4).
    pub fn reload_extension(&mut self, ext_id: &str) -> Result<usize> {
        self.registry.rescan()?;
        let manifest = self
            .registry
            .manifest(ext_id)
            .ok_or_else(|| anyhow!("unknown extension {ext_id:?}"))?;
        let node_idxs: Vec<usize> = self
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.ext_id == ext_id)
            .map(|(i, _)| i)
            .collect();
        let mut swapped = 0;
        for node in node_idxs {
            let mut new_module = self.instantiate(ext_id, &manifest)?;
            // Re-apply persistent params to the fresh instance.
            for (i, p) in manifest.params.iter().enumerate() {
                if let Some(v) = self.nodes[node].params.get(&p.id) {
                    new_module.on_param(i as u32, *v);
                }
            }
            match &mut self.state {
                EngineState::Stopped(core) => {
                    let _old = core.graph.swap_module(node, new_module);
                }
                _ => {
                    self.cmd_tx
                        .lock()
                        .unwrap()
                        .push(Command::SwapModule {
                            node,
                            module: new_module,
                        })
                        .map_err(|_| anyhow!("command queue full"))?;
                }
            }
            swapped += 1;
        }
        Ok(swapped)
    }

    /// Start the extension folder watcher (polling). On dsp.wasm mtime
    /// change, the changed extension is hot reloaded into the running graph.
    ///
    /// Returns immediately; the watcher runs until `stop_watcher` /
    /// engine drop. The closure-based design keeps `Engine` single-owner:
    /// the watcher sends reload requests through a channel serviced by
    /// `pump_watcher`, or reloads directly when `Engine` is shared.
    pub fn start_watcher(&mut self, poll_interval: Duration) -> Result<WatcherHandle> {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let paths: Vec<(String, PathBuf)> = self
            .registry
            .extensions
            .values()
            .map(|e| (e.manifest.id.clone(), e.dsp_path.clone()))
            .collect();
        let watch_state = self.watch_state.clone();
        {
            let mut ws = watch_state.lock().unwrap();
            for (id, p) in &paths {
                if let Ok(meta) = std::fs::metadata(p) {
                    if let Ok(mtime) = meta.modified() {
                        ws.insert(id.clone(), mtime);
                    }
                }
            }
        }
        let join = std::thread::Builder::new()
            .name("dj-ext-watcher".into())
            .spawn(move || {
                while !stop2.load(Ordering::Relaxed) {
                    std::thread::sleep(poll_interval);
                    for (id, p) in &paths {
                        if let Ok(meta) = std::fs::metadata(p) {
                            if let Ok(mtime) = meta.modified() {
                                let mut ws = watch_state.lock().unwrap();
                                let changed = ws.get(id).map(|t| *t != mtime).unwrap_or(true);
                                if changed {
                                    ws.insert(id.clone(), mtime);
                                    drop(ws);
                                    let _ = tx.send(id.clone());
                                }
                            }
                        }
                    }
                }
            })?;
        self.watcher_stop = Some(stop.clone());
        self.watcher_join = Some(join);
        Ok(WatcherHandle { rx, stop })
    }

    /// Service pending watcher notifications: hot-reload each changed
    /// extension. Call this from the control loop.
    pub fn pump_watcher(&mut self, handle: &WatcherHandle) -> Result<usize> {
        let mut total = 0;
        while let Ok(ext_id) = handle.rx.try_recv() {
            total += self.reload_extension(&ext_id)?;
        }
        Ok(total)
    }
}
