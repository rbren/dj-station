//! Track I/O module (`builtin.track_io`) control: handing it the buffer
//! it plays back verbatim. Methods on [`Engine`] only — the module itself
//! lives in [`crate::track_io`], and the offline render that uses it in
//! [`crate::track_fx`].

use super::*;

impl Engine {
    /// Hand a Track I/O node the audio it feeds the rack (control thread,
    /// lock-free; the module restarts from the top of the new buffer at
    /// the next block boundary).
    pub fn track_io_load(
        &mut self,
        instance_id: &str,
        track: Arc<crate::playback::TrackData>,
    ) -> Result<()> {
        let node = self.node_idx(instance_id)?;
        let ctl = self
            .track_ios
            .get_mut(&node)
            .ok_or_else(|| anyhow!("{instance_id:?} is not a Track I/O module"))?;
        ctl.load(track)
    }
}
