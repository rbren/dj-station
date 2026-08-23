//! Audio module (`builtin.audio`) control: track loading and the linked
//! BPM/speed pair; methods on [`Engine`] only.

use super::*;
use crate::audio::{AudioStatus, IN_BPM, IN_PLAY, IN_SPEED};

/// A pending mirror of one half of an Audio module's tempo pair onto the
/// other. Captured BEFORE the knob write (the ratio is what the pair meant
/// a moment ago), applied after it.
pub(crate) struct TempoLink {
    node: usize,
    jack: usize,
    partner: usize,
    /// `bpm / speed` before the change: the track's tempo at 1x.
    ratio: f32,
}

impl Engine {
    fn audio_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.audios.contains_key(&node),
            "{instance_id:?} is not an Audio module"
        );
        Ok(node)
    }

    /// Decode an audio file (control thread) and hand it to an Audio node,
    /// picked up lock-free at the next block boundary. Works stopped or
    /// running.
    ///
    /// The freshly loaded track plays at its own tempo: `speed` goes back
    /// to 1x and `bpm` adopts `track_bpm` when the library knows it. With
    /// an unknown tempo the BPM input keeps its value and thereby declares
    /// what this track's 1x tempo is — either way the pair (and the clock)
    /// agree with the audio.
    pub fn audio_load(
        &mut self,
        instance_id: &str,
        path: &std::path::Path,
        track_bpm: Option<f64>,
    ) -> Result<()> {
        let node = self.audio_node(instance_id)?;
        let data = Arc::new(decode_file(path)?);
        let ctl = self.audios.get_mut(&node).unwrap();
        // Reclaim tracks the RT thread replaced earlier.
        while ctl.garbage_rx.pop().is_ok() {}
        ctl.track = Some(data.clone());
        ctl.tx
            .push(data)
            .map_err(|_| anyhow!("too many pending track loads"))?;
        self.nodes[node].track_path = Some(path.to_string_lossy().to_string());
        self.write_knob_value(node, IN_SPEED, 1.0)?;
        if let Some(bpm) = track_bpm {
            self.write_knob_value(node, IN_BPM, bpm as f32)?;
        }
        Ok(())
    }

    /// Path of the track currently loaded into an Audio node, if any.
    pub fn audio_track(&self, instance_id: &str) -> Result<Option<String>> {
        let node = self.audio_node(instance_id)?;
        Ok(self.nodes[node].track_path.clone())
    }

    /// Track/tempo snapshot for UIs.
    pub fn audio_status(&self, instance_id: &str) -> Result<AudioStatus> {
        let node = self.audio_node(instance_id)?;
        Ok(AudioStatus {
            track: self.nodes[node].track_path.clone(),
            duration_secs: self.audios[&node]
                .track
                .as_ref()
                .map(|t| t.duration_secs())
                .unwrap_or(0.0),
            bpm: self.knob_value(node, IN_BPM) as f64,
            speed: self.knob_value(node, IN_SPEED) as f64,
        })
    }

    /// True while an Audio node's play input is up (knob only — a wired
    /// gate is RT state the control thread never sees).
    pub fn audio_playing(&self, instance_id: &str) -> Result<bool> {
        let node = self.audio_node(instance_id)?;
        Ok(self.knob_value(node, IN_PLAY) >= 1.0)
    }

    /// Snapshot the BPM/speed link of a knob that is about to change.
    /// `None` for every jack that isn't one half of an Audio module's
    /// tempo pair — including a pair that momentarily means nothing
    /// (a zero or non-finite ratio).
    pub(crate) fn tempo_link(&self, node: usize, jack: usize) -> Option<TempoLink> {
        if self.nodes.get(node)?.builtin_kind() != Some(BuiltinKind::Audio) {
            return None;
        }
        let partner = match jack {
            IN_BPM => IN_SPEED,
            IN_SPEED => IN_BPM,
            _ => return None,
        };
        let ratio = self.knob_value(node, IN_BPM) / self.knob_value(node, IN_SPEED);
        (ratio.is_finite() && ratio > 0.0).then_some(TempoLink {
            node,
            jack,
            partner,
            ratio,
        })
    }

    /// Move the other half of the pair to match the half just written, so
    /// `bpm / speed` still reads as the track's 1x tempo. The partner
    /// clamps at its own knob range like any other knob.
    pub(crate) fn apply_tempo_link(&mut self, link: Option<TempoLink>) -> Result<()> {
        let Some(link) = link else { return Ok(()) };
        let changed = self.knob_value(link.node, link.jack);
        let value = if link.jack == IN_BPM {
            changed / link.ratio
        } else {
            changed * link.ratio
        };
        self.write_knob_value(link.node, link.partner, value)
    }
}
