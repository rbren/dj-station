//! Grid Track module (`builtin.grid_track`) control: the program a row
//! plays and the clip audio behind it; methods on [`Engine`] only.
//!
//! Like a Beat Clip's binding, the AUDIO is not patch state — the app
//! layer loads it out of the clip store. Unlike one, neither is the
//! PROGRAM: a Grid arrangement is saved in its own document
//! (`grids/<name>.json`), and the app compiles the open one into these
//! calls whenever it changes.

use super::*;
use crate::grid_track::{
    GridTrackCmd, GridTrackGarbage, GridTrackProgram, GridTrackStatus, IN_BPM,
};
use crate::playback::ClipAudio;

impl Engine {
    fn grid_track_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.grid_tracks.contains_key(&node),
            "{instance_id:?} is not a Grid Track module"
        );
        Ok(node)
    }

    /// Install a row's program (its copies, level line and play range).
    /// Unchanged programs are dropped here rather than costing the RT
    /// thread a swap — the Grid page re-compiles on every edit, most of
    /// which touch one row.
    pub fn grid_track_set_program(
        &mut self,
        instance_id: &str,
        program: GridTrackProgram,
    ) -> Result<()> {
        let node = self.grid_track_node(instance_id)?;
        let program = Arc::new(program);
        let ctl = self.grid_tracks.get_mut(&node).unwrap();
        while ctl.garbage_rx.pop().is_ok() {}
        if ctl.program == program {
            return Ok(());
        }
        ctl.program = program.clone();
        ctl.tx
            .push(GridTrackCmd::Program(program))
            .map_err(|_| anyhow!("too many pending grid programs"))
    }

    /// Run or hold a row. Transport, not program state: a row reads its
    /// position BETWEEN the clock's edges, so a clock that has stopped
    /// pulsing does not stop it — this does, and a Grid pause sends it
    /// alongside [`Engine::clock_transport`].
    pub fn grid_track_transport(&mut self, instance_id: &str, running: bool) -> Result<()> {
        let node = self.grid_track_node(instance_id)?;
        let ctl = self.grid_tracks.get_mut(&node).unwrap();
        ctl.tx
            .push(GridTrackCmd::Transport { running })
            .map_err(|_| anyhow!("too many pending grid track commands"))
    }

    /// Hand a row the audio its clip assembles to. `bpm` is the tempo the
    /// clip was rendered at, which is what one of its beats means.
    pub fn grid_track_load(
        &mut self,
        instance_id: &str,
        clip_id: Option<String>,
        audio: impl Into<ClipAudio>,
        bpm: f64,
    ) -> Result<()> {
        let node = self.grid_track_node(instance_id)?;
        let audio = audio.into();
        let ctl = self.grid_tracks.get_mut(&node).unwrap();
        while ctl.garbage_rx.pop().is_ok() {}
        ctl.audio = Some(audio.clone());
        ctl.clip_id = clip_id;
        ctl.tx
            .push(GridTrackCmd::Load { audio })
            .map_err(|_| anyhow!("too many pending grid clip loads"))?;
        self.write_knob_value(node, IN_BPM, bpm as f32)
    }

    /// Load a row's clip from a file (tests and E2E cases, where the clip
    /// store a binding would name does not exist).
    pub fn grid_track_load_file(
        &mut self,
        instance_id: &str,
        path: &std::path::Path,
        bpm: f64,
    ) -> Result<()> {
        let audio = decode_file(path)?;
        self.grid_track_load(instance_id, None, audio, bpm)
    }

    /// The program a row is running.
    pub fn grid_track_program(&self, instance_id: &str) -> Result<GridTrackProgram> {
        let node = self.grid_track_node(instance_id)?;
        Ok((*self.grid_tracks[&node].program).clone())
    }

    /// The clip a row is holding audio for, if any.
    pub fn grid_track_clip(&self, instance_id: &str) -> Result<Option<String>> {
        let node = self.grid_track_node(instance_id)?;
        Ok(self.grid_tracks[&node].clip_id.clone())
    }

    /// Row snapshot for the page: where it is and whether it is sounding.
    pub fn grid_track_status(&self, instance_id: &str) -> Result<GridTrackStatus> {
        let node = self.grid_track_node(instance_id)?;
        let ctl = &self.grid_tracks[&node];
        Ok(GridTrackStatus {
            clip_id: ctl.clip_id.clone(),
            beat: ctl.shared.beat(),
            playing: ctl.shared.playing(),
        })
    }

    /// Reclaim what the RT thread has handed back across every Grid Track
    /// node. Called on the control thread's own schedule
    /// ([`Engine::drain_garbage`]).
    pub(crate) fn drain_grid_track_garbage(&mut self) {
        for ctl in self.grid_tracks.values_mut() {
            while let Ok(garbage) = ctl.garbage_rx.pop() {
                match garbage {
                    GridTrackGarbage::Track(t) => drop(t),
                    GridTrackGarbage::Program(p) => drop(p),
                }
            }
        }
    }
}
