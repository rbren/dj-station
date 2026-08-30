//! Math module control plane; methods on [`Engine`] only.
//!
//! The typed text becomes the node's state whatever it says (it is what
//! the user wrote, and it round-trips through the patch); only a text that
//! COMPILES ships a program to the RT module. The two verbs differ in what
//! a text that does not compile leaves running:
//!
//! - [`Engine::math_set_expr`] is TYPING. A half-written expression must
//!   never silence a patch, so the last program that compiled plays on and
//!   the message goes back for the panel to show.
//! - [`Engine::math_set_state`] is INSTALLING a saved state (patch load,
//!   undo/redo, macro adoption), where there is no "last good" the user
//!   would recognize: a broken expression installs SILENCE, because a
//!   module must not compute something nobody wrote.

use super::*;
use crate::math::MathState;

impl Engine {
    fn math_node(&self, instance_id: &str) -> Result<usize> {
        let node = self.node_idx(instance_id)?;
        anyhow::ensure!(
            self.nodes[node].math.is_some(),
            "{instance_id:?} is not a Math module"
        );
        Ok(node)
    }

    /// The expression a Math node holds, exactly as typed.
    pub fn math(&self, instance_id: &str) -> Result<&MathState> {
        let node = self.math_node(instance_id)?;
        Ok(self.nodes[node].math.as_ref().unwrap())
    }

    /// Why the held expression is not running, if it is not. Derived
    /// state: never persisted, recomputed by every `math_set_expr`.
    pub fn math_error(&self, instance_id: &str) -> Result<Option<String>> {
        let node = self.math_node(instance_id)?;
        Ok(self.maths[&node].error.clone())
    }

    /// Set the expression as the user types it. Returns the compile
    /// error, if any — an `Err` means the module or the ring is the
    /// problem, not the text.
    pub fn math_set_expr(&mut self, instance_id: &str, expr: &str) -> Result<Option<String>> {
        self.math_apply(instance_id, expr, false)
    }

    /// Install a saved expression (patch load, undo/redo, macro adoption).
    pub fn math_set_state(
        &mut self,
        instance_id: &str,
        state: MathState,
    ) -> Result<Option<String>> {
        self.math_apply(instance_id, &state.expr, true)
    }

    fn math_apply(
        &mut self,
        instance_id: &str,
        expr: &str,
        silence_on_error: bool,
    ) -> Result<Option<String>> {
        let node = self.math_node(instance_id)?;
        self.nodes[node].math = Some(MathState {
            expr: expr.to_string(),
        });
        let compiled = crate::math::compile(expr);
        let ctl = self.maths.get_mut(&node).unwrap();
        match compiled {
            Ok(program) => {
                ctl.error = None;
                ctl.push(std::sync::Arc::new(program))?;
                Ok(None)
            }
            Err(e) => {
                let message = format!("{e:#}");
                ctl.error = Some(message.clone());
                if silence_on_error {
                    ctl.push(std::sync::Arc::new(crate::math::MathProgram::silent()))?;
                }
                Ok(Some(message))
            }
        }
    }
}
