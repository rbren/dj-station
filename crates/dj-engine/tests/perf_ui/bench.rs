//! The measuring tape for the audio-render benchmarks: fixture sizing,
//! throughput, and the two shapes of assertion they make.

use std::time::Instant;

/// The CI perf job sets this; locally it is off, so the suite runs on
/// fixtures a tenth of the size and still exercises every path.
pub fn heavy() -> bool {
    matches!(std::env::var("DJ_PERF_HEAVY").as_deref(), Ok("1"))
}

/// Pick a fixture size for this run.
pub fn sized<T>(normal: T, big: T) -> T {
    if heavy() {
        big
    } else {
        normal
    }
}

/// Run the workload once, UNTIMED.
///
/// The first render in the process pays for things no later one does:
/// building the wasm extensions (a `cargo build` of every module, once
/// per checkout), reading them off disk, and wasmtime's JIT compiling
/// each one. Timing that would report 0.8× realtime for a path that runs
/// at 20×, which is how a benchmark ends up lying in whichever direction
/// the test order happens to fall.
pub fn warmup<T>(f: impl FnOnce() -> T) {
    let _ = f();
}

/// One measured render: how much audio came out, and how long that took.
pub struct Throughput {
    pub name: String,
    pub audio_secs: f64,
    pub elapsed_secs: f64,
}

impl Throughput {
    /// Seconds of audio produced per second of wall clock. The only
    /// figure worth comparing across machines.
    pub fn x_realtime(&self) -> f64 {
        self.audio_secs / self.elapsed_secs.max(1e-9)
    }
}

/// Time `f`, which is expected to produce `audio_secs` of audio, and
/// print the result as one `[perf]` line.
pub fn render<T>(name: &str, audio_secs: f64, f: impl FnOnce() -> T) -> (T, Throughput) {
    let t0 = Instant::now();
    let out = f();
    let elapsed = t0.elapsed().as_secs_f64();
    let t = Throughput {
        name: name.to_string(),
        audio_secs,
        elapsed_secs: elapsed,
    };
    println!(
        "[perf] {name}: {audio_secs:.1}s of audio in {elapsed:.2}s = {:.1}x realtime",
        t.x_realtime()
    );
    (out, t)
}

/// THE GATE. Fails when throughput has fallen through the floor — set
/// several times below the measured figure, so what trips it is a
/// regression nobody could call noise.
pub fn expect_throughput(t: &Throughput, min_x_realtime: f64) {
    assert!(
        t.x_realtime() >= min_x_realtime,
        "PERF REGRESSION — {}: {:.1}x realtime, floor is {:.1}x \
         ({:.1}s of audio took {:.2}s).\nIf this cost is deliberate and understood, move the \
         floor and update the numbers in reports/PERF_BASELINES.md.",
        t.name,
        t.x_realtime(),
        min_x_realtime,
        t.audio_secs,
        t.elapsed_secs,
    );
}

/// The box-independent gate: the same work over `ratio` times the
/// material must not cost more than `ratio × tolerance`. Catches an
/// accidental quadratic, which a throughput floor with generous headroom
/// can hide until the fixture grows.
pub fn expect_scaling(small: &Throughput, big: &Throughput, ratio: f64, tolerance: f64) {
    let grew = big.elapsed_secs / small.elapsed_secs.max(1e-9);
    println!(
        "[perf] scaling {} -> {}: x{ratio} material cost x{grew:.2}",
        small.name, big.name
    );
    assert!(
        grew <= ratio * tolerance,
        "PERF REGRESSION — {} grew x{grew:.2} for x{ratio} the material (ceiling x{:.2}). \
         Something in this path is superlinear.",
        big.name,
        ratio * tolerance,
    );
}
