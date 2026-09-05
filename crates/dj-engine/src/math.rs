//! Built-in Math module: one typed expression, eight outputs.
//!
//! The panel holds a line of Rust-flavoured arithmetic — `(3 * (x + i))
//! .pow(2)` — where `x` is the module's input (knob or CV, -10..+10 V) and
//! `i` is the output index (0..[`MATH_OUTPUTS`]-1). Every output jack
//! evaluates the same expression with its own `i`, per sample.
//!
//! Rust is not compiled here and never could be on the audio thread: the
//! text is parsed on the CONTROL thread into [`MathProgram`], a flat
//! postfix `Vec<Op>` over a fixed-size stack, and shipped to the RT module
//! as an `Arc` over an SPSC ring (replaced programs return on a garbage
//! ring for an off-RT drop — the choreography/playback handoff pattern).
//! Evaluation allocates nothing, locks nothing and cannot panic.
//!
//! A text that does not parse is NOT an error the user loses work over:
//! [`crate::Engine::math_set_expr`] keeps the typed text (it is module
//! state and round-trips through the patch), reports the message for the
//! panel to show, and pushes NOTHING — so the last program that did
//! compile keeps running and the audio never glitches.
//!
//! The accepted grammar is a subset of Rust expression syntax:
//!   - `+ - * / %`, unary `-`, parentheses, `f32` literals (`1_000`,
//!     `1e-3`, `2.5f32`);
//!   - method calls on any expression — `x.sin()`, `x.pow(i)`,
//!     `x.clamp(-1.0, 1.0)` — and the same names as free functions
//!     (`sin(x)`, `pow(x, i)`), which real Rust lacks but every
//!     calculator has;
//!   - casts, `i as f32` (a no-op here, since every value is an `f32`) and
//!     `x as i32` (truncation, saturating at 0 for unsigned targets);
//!   - the variables `x` and `i`, the output count `n`, and the constants
//!     `pi`, `tau`, `e`.
//!
//! Output values are clamped to the ±10 V rails, and a non-finite result
//! (division by zero, `(-1.0).sqrt()`) reads as 0 V rather than sending
//! NaN downstream.

use std::sync::Arc;

use crate::knob::{Curve, KnobConfig, KnobStyle};
use crate::manifest::{categories, JackDecl, Manifest, OutputDecl};
use crate::module_host::HostModule;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

pub const MATH_ID: &str = "builtin.math";

/// Output jacks; also the value of `n` inside an expression.
pub const MATH_OUTPUTS: usize = 8;
/// The `x` input jack's range, in Volts.
pub const X_RANGE: f32 = 10.0;
/// Evaluated values are held to the engine's nominal rails.
pub const OUT_RAIL: f32 = 10.0;
/// Evaluation stack depth. A program needing more is rejected at compile
/// time, so the RT thread never has to grow one.
pub const MAX_STACK: usize = 32;
/// Expression size cap (the text is user input arriving over IPC).
pub const MAX_OPS: usize = 512;

/// The expression a fresh module comes up with: the outputs fan out from
/// the knob, one Volt apart.
pub const DEFAULT_EXPR: &str = "x + i as f32";

const IN_X: usize = 0;

pub fn math_manifest() -> Manifest {
    Manifest {
        id: MATH_ID.into(),
        name: "Math".into(),
        version: "0.1.0".into(),
        abi: "native-1".into(),
        category: categories::UTILITIES.into(),
        deprecated: false,
        inputs: vec![JackDecl {
            id: "x".into(),
            name: "x".into(),
            alias: None,
            default: 0.0,
            audio: false,
            capture: false,
            knob: Some(KnobConfig {
                style: KnobStyle::Continuous,
                min: -X_RANGE,
                max: X_RANGE,
                curve: Curve::Linear,
                steps: None,
            }),
            display: None,
        }],
        outputs: (0..MATH_OUTPUTS)
            .map(|i| OutputDecl {
                id: format!("out{i}"),
                name: format!("i = {i}"),
                alias: None,
                display: None,
            })
            .collect(),
        params: vec![],
        ui: None,
        latency_samples: 0,
        bypass: Default::default(),
        presets: Default::default(),
    }
}

/// Math module state: the expression text exactly as typed. Canonical on
/// the control side and persisted per instance in the patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MathState {
    pub expr: String,
}

impl Default for MathState {
    fn default() -> Self {
        MathState {
            expr: DEFAULT_EXPR.to_string(),
        }
    }
}

impl MathState {
    pub fn compile(&self) -> Result<MathProgram> {
        compile(&self.expr)
    }
}

/// One step of the compiled expression, in postfix order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    Const(f32),
    /// The `x` input, this sample.
    X,
    /// The output index being evaluated.
    I,
    Neg,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Un(UnFn),
    Bin(BinFn),
    Clamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnFn {
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Sinh,
    Cosh,
    Tanh,
    Exp,
    Exp2,
    Ln,
    Log2,
    Log10,
    Sqrt,
    Cbrt,
    Abs,
    Signum,
    Floor,
    Ceil,
    Round,
    Trunc,
    Fract,
    Recip,
    ToRadians,
    ToDegrees,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinFn {
    Pow,
    Atan2,
    Min,
    Max,
    Log,
    Hypot,
    RemEuclid,
    Copysign,
}

impl UnFn {
    fn apply(self, v: f32) -> f32 {
        match self {
            UnFn::Sin => v.sin(),
            UnFn::Cos => v.cos(),
            UnFn::Tan => v.tan(),
            UnFn::Asin => v.asin(),
            UnFn::Acos => v.acos(),
            UnFn::Atan => v.atan(),
            UnFn::Sinh => v.sinh(),
            UnFn::Cosh => v.cosh(),
            UnFn::Tanh => v.tanh(),
            UnFn::Exp => v.exp(),
            UnFn::Exp2 => v.exp2(),
            UnFn::Ln => v.ln(),
            UnFn::Log2 => v.log2(),
            UnFn::Log10 => v.log10(),
            UnFn::Sqrt => v.sqrt(),
            UnFn::Cbrt => v.cbrt(),
            UnFn::Abs => v.abs(),
            UnFn::Signum => v.signum(),
            UnFn::Floor => v.floor(),
            UnFn::Ceil => v.ceil(),
            UnFn::Round => v.round(),
            UnFn::Trunc => v.trunc(),
            UnFn::Fract => v.fract(),
            UnFn::Recip => v.recip(),
            UnFn::ToRadians => v.to_radians(),
            UnFn::ToDegrees => v.to_degrees(),
        }
    }
}

impl BinFn {
    fn apply(self, a: f32, b: f32) -> f32 {
        match self {
            BinFn::Pow => a.powf(b),
            BinFn::Atan2 => a.atan2(b),
            BinFn::Min => a.min(b),
            BinFn::Max => a.max(b),
            BinFn::Log => a.log(b),
            BinFn::Hypot => a.hypot(b),
            BinFn::RemEuclid => a.rem_euclid(b),
            BinFn::Copysign => a.copysign(b),
        }
    }
}

fn unary_fn(name: &str) -> Option<UnFn> {
    Some(match name {
        "sin" => UnFn::Sin,
        "cos" => UnFn::Cos,
        "tan" => UnFn::Tan,
        "asin" => UnFn::Asin,
        "acos" => UnFn::Acos,
        "atan" => UnFn::Atan,
        "sinh" => UnFn::Sinh,
        "cosh" => UnFn::Cosh,
        "tanh" => UnFn::Tanh,
        "exp" => UnFn::Exp,
        "exp2" => UnFn::Exp2,
        "ln" => UnFn::Ln,
        "log2" => UnFn::Log2,
        "log10" => UnFn::Log10,
        "sqrt" => UnFn::Sqrt,
        "cbrt" => UnFn::Cbrt,
        "abs" => UnFn::Abs,
        "signum" => UnFn::Signum,
        "floor" => UnFn::Floor,
        "ceil" => UnFn::Ceil,
        "round" => UnFn::Round,
        "trunc" => UnFn::Trunc,
        "fract" => UnFn::Fract,
        "recip" => UnFn::Recip,
        "to_radians" => UnFn::ToRadians,
        "to_degrees" => UnFn::ToDegrees,
        _ => return None,
    })
}

fn binary_fn(name: &str) -> Option<BinFn> {
    Some(match name {
        // `powi`/`powf` are the same call here: everything is an f32.
        "pow" | "powf" | "powi" => BinFn::Pow,
        "atan2" => BinFn::Atan2,
        "min" => BinFn::Min,
        "max" => BinFn::Max,
        "log" => BinFn::Log,
        "hypot" => BinFn::Hypot,
        "rem_euclid" => BinFn::RemEuclid,
        "copysign" => BinFn::Copysign,
        _ => return None,
    })
}

fn constant(name: &str) -> Option<f32> {
    Some(match name {
        "pi" | "PI" => std::f32::consts::PI,
        "tau" | "TAU" => std::f32::consts::TAU,
        "e" | "E" => std::f32::consts::E,
        "n" => MATH_OUTPUTS as f32,
        _ => return None,
    })
}

/// A compiled expression: postfix ops plus the stack depth they need
/// (validated at compile time, so evaluation can never overflow).
#[derive(Debug, Clone, PartialEq)]
pub struct MathProgram {
    ops: Vec<Op>,
}

impl MathProgram {
    /// A program that outputs 0 V: what a Math node runs when the state it
    /// was handed (a saved patch, an undo step) does not compile.
    pub fn silent() -> Self {
        MathProgram {
            ops: vec![Op::Const(0.0)],
        }
    }

    pub fn ops(&self) -> &[Op] {
        &self.ops
    }

    /// Evaluate for one output: `x` Volts in, output index `i`.
    ///
    /// RT-safe: a fixed stack, no allocation, no panics — a stack that
    /// somehow ran out (it cannot; [`compile`] proves the depth) yields
    /// 0 V rather than unwinding on the audio thread. Non-finite results
    /// read as 0 V and finite ones are held to the ±10 V rails.
    pub fn eval(&self, x: f32, i: f32) -> f32 {
        let mut stack = [0.0f32; MAX_STACK];
        let mut sp = 0usize;
        macro_rules! push {
            ($v:expr) => {{
                if sp >= MAX_STACK {
                    return 0.0;
                }
                stack[sp] = $v;
                sp += 1;
            }};
        }
        macro_rules! pop {
            () => {{
                sp = sp.saturating_sub(1);
                stack[sp]
            }};
        }
        for op in &self.ops {
            match *op {
                Op::Const(v) => push!(v),
                Op::X => push!(x),
                Op::I => push!(i),
                Op::Neg => {
                    let a = pop!();
                    push!(-a)
                }
                Op::Add => {
                    let b = pop!();
                    let a = pop!();
                    push!(a + b)
                }
                Op::Sub => {
                    let b = pop!();
                    let a = pop!();
                    push!(a - b)
                }
                Op::Mul => {
                    let b = pop!();
                    let a = pop!();
                    push!(a * b)
                }
                Op::Div => {
                    let b = pop!();
                    let a = pop!();
                    push!(a / b)
                }
                Op::Rem => {
                    let b = pop!();
                    let a = pop!();
                    push!(a % b)
                }
                Op::Un(f) => {
                    let a = pop!();
                    push!(f.apply(a))
                }
                Op::Bin(f) => {
                    let b = pop!();
                    let a = pop!();
                    push!(f.apply(a, b))
                }
                Op::Clamp => {
                    let hi = pop!();
                    let lo = pop!();
                    let a = pop!();
                    // Rust's f32::clamp panics on lo > hi; the RT thread
                    // must not, so an inverted range just pins to `lo`.
                    push!(a.max(lo).min(hi.max(lo)))
                }
            }
        }
        let v = if sp == 0 { 0.0 } else { stack[sp - 1] };
        if v.is_finite() {
            v.clamp(-OUT_RAIL, OUT_RAIL)
        } else {
            0.0
        }
    }
}

// ---------------------------------------------------------------- parsing

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f32),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    LParen,
    RParen,
    Comma,
    Dot,
}

impl Tok {
    fn describe(&self) -> String {
        match self {
            Tok::Num(v) => format!("number {v}"),
            Tok::Ident(s) => format!("`{s}`"),
            Tok::Plus => "`+`".into(),
            Tok::Minus => "`-`".into(),
            Tok::Star => "`*`".into(),
            Tok::Slash => "`/`".into(),
            Tok::Percent => "`%`".into(),
            Tok::LParen => "`(`".into(),
            Tok::RParen => "`)`".into(),
            Tok::Comma => "`,`".into(),
            Tok::Dot => "`.`".into(),
        }
    }
}

#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    /// 1-based column in the source text, for error messages.
    col: usize,
}

fn tokenize(src: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut p = 0usize;
    while p < chars.len() {
        let c = chars[p];
        let col = p + 1;
        if c.is_whitespace() {
            p += 1;
            continue;
        }
        let simple = match c {
            '+' => Some(Tok::Plus),
            '-' => Some(Tok::Minus),
            '*' => Some(Tok::Star),
            '/' => Some(Tok::Slash),
            '%' => Some(Tok::Percent),
            '(' => Some(Tok::LParen),
            ')' => Some(Tok::RParen),
            ',' => Some(Tok::Comma),
            '.' => Some(Tok::Dot),
            _ => None,
        };
        if let Some(tok) = simple {
            out.push(Token { tok, col });
            p += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = p;
            let mut text = String::new();
            while p < chars.len() && (chars[p].is_ascii_digit() || chars[p] == '_') {
                if chars[p] != '_' {
                    text.push(chars[p]);
                }
                p += 1;
            }
            // A `.` belongs to the literal only when a digit follows it —
            // otherwise it is a method call (`2.0.sqrt()`, `n.recip()`).
            if p + 1 < chars.len() && chars[p] == '.' && chars[p + 1].is_ascii_digit() {
                text.push('.');
                p += 1;
                while p < chars.len() && (chars[p].is_ascii_digit() || chars[p] == '_') {
                    if chars[p] != '_' {
                        text.push(chars[p]);
                    }
                    p += 1;
                }
            }
            if p < chars.len() && (chars[p] == 'e' || chars[p] == 'E') {
                let sign = chars.get(p + 1).copied();
                let digit_at = if matches!(sign, Some('+') | Some('-')) {
                    p + 2
                } else {
                    p + 1
                };
                if chars.get(digit_at).is_some_and(|d| d.is_ascii_digit()) {
                    text.push('e');
                    if let Some(s) = sign.filter(|s| *s == '+' || *s == '-') {
                        text.push(s);
                    }
                    p = digit_at;
                    while p < chars.len() && chars[p].is_ascii_digit() {
                        text.push(chars[p]);
                        p += 1;
                    }
                }
            }
            // Rust's literal suffixes, accepted and ignored.
            for suffix in ["f32", "f64"] {
                if chars[p..].starts_with(&suffix.chars().collect::<Vec<_>>()[..]) {
                    p += suffix.len();
                    break;
                }
            }
            let value: f32 = text
                .parse()
                .map_err(|_| anyhow!("`{text}` is not a number (column {})", start + 1))?;
            out.push(Token {
                tok: Tok::Num(value),
                col,
            });
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut name = String::new();
            while p < chars.len() && (chars[p].is_ascii_alphanumeric() || chars[p] == '_') {
                name.push(chars[p]);
                p += 1;
            }
            out.push(Token {
                tok: Tok::Ident(name),
                col,
            });
            continue;
        }
        bail!("unexpected character `{c}` (column {col})");
    }
    Ok(out)
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    ops: Vec<Op>,
    /// Current and high-water evaluation stack depth.
    depth: usize,
    max_depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos).map(|t| &t.tok)
    }

    fn col(&self) -> usize {
        match self.tokens.get(self.pos) {
            Some(t) => t.col,
            None => self.tokens.last().map(|t| t.col + 1).unwrap_or(1),
        }
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.tokens.get(self.pos)?.tok.clone();
        self.pos += 1;
        Some(t)
    }

    fn eat(&mut self, want: &Tok) -> bool {
        if self.peek() == Some(want) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, want: &Tok) -> Result<()> {
        let col = self.col();
        if self.eat(want) {
            return Ok(());
        }
        let found = match self.peek() {
            Some(t) => t.describe(),
            None => "end of expression".into(),
        };
        bail!(
            "expected {} but found {found} (column {col})",
            want.describe()
        )
    }

    /// Emit one op, tracking how deep the evaluation stack has to be.
    fn emit(&mut self, op: Op, pops: usize, pushes: usize) -> Result<()> {
        if self.ops.len() >= MAX_OPS {
            bail!("expression is too long (over {MAX_OPS} operations)");
        }
        self.depth = self.depth.saturating_sub(pops) + pushes;
        self.max_depth = self.max_depth.max(self.depth);
        if self.max_depth > MAX_STACK {
            bail!("expression nests too deeply (over {MAX_STACK} values)");
        }
        self.ops.push(op);
        Ok(())
    }

    fn expr(&mut self) -> Result<()> {
        self.term()?;
        loop {
            if self.eat(&Tok::Plus) {
                self.term()?;
                self.emit(Op::Add, 2, 1)?;
            } else if self.eat(&Tok::Minus) {
                self.term()?;
                self.emit(Op::Sub, 2, 1)?;
            } else {
                return Ok(());
            }
        }
    }

    fn term(&mut self) -> Result<()> {
        self.unary()?;
        loop {
            let op = if self.eat(&Tok::Star) {
                Op::Mul
            } else if self.eat(&Tok::Slash) {
                Op::Div
            } else if self.eat(&Tok::Percent) {
                Op::Rem
            } else {
                return Ok(());
            };
            self.unary()?;
            self.emit(op, 2, 1)?;
        }
    }

    fn unary(&mut self) -> Result<()> {
        if self.eat(&Tok::Minus) {
            self.unary()?;
            return self.emit(Op::Neg, 1, 1);
        }
        // A leading `+` is not Rust, but it is what a hand types.
        self.eat(&Tok::Plus);
        self.postfix()
    }

    fn postfix(&mut self) -> Result<()> {
        self.primary()?;
        loop {
            if self.eat(&Tok::Dot) {
                let col = self.col();
                let Some(Tok::Ident(name)) = self.next() else {
                    bail!("expected a method name after `.` (column {col})");
                };
                self.expect(&Tok::LParen)?;
                let args = self.args()?;
                // The receiver is already on the stack: a method call is
                // its free-function form with one argument more.
                self.call(&name, args + 1, col)?;
                continue;
            }
            match self.peek() {
                Some(Tok::Ident(name)) if name == "as" => {
                    self.pos += 1;
                    let col = self.col();
                    let Some(Tok::Ident(ty)) = self.next() else {
                        bail!("expected a type after `as` (column {col})");
                    };
                    self.cast(&ty, col)?;
                }
                _ => return Ok(()),
            }
        }
    }

    /// Arguments of a call whose `(` has been consumed; returns the count.
    fn args(&mut self) -> Result<usize> {
        let mut n = 0;
        if self.eat(&Tok::RParen) {
            return Ok(n);
        }
        loop {
            self.expr()?;
            n += 1;
            if self.eat(&Tok::Comma) {
                // A trailing comma is legal Rust.
                if self.eat(&Tok::RParen) {
                    return Ok(n);
                }
                continue;
            }
            self.expect(&Tok::RParen)?;
            return Ok(n);
        }
    }

    /// Resolve a call by name and arity; the arguments are on the stack.
    fn call(&mut self, name: &str, args: usize, col: usize) -> Result<()> {
        if name == "clamp" {
            if args != 3 {
                bail!("`clamp` takes a value and two bounds, got {args} (column {col})");
            }
            return self.emit(Op::Clamp, 3, 1);
        }
        let known_un = unary_fn(name);
        let known_bin = binary_fn(name);
        match (known_un, known_bin, args) {
            (Some(f), _, 1) => self.emit(Op::Un(f), 1, 1),
            (_, Some(f), 2) => self.emit(Op::Bin(f), 2, 1),
            (Some(_), None, n) => bail!("`{name}` takes 1 argument, got {n} (column {col})"),
            (None, Some(_), n) => bail!("`{name}` takes 2 arguments, got {n} (column {col})"),
            (Some(_), Some(_), n) => bail!("`{name}` cannot take {n} arguments (column {col})"),
            (None, None, _) => bail!("unknown function `{name}` (column {col})"),
        }
    }

    fn cast(&mut self, ty: &str, col: usize) -> Result<()> {
        match ty {
            // Everything already IS an f32.
            "f32" | "f64" => Ok(()),
            "i8" | "i16" | "i32" | "i64" | "i128" | "isize" => self.emit(Op::Un(UnFn::Trunc), 1, 1),
            // Rust saturates a negative float cast to an unsigned integer.
            "u8" | "u16" | "u32" | "u64" | "u128" | "usize" => {
                self.emit(Op::Un(UnFn::Trunc), 1, 1)?;
                self.emit(Op::Const(0.0), 0, 1)?;
                self.emit(Op::Bin(BinFn::Max), 2, 1)
            }
            other => bail!("cannot cast to `{other}` (column {col})"),
        }
    }

    fn primary(&mut self) -> Result<()> {
        let col = self.col();
        match self.next() {
            Some(Tok::Num(v)) => self.emit(Op::Const(v), 0, 1),
            Some(Tok::LParen) => {
                self.expr()?;
                self.expect(&Tok::RParen)
            }
            Some(Tok::Ident(name)) => {
                if self.eat(&Tok::LParen) {
                    let args = self.args()?;
                    return self.call(&name, args, col);
                }
                match name.as_str() {
                    "x" => self.emit(Op::X, 0, 1),
                    "i" => self.emit(Op::I, 0, 1),
                    _ => match constant(&name) {
                        Some(v) => self.emit(Op::Const(v), 0, 1),
                        None => bail!(
                            "unknown name `{name}` — the expression may use \
                             `x`, `i`, `n`, `pi`, `tau`, `e` (column {col})"
                        ),
                    },
                }
            }
            Some(t) => bail!("unexpected {} (column {col})", t.describe()),
            None => bail!("expression is incomplete (column {col})"),
        }
    }
}

/// Parse Rust-flavoured expression text into an RT-evaluable program.
/// Control thread only — it allocates.
pub fn compile(src: &str) -> Result<MathProgram> {
    anyhow::ensure!(!src.trim().is_empty(), "expression is empty");
    let tokens = tokenize(src)?;
    let mut parser = Parser {
        tokens: &tokens,
        pos: 0,
        ops: Vec::new(),
        depth: 0,
        max_depth: 0,
    };
    parser.expr()?;
    if parser.pos < tokens.len() {
        let t = &tokens[parser.pos];
        bail!(
            "unexpected {} after the expression (column {})",
            t.tok.describe(),
            t.col
        );
    }
    anyhow::ensure!(parser.depth == 1, "expression did not produce a value");
    Ok(MathProgram { ops: parser.ops })
}

// ----------------------------------------------------------- RT plumbing

/// Control-side plumbing for one Math node: ships compiled programs to the
/// RT module and reclaims replaced ones for an off-RT drop. `error` is the
/// message for the text the user last typed (None when it compiled) — it
/// is derived, never persisted.
pub struct MathControl {
    tx: rtrb::Producer<Arc<MathProgram>>,
    garbage_rx: rtrb::Consumer<Arc<MathProgram>>,
    pub error: Option<String>,
}

impl MathControl {
    pub fn new(
        tx: rtrb::Producer<Arc<MathProgram>>,
        garbage_rx: rtrb::Consumer<Arc<MathProgram>>,
    ) -> Self {
        MathControl {
            tx,
            garbage_rx,
            error: None,
        }
    }

    pub fn push(&mut self, program: Arc<MathProgram>) -> Result<()> {
        while self.garbage_rx.pop().is_ok() {}
        self.tx
            .push(program)
            .map_err(|_| anyhow!("too many pending expression edits"))
    }
}

/// The RT-side Math module: swaps in compiled programs from the ring and
/// evaluates one per output jack per sample. Zero allocations/locks.
pub struct MathRtModule {
    rx: rtrb::Consumer<Arc<MathProgram>>,
    garbage_tx: rtrb::Producer<Arc<MathProgram>>,
    program: Option<Arc<MathProgram>>,
}

impl MathRtModule {
    pub fn new(
        rx: rtrb::Consumer<Arc<MathProgram>>,
        garbage_tx: rtrb::Producer<Arc<MathProgram>>,
        program: Option<Arc<MathProgram>>,
    ) -> Self {
        MathRtModule {
            rx,
            garbage_tx,
            program,
        }
    }
}

impl HostModule for MathRtModule {
    fn process(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        _mask: u64,
        frames: usize,
    ) {
        while let Ok(p) = self.rx.pop() {
            if let Some(old) = self.program.replace(p) {
                // Off-RT drop; a full garbage ring drops here instead
                // (bounded, edit-only path).
                let _ = self.garbage_tx.push(old);
            }
        }
        let Some(program) = self.program.as_ref() else {
            for out in outputs.iter_mut() {
                out[..frames].fill(0.0);
            }
            return;
        };
        for (i, out) in outputs.iter_mut().enumerate() {
            let index = i as f32;
            for (s, slot) in out[..frames].iter_mut().enumerate() {
                *slot = program.eval(inputs[IN_X][s], index);
            }
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(src: &str, x: f32, i: f32) -> f32 {
        compile(src).unwrap().eval(x, i)
    }

    #[test]
    fn the_default_expression_compiles_and_fans_the_outputs_out() {
        let p = MathState::default().compile().unwrap();
        for i in 0..MATH_OUTPUTS {
            assert_eq!(p.eval(1.5, i as f32), 1.5 + i as f32);
        }
    }

    #[test]
    fn arithmetic_follows_rust_precedence() {
        assert_eq!(ev("1 + 2 * 3", 0.0, 0.0), 7.0);
        assert_eq!(ev("(1 + 2) * 3", 0.0, 0.0), 9.0);
        assert_eq!(ev("-2 * 3", 0.0, 0.0), -6.0);
        assert_eq!(ev("7 % 4", 0.0, 0.0), 3.0);
        assert_eq!(ev("8 / 2 / 2", 0.0, 0.0), 2.0);
        assert_eq!(ev("1 - 2 - 3", 0.0, 0.0), -4.0);
    }

    #[test]
    fn the_ticket_expression_reads_x_and_the_output_index() {
        // (3 * (x + i)).pow(2) — clamped to the rails, which is what keeps
        // a wild expression from blasting whatever it is patched into.
        assert_eq!(ev("(3 * (x + i)).pow(2)", 0.0, 1.0), 9.0);
        assert_eq!(ev("(3 * (x + i)).pow(2)", -1.0, 0.0), 9.0);
        assert_eq!(ev("(3 * (x + i)).pow(2)", 2.0, 3.0), OUT_RAIL);
    }

    #[test]
    fn methods_free_functions_and_literals_all_parse() {
        assert!((ev("x.sin()", std::f32::consts::FRAC_PI_2, 0.0) - 1.0).abs() < 1e-6);
        assert!((ev("sin(x)", std::f32::consts::FRAC_PI_2, 0.0) - 1.0).abs() < 1e-6);
        assert_eq!(ev("x.abs()", -3.0, 0.0), 3.0);
        assert_eq!(ev("x.max(i)", 2.0, 5.0), 5.0);
        assert_eq!(ev("max(x, i)", 2.0, 5.0), 5.0);
        assert_eq!(ev("x.clamp(-1.0, 1.0)", 9.0, 0.0), 1.0);
        assert_eq!(ev("2.0.sqrt().powi(2)", 0.0, 0.0).round(), 2.0);
        assert_eq!(ev("1_000.0 * 1e-3", 0.0, 0.0), 1.0);
        assert_eq!(ev("2.5f32 * 2.0", 0.0, 0.0), 5.0);
        assert_eq!(ev("n", 0.0, 0.0), MATH_OUTPUTS as f32);
        assert!((ev("pi", 0.0, 0.0) - std::f32::consts::PI).abs() < 1e-6);
        // A trailing comma in a call is legal Rust.
        assert_eq!(ev("min(3.0, 1.0,)", 0.0, 0.0), 1.0);
    }

    #[test]
    fn casts_are_accepted_and_integer_ones_truncate() {
        assert_eq!(ev("i as f32 * 2.0", 0.0, 3.0), 6.0);
        assert_eq!(ev("x as i32", 2.7, 0.0), 2.0);
        assert_eq!(ev("x as i32", -2.7, 0.0), -2.0);
        // Rust saturates a negative float cast to an unsigned integer.
        assert_eq!(ev("x as usize", -2.7, 0.0), 0.0);
    }

    #[test]
    fn a_non_finite_or_out_of_range_result_reads_as_a_safe_voltage() {
        assert_eq!(ev("1.0 / 0.0", 0.0, 0.0), 0.0);
        assert_eq!(ev("(0.0 - 1.0).sqrt()", 0.0, 0.0), 0.0);
        assert_eq!(ev("x * 1000.0", 5.0, 0.0), OUT_RAIL);
        assert_eq!(ev("x * 1000.0", -5.0, 0.0), -OUT_RAIL);
        // An inverted clamp range would panic in Rust; here it pins low.
        assert_eq!(ev("x.clamp(2.0, 1.0)", 9.0, 0.0), 2.0);
    }

    #[test]
    fn bad_expressions_report_where_they_broke_and_never_panic() {
        for src in [
            "",
            "   ",
            "x +",
            "(x + 1",
            "x + 1)",
            "y * 2",
            "x.wobble()",
            "sin(x, i)",
            "pow(x)",
            "x as str",
            "x $ 2",
            "x 3",
            "x.()",
        ] {
            let err = compile(src).unwrap_err().to_string();
            assert!(!err.is_empty(), "{src:?} produced an empty message");
        }
        assert!(compile("y * 2").unwrap_err().to_string().contains("`y`"));
        assert!(compile("x +")
            .unwrap_err()
            .to_string()
            .contains("incomplete"));
    }

    #[test]
    fn a_deeply_nested_expression_is_rejected_rather_than_overflowing() {
        let deep = format!(
            "{}1{}",
            "(1 + ".repeat(MAX_STACK + 4),
            ")".repeat(MAX_STACK + 4)
        );
        assert!(compile(&deep).is_err());
        let long = format!("1{}", " + 1".repeat(MAX_OPS));
        assert!(compile(&long).is_err());
    }
}
