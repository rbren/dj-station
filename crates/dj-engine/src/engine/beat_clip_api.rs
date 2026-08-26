//! Beat Clip module (`builtin.beat_clip`) control: which clip a node
//! plays, and the audio that clip currently assembles to; methods on
//! [`Engine`] only.
//!
//! The BINDING and the AUDIO are separate on purpose. A patch persists the
//! binding ([`BeatClipRef`]) because a Beatify clip is placements rather
//! than a file; the samples come from the app layer, which re-assembles
//! them after a load — [`Engine::beat_clip_pending`] is how it finds the
//! nodes still waiting for that.

use super::*;
use crate::beat_clip::{beats_of, BeatClipRef, BeatClipStatus, IN_BPM};

impl Engine {
    fn beat_clip_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.beat_clips.contains_key(&node),
            "{instance_id:?} is not a Beat Clip module"
        );
        Ok(node)
    }

    /// Hand a Beat Clip node the audio a clip assembles to (control
    /// thread), picked up lock-free at the next block boundary. `bpm` is
    /// the tempo it was rendered at — the project's — and lands on the
    /// module's BPM input, which is what one beat of the clip means.
    /// Works stopped or running.
    pub fn beat_clip_load(
        &mut self,
        instance_id: &str,
        clip: Option<BeatClipRef>,
        audio: TrackData,
        bpm: f64,
    ) -> Result<()> {
        let node = self.beat_clip_node(instance_id)?;
        self.hand_clip(node, clip, Arc::new(audio), bpm as f32)
    }

    /// Put a clip in a node's hands: the RT module picks the audio up
    /// lock-free at the next block boundary, and the BPM input — what one
    /// beat of that clip means — moves with it.
    fn hand_clip(
        &mut self,
        node: usize,
        clip: Option<BeatClipRef>,
        audio: Arc<TrackData>,
        bpm: f32,
    ) -> Result<()> {
        let ctl = self.beat_clips.get_mut(&node).unwrap();
        // Reclaim clips the RT thread replaced earlier.
        while ctl.garbage_rx.pop().is_ok() {}
        ctl.track = Some(audio.clone());
        ctl.loaded = clip.clone();
        ctl.tx
            .push(audio)
            .map_err(|_| anyhow!("too many pending clip loads"))?;
        self.nodes[node].clip = clip;
        self.write_knob_value(node, IN_BPM, bpm)
    }

    /// Load a rendered clip from a file (tests and E2E cases, where the
    /// Beatify project a binding would name does not exist).
    pub fn beat_clip_load_file(
        &mut self,
        instance_id: &str,
        path: &std::path::Path,
        bpm: f64,
    ) -> Result<()> {
        let audio = decode_file(path)?;
        self.beat_clip_load(instance_id, None, audio, bpm)
    }

    /// Hand `to` the clip `from` is playing — copy/paste and duplicate.
    /// The assembled audio is shared (an `Arc`, so no re-render and no
    /// second copy of the samples) along with the binding and the tempo.
    /// Returns false when the source has no audio to give: the paste is
    /// then an ordinary pending binding for the app layer to assemble.
    pub fn beat_clip_copy(&mut self, from: &str, to: &str) -> Result<bool> {
        let src = self.beat_clip_node(from)?;
        let Some(audio) = self.beat_clips[&src].track.clone() else {
            return Ok(false);
        };
        let clip = self.nodes[src].clip.clone();
        let bpm = self.knob_value(src, IN_BPM);
        let node = self.beat_clip_node(to)?;
        self.hand_clip(node, clip, audio, bpm)?;
        Ok(true)
    }

    /// Point a Beat Clip node at a clip WITHOUT audio (patch load): the
    /// node knows what it should be playing, and stays silent until the
    /// app layer assembles it.
    pub fn beat_clip_bind(&mut self, instance_id: &str, clip: Option<BeatClipRef>) -> Result<()> {
        let node = self.beat_clip_node(instance_id)?;
        self.nodes[node].clip = clip;
        Ok(())
    }

    /// Beat Clip nodes whose binding has no audio behind it yet — after a
    /// patch load, an undo that recreated one, or a paste. The app layer
    /// re-assembles exactly these.
    pub fn beat_clip_pending(&self) -> Vec<(String, BeatClipRef)> {
        self.beat_clips
            .iter()
            .filter_map(|(node, ctl)| {
                let info = self.nodes.get(*node)?;
                let want = info.clip.as_ref()?;
                (ctl.loaded.as_ref() != Some(want))
                    .then(|| (info.instance_id.clone(), want.clone()))
            })
            .collect()
    }

    /// Clip/transport snapshot for UIs. Position, beat and the clock's
    /// tempo come from the RT thread's last processed block.
    pub fn beat_clip_status(&self, instance_id: &str) -> Result<BeatClipStatus> {
        let node = self.beat_clip_node(instance_id)?;
        let ctl = &self.beat_clips[&node];
        let bpm = self.knob_value(node, IN_BPM) as f64;
        let duration_secs = ctl.track.as_ref().map(|t| t.duration_secs()).unwrap_or(0.0);
        Ok(BeatClipStatus {
            clip: self.nodes[node].clip.clone(),
            duration_secs,
            position_secs: ctl.shared.position_secs(),
            beats: beats_of(duration_secs, bpm),
            beat: ctl.shared.beat(),
            bpm,
            clock_bpm: ctl.shared.clock_bpm(),
            playing: ctl.shared.playing(),
        })
    }
}
