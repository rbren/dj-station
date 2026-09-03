//! Clock module (`builtin.clock`) control: the tempo lane it runs and the
//! transport that runs it; methods on [`Engine`] only.
//!
//! The lane is a PROGRAM, compiled control-side and shipped over the SPSC
//! ring as an `Arc` (the choreo pattern). The transport is not program
//! state: like a Decks bank, a clock is created stopped and nothing
//! restores it running.

use super::*;
use crate::clock::{ClockCmd, ClockProgram, ClockStatus};

impl Engine {
    fn clock_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.clocks.contains_key(&node),
            "{instance_id:?} is not a Clock module"
        );
        Ok(node)
    }

    /// Install the clock's program (tempo lane, start beat, loop). Takes
    /// effect at the next block; the position is untouched, so a lane
    /// edited mid-play is heard from where the transport already is.
    pub fn clock_set_program(&mut self, instance_id: &str, program: ClockProgram) -> Result<()> {
        let node = self.clock_node(instance_id)?;
        let program = Arc::new(program);
        let ctl = self.clocks.get_mut(&node).unwrap();
        while ctl.garbage_rx.pop().is_ok() {}
        if ctl.program == program {
            return Ok(());
        }
        ctl.program = program.clone();
        ctl.tx
            .push(ClockCmd::Program(program))
            .map_err(|_| anyhow!("too many pending clock programs"))
    }

    /// The program a clock node is running.
    pub fn clock_program(&self, instance_id: &str) -> Result<ClockProgram> {
        let node = self.clock_node(instance_id)?;
        Ok((*self.clocks[&node].program).clone())
    }

    /// Move the cue — where a restart parks — leaving the rest of the
    /// program as it is. What a seek writes.
    pub fn clock_set_start(&mut self, instance_id: &str, beat: f64) -> Result<()> {
        let mut program = self.clock_program(instance_id)?;
        program.start_beat = beat;
        self.clock_set_program(instance_id, program)
    }

    /// Run or hold the transport. `restart` parks it on the program's
    /// start beat first — play-from-the-top rather than resume.
    pub fn clock_transport(
        &mut self,
        instance_id: &str,
        running: bool,
        restart: bool,
    ) -> Result<()> {
        let node = self.clock_node(instance_id)?;
        let ctl = self.clocks.get_mut(&node).unwrap();
        ctl.running = running;
        ctl.tx
            .push(ClockCmd::Transport { running, restart })
            .map_err(|_| anyhow!("too many pending clock commands"))
    }

    /// Where the transport is, as of the RT thread's last block.
    pub fn clock_status(&self, instance_id: &str) -> Result<ClockStatus> {
        let node = self.clock_node(instance_id)?;
        let shared = &self.clocks[&node].shared;
        Ok(ClockStatus {
            beat: shared.beat(),
            bpm: shared.bpm(),
            running: shared.running(),
        })
    }
}
