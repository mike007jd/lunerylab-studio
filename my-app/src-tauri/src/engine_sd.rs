use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::download::canonical_models_roots;
use crate::residency_global;
use crate::sd_cpp_resident::SdCppResident;

static SD_INFLIGHT_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
pub(crate) fn sd_inflight_child() -> &'static Mutex<Option<Child>> {
    SD_INFLIGHT_CHILD.get_or_init(|| Mutex::new(None))
}

/// Serialize spawn registration with stop/reset/shutdown so there is no
/// check-to-spawn TOCTOU. Lock order is always gate → child-slot.
static SD_SPAWN_GATE: OnceLock<Mutex<()>> = OnceLock::new();
pub(crate) fn sd_spawn_gate() -> &'static Mutex<()> {
    SD_SPAWN_GATE.get_or_init(|| Mutex::new(()))
}

static SD_GENERATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
pub(crate) fn sd_generate_lock() -> &'static Mutex<()> {
    SD_GENERATE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Cooperative cancel flag for the in-flight SD batch. Set by the `/sd-cancel`
/// bridge route (which the TS side hits when the request's AbortSignal fires);
/// the per-image poll loop checks it every ~200 ms and tears the batch down.
/// `bridge_sd_generate` resets it to false on entry so a previous cancel can't
/// abort a fresh batch.
static SD_CANCEL: OnceLock<AtomicBool> = OnceLock::new();
pub(crate) fn sd_cancel_flag() -> &'static AtomicBool {
    SD_CANCEL.get_or_init(|| AtomicBool::new(false))
}

/// Runtime epoch advanced by stop/reset/shutdown. Every accepted generate
/// captures the epoch before queueing and rechecks it after the generate mutex
/// and before every native spawn so stale queued work cannot start a process.
static SD_RUNTIME_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn sd_runtime_epoch() -> u64 {
    SD_RUNTIME_EPOCH.load(Ordering::SeqCst)
}

pub(crate) fn advance_sd_runtime_epoch() -> u64 {
    SD_RUNTIME_EPOCH
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1)
}

/// Pure admission decision used by generate and by deterministic tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SdSpawnDecision {
    Allow,
    Revoked,
    Canceled,
}

pub(crate) fn sd_spawn_decision(
    captured_epoch: u64,
    current_epoch: u64,
    canceled: bool,
) -> SdSpawnDecision {
    if captured_epoch != current_epoch {
        SdSpawnDecision::Revoked
    } else if canceled {
        SdSpawnDecision::Canceled
    } else {
        SdSpawnDecision::Allow
    }
}

pub(crate) fn sd_may_spawn(captured_epoch: u64, current_epoch: u64, canceled: bool) -> bool {
    sd_spawn_decision(captured_epoch, current_epoch, canceled) == SdSpawnDecision::Allow
}

static SD_PROGRESS: OnceLock<Mutex<Option<SdProgress>>> = OnceLock::new();
fn sd_progress_slot() -> &'static Mutex<Option<SdProgress>> {
    SD_PROGRESS.get_or_init(|| Mutex::new(None))
}

struct SdModelDeleteLease {
    lease_id: String,
    expires_at: Instant,
}

#[derive(Default)]
struct SdModelState {
    active_path: Option<String>,
    delete_leases: HashMap<String, SdModelDeleteLease>,
}

static SD_MODEL_STATE: OnceLock<Mutex<SdModelState>> = OnceLock::new();
fn sd_model_state() -> &'static Mutex<SdModelState> {
    SD_MODEL_STATE.get_or_init(|| Mutex::new(SdModelState::default()))
}

fn normalize_sd_model_path(value: &str) -> String {
    let path = PathBuf::from(value);
    if let Ok(canonical) = std::fs::canonicalize(&path) {
        return canonical.to_string_lossy().to_string();
    }
    path.parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .and_then(|parent| path.file_name().map(|name| parent.join(name)))
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

pub(crate) fn sd_active_model_path() -> Option<String> {
    sd_model_state()
        .lock()
        .ok()
        .and_then(|state| state.active_path.clone())
}

pub(crate) fn acquire_sd_model_delete_lease(
    model_path: &str,
    lease_id: &str,
) -> Result<(), String> {
    if lease_id.is_empty() || lease_id.len() > 128 {
        return Err("Invalid SD model deletion lease".to_string());
    }
    let model_path = normalize_sd_model_path(model_path);
    let now = Instant::now();
    let mut state = sd_model_state()
        .lock()
        .map_err(|_| "SD model state lock poisoned".to_string())?;
    state
        .delete_leases
        .retain(|_, lease| lease.expires_at > now);
    if let Some(existing) = state.delete_leases.get(&model_path) {
        if existing.lease_id != lease_id {
            return Err("Image model is already being deleted".to_string());
        }
    }
    state.delete_leases.insert(
        model_path,
        SdModelDeleteLease {
            lease_id: lease_id.to_string(),
            expires_at: now + Duration::from_secs(60),
        },
    );
    Ok(())
}

pub(crate) fn release_sd_model_delete_lease(model_path: &str, lease_id: &str) {
    let model_path = normalize_sd_model_path(model_path);
    if let Ok(mut state) = sd_model_state().lock() {
        if state
            .delete_leases
            .get(&model_path)
            .map(|lease| lease.lease_id.as_str())
            == Some(lease_id)
        {
            state.delete_leases.remove(&model_path);
        }
    }
}

struct ActiveSdModelGuard {
    model_path: Option<String>,
}

impl ActiveSdModelGuard {
    fn set(path: Option<String>) -> Result<Self, String> {
        let path = path.map(|value| normalize_sd_model_path(&value));
        let now = Instant::now();
        let mut state = sd_model_state()
            .lock()
            .map_err(|_| "SD model state lock poisoned".to_string())?;
        state
            .delete_leases
            .retain(|_, lease| lease.expires_at > now);
        if path
            .as_ref()
            .is_some_and(|model_path| state.delete_leases.contains_key(model_path))
        {
            return Err("Image model is being deleted".to_string());
        }
        state.active_path = path.clone();
        Ok(Self { model_path: path })
    }
}

impl Drop for ActiveSdModelGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = sd_model_state().lock() {
            if state.active_path == self.model_path {
                state.active_path = None;
            }
        }
    }
}

/// A cancel can reach the bridge before the long-running generate request has
/// acquired the SD lock. Keep a small run-id keyed queue so that race cannot
/// start a native process after the user already canceled it.
static SD_PENDING_CANCELS: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
fn sd_pending_cancels() -> &'static Mutex<VecDeque<String>> {
    SD_PENDING_CANCELS.get_or_init(|| Mutex::new(VecDeque::new()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SdProgressPhase {
    Preparing,
    Sampling,
    Finalizing,
    Completed,
    Canceled,
    Failed,
}

impl SdProgressPhase {
    fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Canceled | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SdProgress {
    run_id: String,
    phase: SdProgressPhase,
    current_image: usize,
    total_images: usize,
    step: Option<u32>,
    total_steps: Option<u32>,
    seconds_per_step: Option<f64>,
    started_at_ms: u64,
    updated_at_ms: u64,
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn set_sd_progress(progress: SdProgress) {
    if let Ok(mut slot) = sd_progress_slot().lock() {
        *slot = Some(progress);
    }
}

pub(crate) fn sd_progress_for_run(run_id: &str) -> Option<SdProgress> {
    sd_progress_slot().lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|progress| progress.run_id == run_id)
            .cloned()
    })
}

fn set_sd_phase(run_id: &str, phase: SdProgressPhase) -> bool {
    let Ok(mut slot) = sd_progress_slot().lock() else {
        return false;
    };
    let Some(progress) = slot.as_mut().filter(|progress| progress.run_id == run_id) else {
        return false;
    };
    if progress.phase.is_terminal() {
        return progress.phase == phase;
    }
    progress.phase = phase;
    progress.updated_at_ms = epoch_ms();
    true
}

fn set_sd_image_phase(
    run_id: &str,
    current_image: usize,
    total_images: usize,
    phase: SdProgressPhase,
) {
    let Ok(mut slot) = sd_progress_slot().lock() else {
        return;
    };
    let Some(progress) = slot.as_mut().filter(|progress| progress.run_id == run_id) else {
        return;
    };
    if progress.phase.is_terminal() {
        return;
    }
    progress.phase = phase;
    progress.current_image = current_image;
    progress.total_images = total_images;
    if progress.phase == SdProgressPhase::Preparing {
        progress.step = None;
        progress.total_steps = None;
        progress.seconds_per_step = None;
    }
    progress.updated_at_ms = epoch_ms();
}

pub(crate) fn bridge_finish_sd(run_id: &str, phase: SdProgressPhase) -> bool {
    if !matches!(
        phase,
        SdProgressPhase::Completed | SdProgressPhase::Canceled | SdProgressPhase::Failed
    ) {
        return false;
    }
    set_sd_phase(run_id, phase)
}

fn queue_pending_cancel(run_id: &str) {
    let Ok(mut pending) = sd_pending_cancels().lock() else {
        return;
    };
    if pending.iter().any(|queued| queued == run_id) {
        return;
    }
    const MAX_PENDING_CANCELS: usize = 64;
    if pending.len() == MAX_PENDING_CANCELS {
        pending.pop_front();
    }
    pending.push_back(run_id.to_string());
}

fn take_pending_cancel(run_id: &str) -> bool {
    let Ok(mut pending) = sd_pending_cancels().lock() else {
        return false;
    };
    let Some(index) = pending.iter().position(|queued| queued == run_id) else {
        return false;
    };
    pending.remove(index);
    true
}

/// Locate the bundled stable-diffusion.cpp binary. Mirrors `bridge_engine_root()`
/// resolution but targets the `sd/` subdir (kept separate so its dylibs never
/// collide with the llama.cpp libs that live directly in `engine/`).
/// NOTE: the pinned release ships the binary as `sd-cli` / `sd-cli.exe`
/// (verified in Task 1 — NOT `sd`).
pub(crate) fn sd_binary_path() -> Option<PathBuf> {
    let bin_name = if cfg!(windows) {
        "sd-cli.exe"
    } else {
        "sd-cli"
    };
    let executable = std::env::current_exe().ok();
    let dev_cwd = cfg!(debug_assertions)
        .then(std::env::current_dir)
        .transpose()
        .ok()
        .flatten();
    crate::engine_paths::resolve_engine_path(
        executable.as_deref(),
        &["sd", bin_name],
        dev_cwd.as_deref(),
        cfg!(debug_assertions),
        std::path::Path::is_file,
    )
}

fn stop_sd_child() {
    let mut guard = sd_inflight_child()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        // Reap the killed child so it does not linger as a zombie on a
        // cancel-without-exit path (mirrors the llama Child Drop pattern).
        let _ = child.wait();
    }
    *guard = None;
}

/// Teardown under the spawn gate: advance epoch, then kill any registered child
/// before returning. A worker holding the gate finishes register-or-abort first;
/// a worker that acquires the gate afterwards observes the new epoch and must
/// not invoke spawn.
pub(crate) fn bridge_stop_sd() {
    let _gate = match sd_spawn_gate().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let _ = advance_sd_runtime_epoch();
    sd_cancel_flag().store(true, Ordering::SeqCst);
    if let Ok(slot) = sd_progress_slot().lock() {
        if let Some(progress) = slot.as_ref() {
            let run_id = progress.run_id.clone();
            drop(slot);
            set_sd_phase(&run_id, SdProgressPhase::Canceled);
        }
    }
    stop_sd_child();
}

/// Testable spawn/register seam held under `sd_spawn_gate`. Returns `Ok(None)`
/// when the captured epoch is stale or cancel is set — `spawn_fn` is never
/// called in that case. On success the child is registered in the inflight slot
/// before the gate is released.
#[cfg(test)]
pub(crate) fn sd_spawn_and_register_under_gate<F>(
    captured_epoch: u64,
    mut spawn_fn: F,
) -> Result<Option<()>, String>
where
    F: FnMut() -> Result<Child, String>,
{
    let _gate = sd_spawn_gate()
        .lock()
        .map_err(|_| "sd spawn gate poisoned".to_string())?;
    if !sd_may_spawn(
        captured_epoch,
        sd_runtime_epoch(),
        sd_cancel_flag().load(Ordering::SeqCst),
    ) {
        return Ok(None);
    }
    let child = spawn_fn()?;
    let mut slot = sd_inflight_child()
        .lock()
        .map_err(|_| "sd in-flight lock poisoned".to_string())?;
    *slot = Some(child);
    Ok(Some(()))
}

pub(crate) fn bridge_stop_sd_if_model_path(expected_model_path: &str) -> bool {
    let expected_model_path = normalize_sd_model_path(expected_model_path);
    {
        let Ok(state) = sd_model_state().lock() else {
            return false;
        };
        if state.active_path.as_deref() != Some(expected_model_path.as_str()) {
            return false;
        }
    }
    // Release the active-path lock before stopping so the generate thread can
    // finish and clear its guard. The generate lock still serializes batches.
    bridge_stop_sd();
    for _ in 0..200 {
        if sd_active_model_path().as_deref() != Some(expected_model_path.as_str()) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Cancel only the matching run. Unknown run ids are queued briefly because
/// the cancel request can beat the generate request to the bridge lock.
pub(crate) fn bridge_cancel_sd(run_id: &str) -> bool {
    let matching_progress = sd_progress_for_run(run_id);
    match matching_progress {
        Some(progress) if progress.phase == SdProgressPhase::Canceled => true,
        Some(progress) if progress.phase.is_terminal() => false,
        Some(_) => {
            // Same gate as stop/spawn so cancel cannot race a mid-spawn worker.
            let _gate = match sd_spawn_gate().lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let _ = advance_sd_runtime_epoch();
            sd_cancel_flag().store(true, Ordering::SeqCst);
            set_sd_phase(run_id, SdProgressPhase::Canceled);
            stop_sd_child();
            true
        }
        None => {
            queue_pending_cancel(run_id);
            true
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SdGenerateBody {
    run_id: String,
    /// One argv per image (each already includes `-o <path>` and `-s <seed>`),
    /// excluding the binary itself.
    runs: Vec<Vec<String>>,
    /// Hard wall-clock cap per single `sd-cli` invocation.
    timeout_secs: u64,
}

#[derive(Serialize)]
pub(crate) struct SdRunResult {
    ok: bool,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SdProgressSample {
    step: u32,
    total_steps: u32,
    seconds_per_step: f64,
}

fn parse_sd_progress_line(line: &str) -> Option<SdProgressSample> {
    let mut step_and_total = None;
    let mut seconds_per_step = None;

    for token in line.split_whitespace() {
        if step_and_total.is_none() {
            let candidate = token
                .trim_matches(|character: char| !character.is_ascii_digit() && character != '/');
            if let Some((step, total)) = candidate.split_once('/') {
                if let (Ok(step), Ok(total)) = (step.parse::<u32>(), total.parse::<u32>()) {
                    if step > 0 && total > 0 && step <= total {
                        step_and_total = Some((step, total));
                    }
                }
            }
        }

        if seconds_per_step.is_none() {
            if let Some(unit_index) = token.find("s/it") {
                let value = token[..unit_index]
                    .trim_matches(|character: char| !character.is_ascii_digit() && character != '.')
                    .parse::<f64>()
                    .ok();
                seconds_per_step = value.filter(|value| value.is_finite() && *value > 0.0);
            } else if let Some(unit_index) = token.find("it/s") {
                let iterations_per_second = token[..unit_index]
                    .trim_matches(|character: char| !character.is_ascii_digit() && character != '.')
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite() && *value > 0.0);
                seconds_per_step = iterations_per_second.map(|value| 1.0 / value);
            }
        }
    }

    let (step, total_steps) = step_and_total?;
    Some(SdProgressSample {
        step,
        total_steps,
        seconds_per_step: seconds_per_step?,
    })
}

#[derive(Default)]
struct SdProgressParser {
    buffer: String,
    last_sample: Option<SdProgressSample>,
}

impl SdProgressParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<SdProgressSample> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        if self.buffer.len() > 8 * 1024 {
            let keep_from = self.buffer.len() - 8 * 1024;
            self.buffer.drain(..keep_from);
        }

        let mut samples = Vec::new();
        for frame in self.buffer.split(['\r', '\n']) {
            let Some(sample) = parse_sd_progress_line(frame) else {
                continue;
            };
            if self.last_sample != Some(sample) {
                self.last_sample = Some(sample);
                samples.push(sample);
            }
        }

        let tail = self
            .buffer
            .rsplit(['\r', '\n'])
            .next()
            .unwrap_or_default()
            .to_string();
        self.buffer = tail;
        samples
    }
}

fn update_sd_sampling_progress(
    run_id: &str,
    current_image: usize,
    total_images: usize,
    sample: SdProgressSample,
) {
    let Ok(mut slot) = sd_progress_slot().lock() else {
        return;
    };
    let Some(progress) = slot.as_mut().filter(|progress| progress.run_id == run_id) else {
        return;
    };
    if progress.phase.is_terminal() {
        return;
    }
    progress.phase = SdProgressPhase::Sampling;
    progress.current_image = current_image;
    progress.total_images = total_images;
    progress.step = Some(sample.step);
    progress.total_steps = Some(sample.total_steps);
    progress.seconds_per_step = Some(sample.seconds_per_step);
    progress.updated_at_ms = epoch_ms();
}

fn append_stderr_tail(tail: &Arc<Mutex<VecDeque<u8>>>, chunk: &[u8]) {
    const MAX_STDERR_TAIL_BYTES: usize = 800;
    let Ok(mut bytes) = tail.lock() else {
        return;
    };
    bytes.extend(chunk);
    while bytes.len() > MAX_STDERR_TAIL_BYTES {
        bytes.pop_front();
    }
}

fn spawn_sd_output_reader<R>(
    mut reader: R,
    run_id: String,
    current_image: usize,
    total_images: usize,
    stderr_tail: Option<Arc<Mutex<VecDeque<u8>>>>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut parser = SdProgressParser::default();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            if let Some(tail) = &stderr_tail {
                append_stderr_tail(tail, &chunk[..read]);
            }
            for sample in parser.push(&chunk[..read]) {
                update_sd_sampling_progress(&run_id, current_image, total_images, sample);
            }
        }
    })
}

fn canceled_run_results(total_images: usize) -> Vec<SdRunResult> {
    (0..total_images)
        .map(|_| SdRunResult {
            ok: false,
            error: Some("sd canceled by client".to_string()),
        })
        .collect()
}

fn begin_sd_run(run_id: &str, total_images: usize) -> bool {
    sd_cancel_flag().store(false, Ordering::SeqCst);
    let started_at_ms = epoch_ms();
    set_sd_progress(SdProgress {
        run_id: run_id.to_string(),
        phase: SdProgressPhase::Preparing,
        current_image: usize::from(total_images > 0),
        total_images,
        step: None,
        total_steps: None,
        seconds_per_step: None,
        started_at_ms,
        updated_at_ms: started_at_ms,
    });
    if !take_pending_cancel(run_id) {
        return true;
    }
    sd_cancel_flag().store(true, Ordering::SeqCst);
    set_sd_phase(run_id, SdProgressPhase::Canceled);
    false
}

pub(crate) fn valid_sd_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 128
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn bridge_sd_generate(body: SdGenerateBody) -> Result<Vec<SdRunResult>, String> {
    if !valid_sd_run_id(&body.run_id) {
        return Err("Invalid SD run id".to_string());
    }
    let run_id = body.run_id.clone();
    let total_images = body.runs.len();
    let bin = sd_binary_path()
        .ok_or_else(|| "Bundled stable-diffusion.cpp engine was not found".to_string())?;
    let lib_dir = bin
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Could not resolve sd engine directory".to_string())?;
    let timeout = Duration::from_secs(body.timeout_secs.clamp(30, 1800));

    // SECURITY: validate every run's argv BEFORE acquiring the lock / spawning.
    // `-o`/`--output` must land under the temp output dir the Next side uses;
    // `-m`/`--model`/`--diffusion-model` must be a models-root path or an
    // existing imported model file. A bad value aborts the whole batch — we
    // never spawn sd-cli against an out-of-bounds path.
    let output_root = canonical_sd_output_root()?;
    let models_roots = canonical_models_roots()?;
    for argv in &body.runs {
        validate_sd_run_argv(argv, &output_root, &models_roots)?;
    }

    // Capture before waiting so stop/reset/shutdown during the queue wait
    // revokes this request without a native spawn.
    let captured_epoch = sd_runtime_epoch();

    let _generate_guard = sd_generate_lock()
        .lock()
        .map_err(|_| "sd generation lock poisoned".to_string())?;
    if !sd_may_spawn(
        captured_epoch,
        sd_runtime_epoch(),
        sd_cancel_flag().load(Ordering::SeqCst),
    ) {
        return Ok(canceled_run_results(total_images));
    }
    let _active_model = ActiveSdModelGuard::set(
        body.runs
            .first()
            .and_then(|argv| sd_model_path_from_argv(argv)),
    )?;

    // Fresh batch: replace stale progress, clear the global cancel bit from the
    // prior run, and bound the WHOLE
    // batch (not just each image) so a multi-image request can't outrun the
    // caller's overall deadline. The batch cap is the per-image timeout times
    // the image count, hard-capped at 1 h.
    if !begin_sd_run(&run_id, total_images) {
        return Ok(canceled_run_results(total_images));
    }
    if !sd_may_spawn(captured_epoch, sd_runtime_epoch(), false) {
        set_sd_phase(&run_id, SdProgressPhase::Canceled);
        return Ok(canceled_run_results(total_images));
    }
    let batch_deadline = Instant::now()
        + timeout
            .saturating_mul(total_images.max(1) as u32)
            .min(Duration::from_secs(3600));

    // Best-effort SD residency registration. Argv layout: each run's `-m` or
    // `--diffusion-model` arg points at the primary model file. We parse the
    // first run's model arg as the id (all runs in a batch use the same
    // checkpoint). If we can't find it, skip residency — the per-spawn path
    // still works, we just don't account for its VRAM in the budget.
    let sd_lease = if let Some(id) = body
        .runs
        .first()
        .and_then(|argv| sd_model_id_from_argv(argv))
    {
        if let Some(residency) = residency_global() {
            let resident = SdCppResident::new(&id, None, bridge_stop_sd);
            let lease = residency.register_and_activate(resident).map_err(|err| {
                eprintln!("[lunerylab] sd residency register failed: {err}");
                format!("Not enough VRAM for this model - {err}")
            })?;
            Some(lease)
        } else {
            None
        }
    } else {
        None
    };

    let mut results: Vec<SdRunResult> = Vec::with_capacity(total_images);
    let mut canceled = false;
    let mut any_success = false;
    for (index, args) in body.runs.into_iter().enumerate() {
        match sd_spawn_decision(
            captured_epoch,
            sd_runtime_epoch(),
            sd_cancel_flag().load(Ordering::SeqCst),
        ) {
            SdSpawnDecision::Allow => {}
            SdSpawnDecision::Revoked | SdSpawnDecision::Canceled => {
                canceled = true;
                break;
            }
        }
        let current_image = index + 1;
        set_sd_image_phase(
            &run_id,
            current_image,
            total_images,
            SdProgressPhase::Preparing,
        );
        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Defensively help the dynamic loader find sibling libs (sd.cpp release
        // layout differs from llama.cpp; harmless if unused).
        #[cfg(not(windows))]
        cmd.env("DYLD_LIBRARY_PATH", &lib_dir);
        #[cfg(windows)]
        {
            let prev = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{};{}", lib_dir.display(), prev));
        }

        // Hold the spawn gate across epoch recheck → spawn → register so stop
        // cannot return while an old-epoch spawn is still runnable, and a
        // teardown that wins the gate makes spawn_fn unreachable.
        enum GatedSpawn {
            Revoked,
            SpawnFailed(String),
            Started {
                stdout_reader: Option<thread::JoinHandle<()>>,
                stderr_reader: Option<thread::JoinHandle<()>>,
                stderr_tail: Arc<Mutex<VecDeque<u8>>>,
            },
        }
        let gated = {
            let _gate = sd_spawn_gate()
                .lock()
                .map_err(|_| "sd spawn gate poisoned".to_string())?;
            if !sd_may_spawn(
                captured_epoch,
                sd_runtime_epoch(),
                sd_cancel_flag().load(Ordering::SeqCst),
            ) {
                GatedSpawn::Revoked
            } else {
                match cmd.spawn() {
                    Ok(mut child) => {
                        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
                        let stdout_reader = child.stdout.take().map(|stdout| {
                            spawn_sd_output_reader(
                                stdout,
                                run_id.clone(),
                                current_image,
                                total_images,
                                None,
                            )
                        });
                        let stderr_reader = child.stderr.take().map(|stderr| {
                            spawn_sd_output_reader(
                                stderr,
                                run_id.clone(),
                                current_image,
                                total_images,
                                Some(Arc::clone(&stderr_tail)),
                            )
                        });
                        let mut slot = sd_inflight_child()
                            .lock()
                            .map_err(|_| "sd in-flight lock poisoned".to_string())?;
                        *slot = Some(child);
                        GatedSpawn::Started {
                            stdout_reader,
                            stderr_reader,
                            stderr_tail,
                        }
                    }
                    Err(err) => GatedSpawn::SpawnFailed(format!("spawn failed: {err}")),
                }
            }
        };
        let (stdout_reader, stderr_reader, stderr_tail) = match gated {
            GatedSpawn::Revoked => {
                canceled = true;
                break;
            }
            GatedSpawn::SpawnFailed(err) => {
                results.push(SdRunResult {
                    ok: false,
                    error: Some(err),
                });
                continue;
            }
            GatedSpawn::Started {
                stdout_reader,
                stderr_reader,
                stderr_tail,
            } => (stdout_reader, stderr_reader, stderr_tail),
        };

        // Poll for completion with a wall-clock deadline; kill on timeout. The
        // effective deadline is the sooner of this image's own timeout and the
        // whole-batch cap. Cancellation is checked BEFORE process completion:
        // the cancel route removes the child from the slot after reaping it,
        // and the old ordering interpreted that empty slot as ordinary finish
        // and briefly launched the next image.
        let deadline = (Instant::now() + timeout).min(batch_deadline);
        let outcome: Result<std::process::ExitStatus, String> = loop {
            if sd_cancel_flag().load(Ordering::SeqCst) {
                stop_sd_child();
                canceled = true;
                break Err("sd canceled by client".to_string());
            }
            let finished = {
                let mut slot = sd_inflight_child()
                    .lock()
                    .map_err(|_| "sd in-flight lock poisoned".to_string())?;
                match slot.as_mut() {
                    Some(c) => c.try_wait().map_err(|e| e.to_string())?.is_some(),
                    None => true, // killed externally (app exit / cancel)
                }
            };
            if finished {
                let mut slot = sd_inflight_child()
                    .lock()
                    .map_err(|_| "sd in-flight lock poisoned".to_string())?;
                match slot.take() {
                    Some(mut child) => break child.wait().map_err(|error| error.to_string()),
                    None => break Err("sd process was canceled".to_string()),
                }
            }
            if Instant::now() >= deadline {
                let mut slot = sd_inflight_child()
                    .lock()
                    .map_err(|_| "sd in-flight lock poisoned".to_string())?;
                if let Some(c) = slot.as_mut() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                *slot = None;
                break Err(format!("sd timed out after {}s", timeout.as_secs()));
            }
            thread::sleep(Duration::from_millis(200));
        };

        if let Some(reader) = stdout_reader {
            let _ = reader.join();
        }
        if let Some(reader) = stderr_reader {
            let _ = reader.join();
        }
        canceled |= sd_cancel_flag().load(Ordering::SeqCst);

        match outcome {
            Ok(status) if status.success() => {
                any_success = true;
                set_sd_image_phase(
                    &run_id,
                    current_image,
                    total_images,
                    SdProgressPhase::Finalizing,
                );
                results.push(SdRunResult {
                    ok: true,
                    error: None,
                });
            }
            Ok(status) => {
                let tail = stderr_tail
                    .lock()
                    .map(|bytes| bytes.iter().copied().collect::<Vec<_>>())
                    .unwrap_or_default();
                let tail = String::from_utf8_lossy(&tail);
                results.push(SdRunResult {
                    ok: false,
                    error: Some(format!("sd exited {status}: {tail}")),
                });
            }
            Err(err) => results.push(SdRunResult {
                ok: false,
                error: Some(err),
            }),
        }

        if canceled {
            break;
        }
    }

    if canceled {
        set_sd_phase(&run_id, SdProgressPhase::Canceled);
        results = canceled_run_results(total_images);
    } else if any_success {
        set_sd_image_phase(
            &run_id,
            total_images,
            total_images,
            SdProgressPhase::Finalizing,
        );
    } else {
        set_sd_phase(&run_id, SdProgressPhase::Failed);
    }

    // The lease drops here at end of scope, but for per-spawn SD we also
    // want the registry to forget the entry — nothing is resident between
    // batches today. This is bookkeeping only: the child has already exited,
    // so normal completion must not invoke the eviction shutdown callback and
    // turn the finished run into a cancellation.
    if let Some(lease) = &sd_lease {
        let id = lease.model().id().to_string();
        if let Some(residency) = residency_global() {
            residency.unregister(&id);
        }
        drop(sd_lease);
    }
    Ok(results)
}

/// Canonicalize the system temp dir — the only directory `sd-cli` is allowed to
/// write its `-o`/`--output` PNGs into. Mirrors `canonical_models_roots()`'s
/// "create + canonicalize" shape so symlinked temp dirs (e.g. /tmp -> /private/
/// tmp on macOS) compare correctly. The Next side derives every output path as
/// `os.tmpdir()/lunery-sd-<uuid>-<i>.png`, so legitimate runs always pass.
fn canonical_sd_output_root() -> Result<PathBuf, String> {
    std::env::temp_dir()
        .canonicalize()
        .map_err(|err| format!("Could not verify temp output root: {err}"))
}

/// Confirm that `value` (an argv path that follows `-o`/`--output`) resolves
/// under `root`. The file itself need not exist yet, so we canonicalize its
/// PARENT and join the file name — same approach as `hf_download_start_inner`'s
/// post-mkdir containment check. Rejects parent-dir traversal up front.
fn sd_output_path_allowed(value: &str, root: &Path) -> bool {
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let Some(file_name) = path.file_name() else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    // The parent (the temp dir) must already exist to canonicalize it.
    let Ok(parent_canon) = parent.canonicalize() else {
        return false;
    };
    parent_canon.starts_with(root) && parent_canon.join(file_name).starts_with(root)
}

/// Confirm that `value` (an argv path that follows `-m`/`--model`/
/// `--diffusion-model`) is an acceptable model source. Accepts either:
///   1. a path under the canonical models root (catalog-downloaded models), or
///   2. an existing regular file (user-imported models, which the Next-side
///      registry validated and may live anywhere the user pointed).
///
/// Read-only by nature — `sd-cli` only reads the model — so the existing-file
/// fallback does not grant arbitrary writes. Parent-dir traversal is rejected
/// before the models-root check. Symlinks are resolved via canonicalize so a
/// planted symlink cannot smuggle a path past the root check.
fn sd_model_path_allowed(value: &str, models_roots: &[PathBuf]) -> bool {
    let path = PathBuf::from(value);
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    if let Ok(canon) = path.canonicalize() {
        if models_roots.iter().any(|root| canon.starts_with(root)) {
            return true;
        }
        // Imported model outside the cache must be (a) an existing regular
        // file, (b) carry a model-shaped extension so we never hand `sd-cli`
        // an arbitrary `/etc/passwd`-style argument, and (c) be at least
        // 100 MB so a malicious actor can't substitute a tiny fake file.
        // The Next-side imported-model-registry is the source of truth for
        // what the user explicitly imported; this is a defense-in-depth
        // belt-and-braces check at the spawn boundary.
        if !canon.is_file() {
            return false;
        }
        let allowed_ext = canon
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "safetensors" | "ckpt" | "pt" | "gguf" | "bin"
                )
            })
            .unwrap_or(false);
        if !allowed_ext {
            return false;
        }
        const MIN_MODEL_BYTES: u64 = 100 * 1024 * 1024;
        let size_ok = std::fs::metadata(&canon)
            .map(|m| m.len() >= MIN_MODEL_BYTES)
            .unwrap_or(false);
        return size_ok;
    }
    false
}

/// Walk one run's argv and validate every `-o`/`--output` value against the
/// temp output root and every model-file value against the models root. Returns
/// an error string on the first offending value.
fn validate_sd_run_argv(
    argv: &[String],
    output_root: &Path,
    models_roots: &[PathBuf],
) -> Result<(), String> {
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-o" | "--output" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "Missing value after output flag".to_string())?;
                if !sd_output_path_allowed(value, output_root) {
                    return Err("sd output path escapes the allowed output directory".to_string());
                }
            }
            "-m" | "--model" | "--diffusion-model" | "--vae" | "--clip_l" | "--t5xxl" | "--llm" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "Missing value after model flag".to_string())?;
                if !sd_model_path_allowed(value, models_roots) {
                    return Err("sd model path is not an allowed model source".to_string());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Best-effort parse of the primary model path from one sd-cli argv. Looks for
/// `-m <path>`, `--model <path>`, or `--diffusion-model <path>` and returns the
/// file basename — same convention as LlamaResident so the UI shows comparable
/// ids across backends. Returns None if argv has no recognisable model arg.
fn sd_model_id_from_argv(argv: &[String]) -> Option<String> {
    sd_model_path_from_argv(argv).and_then(|model_path| {
        std::path::Path::new(&model_path)
            .file_name()
            .and_then(|name| name.to_str().map(str::to_string))
    })
}

fn sd_model_path_from_argv(argv: &[String]) -> Option<String> {
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        if arg == "-m" || arg == "--model" || arg == "--diffusion-model" {
            return iter.next().cloned();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_sd_model_delete_lease, advance_sd_runtime_epoch, begin_sd_run, bridge_cancel_sd,
        bridge_stop_sd, bridge_stop_sd_if_model_path, queue_pending_cancel,
        release_sd_model_delete_lease, sd_active_model_path, sd_cancel_flag, sd_inflight_child,
        sd_may_spawn, sd_model_id_from_argv, sd_progress_for_run, sd_runtime_epoch,
        sd_spawn_decision, sd_spawn_gate, set_sd_image_phase, set_sd_progress,
        validate_sd_run_argv, ActiveSdModelGuard, SdProgress, SdProgressParser, SdProgressPhase,
        SdSpawnDecision,
    };
    use crate::test_global_lock;
    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};

    // bridge_stop_sd must kill + reap the in-flight child and clear the slot.
    #[cfg(unix)]
    #[test]
    fn bridge_stop_sd_clears_and_reaps_child() {
        let _g = test_global_lock();
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep");
        *sd_inflight_child().lock().unwrap() = Some(child);

        bridge_stop_sd();

        assert!(
            sd_inflight_child().lock().unwrap().is_none(),
            "stop must clear the in-flight child slot"
        );
    }

    #[test]
    fn bridge_stop_sd_only_stops_the_expected_model_path() {
        let _g = test_global_lock();
        sd_cancel_flag().store(false, Ordering::SeqCst);
        let worker = std::thread::spawn(|| {
            let _active = ActiveSdModelGuard::set(Some("/models/current.safetensors".to_string()))
                .expect("active model is not leased for deletion");
            while !sd_cancel_flag().load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        for _ in 0..200 {
            if sd_active_model_path().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        assert!(!bridge_stop_sd_if_model_path("/models/other.safetensors"));
        assert_eq!(
            sd_active_model_path().as_deref(),
            Some("/models/current.safetensors")
        );
        assert!(bridge_stop_sd_if_model_path("/models/current.safetensors"));
        worker.join().expect("active SD worker exits after stop");
        assert!(sd_active_model_path().is_none());
    }

    #[test]
    fn sd_cancel_flag_toggles() {
        let _g = test_global_lock();
        sd_cancel_flag().store(false, Ordering::SeqCst);
        assert!(!sd_cancel_flag().load(Ordering::SeqCst));
        sd_cancel_flag().store(true, Ordering::SeqCst);
        assert!(sd_cancel_flag().load(Ordering::SeqCst));
        sd_cancel_flag().store(false, Ordering::SeqCst);
    }

    #[test]
    fn deletion_lease_closes_the_sd_start_race() {
        let _g = test_global_lock();
        let model_path = "/models/deleting.safetensors";
        acquire_sd_model_delete_lease(model_path, "delete-lease").expect("acquire delete lease");

        assert!(ActiveSdModelGuard::set(Some(model_path.to_string())).is_err());
        assert!(sd_active_model_path().is_none());

        release_sd_model_delete_lease(model_path, "delete-lease");
        let active = ActiveSdModelGuard::set(Some(model_path.to_string()))
            .expect("released lease allows generation");
        assert_eq!(sd_active_model_path().as_deref(), Some(model_path));
        drop(active);
        assert!(sd_active_model_path().is_none());
    }

    #[test]
    fn parses_chunked_carriage_return_progress_and_both_speed_units() {
        let mut parser = SdProgressParser::default();

        assert!(parser.push(b"\r |====> | 3/").is_empty());
        let first = parser.push(b"28 - 2.50s/it\x1b[K");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].step, 3);
        assert_eq!(first[0].total_steps, 28);
        assert!((first[0].seconds_per_step - 2.5).abs() < f64::EPSILON);

        let second = parser.push(b"\r |======> | 4/28 - 2.00it/s\x1b[K");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].step, 4);
        assert_eq!(second[0].total_steps, 28);
        assert!((second[0].seconds_per_step - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn cancel_is_isolated_to_the_matching_run_id() {
        let _g = test_global_lock();
        sd_cancel_flag().store(false, Ordering::SeqCst);
        let now = super::epoch_ms();
        set_sd_progress(SdProgress {
            run_id: "run-active".to_string(),
            phase: SdProgressPhase::Preparing,
            current_image: 1,
            total_images: 2,
            step: None,
            total_steps: None,
            seconds_per_step: None,
            started_at_ms: now,
            updated_at_ms: now,
        });
        set_sd_image_phase("run-active", 1, 2, SdProgressPhase::Sampling);

        assert!(bridge_cancel_sd("run-other"));
        assert!(!sd_cancel_flag().load(Ordering::SeqCst));
        assert_eq!(
            sd_progress_for_run("run-active").map(|progress| progress.phase),
            Some(SdProgressPhase::Sampling)
        );

        assert!(bridge_cancel_sd("run-active"));
        assert!(sd_cancel_flag().load(Ordering::SeqCst));
        assert_eq!(
            sd_progress_for_run("run-active").map(|progress| progress.phase),
            Some(SdProgressPhase::Canceled)
        );
        super::take_pending_cancel("run-other");
        sd_cancel_flag().store(false, Ordering::SeqCst);
    }

    #[test]
    fn canceled_batch_cannot_start_and_retry_gets_fresh_state() {
        let _g = test_global_lock();
        queue_pending_cancel("run-canceled");

        assert!(!begin_sd_run("run-canceled", 2));
        assert!(sd_cancel_flag().load(Ordering::SeqCst));
        assert_eq!(
            sd_progress_for_run("run-canceled").map(|progress| progress.phase),
            Some(SdProgressPhase::Canceled)
        );

        assert!(begin_sd_run("run-retry", 2));
        assert!(!sd_cancel_flag().load(Ordering::SeqCst));
        assert!(sd_progress_for_run("run-canceled").is_none());
        assert_eq!(
            sd_progress_for_run("run-retry").map(|progress| progress.phase),
            Some(SdProgressPhase::Preparing)
        );
    }

    #[test]
    fn epoch_mismatch_or_cancel_blocks_spawn_after_reset() {
        let _g = test_global_lock();
        let captured = sd_runtime_epoch();
        assert_eq!(
            sd_spawn_decision(captured, captured, false),
            SdSpawnDecision::Allow
        );
        assert!(sd_may_spawn(captured, captured, false));

        let advanced = advance_sd_runtime_epoch();
        assert_ne!(captured, advanced);
        assert_eq!(
            sd_spawn_decision(captured, sd_runtime_epoch(), false),
            SdSpawnDecision::Revoked
        );
        assert!(!sd_may_spawn(captured, sd_runtime_epoch(), false));
        assert_eq!(
            sd_spawn_decision(advanced, advanced, true),
            SdSpawnDecision::Canceled
        );
    }

    #[test]
    fn stop_advances_epoch_so_queued_work_cannot_spawn() {
        let _g = test_global_lock();
        let before = sd_runtime_epoch();
        bridge_stop_sd();
        let after = sd_runtime_epoch();
        assert_ne!(before, after);
        assert!(!sd_may_spawn(before, after, false));
    }

    /// Deterministic barrier covering both gate orderings. Pure
    /// `sd_spawn_decision` checks are not sufficient: this exercises the real
    /// spawn-gate + register seam and proves no old-epoch spawn closure runs
    /// after teardown has returned.
    #[cfg(unix)]
    #[test]
    fn spawn_gate_blocks_stale_epoch_spawn_for_both_orderings() {
        use super::sd_spawn_and_register_under_gate;
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Barrier};

        fn spawn_sleep_child() -> Result<std::process::Child, String> {
            std::process::Command::new("sleep")
                .arg("30")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())
        }

        let _g = test_global_lock();

        // Ordering A: teardown wins the gate first. Worker must observe the new
        // epoch and never invoke spawn_fn after teardown returns.
        {
            sd_cancel_flag().store(false, Ordering::SeqCst);
            *sd_inflight_child().lock().unwrap() = None;
            let captured = sd_runtime_epoch();
            let spawned = Arc::new(AtomicBool::new(false));
            let spawned_flag = Arc::clone(&spawned);
            bridge_stop_sd();
            let result = sd_spawn_and_register_under_gate(captured, || {
                spawned_flag.store(true, Ordering::SeqCst);
                spawn_sleep_child()
            })
            .expect("gate lock");
            assert_eq!(result, None);
            assert!(
                !spawned.load(Ordering::SeqCst),
                "stale-epoch worker must not call spawn after teardown returned"
            );
            assert!(sd_inflight_child().lock().unwrap().is_none());
        }

        // Ordering B: worker holds the gate across epoch capture → spawn →
        // register so a concurrent process-global stop cannot revoke the epoch
        // in the check-to-spawn window. Main calls teardown immediately; it
        // blocks on the gate, then kills the registered child before returning.
        {
            sd_cancel_flag().store(false, Ordering::SeqCst);
            *sd_inflight_child().lock().unwrap() = None;

            let entered_gate = Arc::new(Barrier::new(2));
            let entered_gate_w = Arc::clone(&entered_gate);
            let release_spawn = Arc::new(std::sync::Mutex::new(false));
            let release_spawn_w = Arc::clone(&release_spawn);
            let release_cv = Arc::new(std::sync::Condvar::new());
            let release_cv_w = Arc::clone(&release_cv);
            let captured_slot = Arc::new(std::sync::Mutex::new(0_u64));
            let captured_slot_w = Arc::clone(&captured_slot);
            let spawned = Arc::new(AtomicBool::new(false));
            let spawned_w = Arc::clone(&spawned);

            let worker = std::thread::spawn(move || {
                let _gate = sd_spawn_gate().lock().expect("spawn gate");
                // Capture under the gate and clear cancel so external stops that
                // already advanced the epoch cannot create a TOCTOU gap before
                // spawn — they must wait for this gate first.
                let captured = sd_runtime_epoch();
                *captured_slot_w.lock().unwrap() = captured;
                sd_cancel_flag().store(false, Ordering::SeqCst);
                entered_gate_w.wait();
                let guard = release_spawn_w.lock().unwrap();
                let _ = release_cv_w
                    .wait_timeout_while(guard, std::time::Duration::from_secs(2), |ready| !*ready)
                    .unwrap();
                if !sd_may_spawn(
                    captured,
                    sd_runtime_epoch(),
                    sd_cancel_flag().load(Ordering::SeqCst),
                ) {
                    return Err("epoch revoked while holding spawn gate".to_string());
                }
                spawned_w.store(true, Ordering::SeqCst);
                let child = spawn_sleep_child()?;
                *sd_inflight_child()
                    .lock()
                    .map_err(|_| "child lock".to_string())? = Some(child);
                Ok(())
            });

            entered_gate.wait();
            {
                let mut ready = release_spawn.lock().unwrap();
                *ready = true;
                release_cv.notify_all();
            }
            // Teardown waits for the in-gate worker, then kills before return.
            bridge_stop_sd();
            assert!(
                sd_inflight_child().lock().unwrap().is_none(),
                "teardown must reap registered child before returning"
            );
            worker.join().expect("worker").expect("worker registered");
            assert!(
                spawned.load(Ordering::SeqCst),
                "worker-first ordering must invoke spawn under the gate"
            );

            let captured = *captured_slot.lock().unwrap();
            let post_teardown_spawned = Arc::new(AtomicBool::new(false));
            let spawned = Arc::clone(&post_teardown_spawned);
            let again = sd_spawn_and_register_under_gate(captured, || {
                spawned.store(true, Ordering::SeqCst);
                Err("must-not-spawn".to_string())
            })
            .expect("gate");
            assert_eq!(again, None);
            assert!(
                !post_teardown_spawned.load(Ordering::SeqCst),
                "no old-epoch spawn closure may run after teardown returned"
            );
        }

        sd_cancel_flag().store(false, Ordering::SeqCst);
        *sd_inflight_child().lock().unwrap() = None;
    }

    /// Worker holds the gate across a slow spawn; teardown blocks until the
    /// worker registers, then kills before returning — proving teardown waits
    /// rather than racing past an in-flight spawn closure.
    #[cfg(unix)]
    #[test]
    fn teardown_waits_for_in_gate_worker_then_kills_registered_child() {
        use super::sd_spawn_and_register_under_gate;
        use std::sync::{Arc, Barrier, Mutex};

        let _g = test_global_lock();
        sd_cancel_flag().store(false, Ordering::SeqCst);
        *sd_inflight_child().lock().unwrap() = None;
        let captured = sd_runtime_epoch();

        let entered_spawn = Arc::new(Barrier::new(2));
        let entered_spawn_w = Arc::clone(&entered_spawn);
        let release_spawn = Arc::new(Mutex::new(false));
        let release_spawn_w = Arc::clone(&release_spawn);
        let release_cv = Arc::new(std::sync::Condvar::new());
        let release_cv_w = Arc::clone(&release_cv);

        let worker = std::thread::spawn(move || {
            sd_spawn_and_register_under_gate(captured, move || {
                entered_spawn_w.wait();
                let guard = release_spawn_w.lock().unwrap();
                let _ = release_cv_w
                    .wait_timeout_while(guard, std::time::Duration::from_secs(2), |ready| !*ready)
                    .unwrap();
                std::process::Command::new("sleep")
                    .arg("30")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())
            })
        });

        entered_spawn.wait();
        let stopper = std::thread::spawn(|| {
            bridge_stop_sd();
        });

        // Give teardown time to block on the gate held by the worker.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !stopper.is_finished(),
            "teardown must wait while worker holds the spawn gate"
        );

        {
            let mut ready = release_spawn.lock().unwrap();
            *ready = true;
            release_cv.notify_all();
        }

        let registered = worker.join().expect("worker").expect("gate");
        assert_eq!(registered, Some(()));
        stopper.join().expect("teardown");
        assert!(
            sd_inflight_child().lock().unwrap().is_none(),
            "teardown returns only after killing the registered child"
        );
        // Old epoch must remain unspawnable.
        let spawned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let spawned_f = Arc::clone(&spawned);
        let again = sd_spawn_and_register_under_gate(captured, move || {
            spawned_f.store(true, Ordering::SeqCst);
            Err("no".into())
        })
        .unwrap();
        assert_eq!(again, None);
        assert!(!spawned.load(Ordering::SeqCst));
        sd_cancel_flag().store(false, Ordering::SeqCst);
    }

    fn unique_test_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        std::env::temp_dir().join(format!("lunerylab-sd-{name}-{nonce}"))
    }

    #[test]
    fn sd_model_id_reads_diffusion_model_arg() {
        let argv = vec![
            "--diffusion-model".to_string(),
            "/models/sd-cpp/flux2-dev-Q4_K_M.gguf".to_string(),
            "--llm".to_string(),
            "/models/sd-cpp/Mistral.gguf".to_string(),
        ];

        assert_eq!(
            sd_model_id_from_argv(&argv).as_deref(),
            Some("flux2-dev-Q4_K_M.gguf")
        );
    }

    #[test]
    fn validates_flux2_companion_paths() {
        let root = unique_test_dir("models");
        let out_root = unique_test_dir("out");
        std::fs::create_dir_all(root.join("sd-cpp")).expect("create model dir");
        std::fs::create_dir_all(&out_root).expect("create out dir");
        let model = root.join("sd-cpp").join("flux2-dev-Q4_K_M.gguf");
        let vae = root
            .join("sd-cpp")
            .join("full_encoder_small_decoder.safetensors");
        let llm = root
            .join("sd-cpp")
            .join("Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf");
        std::fs::write(&model, b"model").expect("write model");
        std::fs::write(&vae, b"vae").expect("write vae");
        std::fs::write(&llm, b"llm").expect("write llm");
        let output = out_root.join("image.png");

        let argv = vec![
            "--diffusion-model".to_string(),
            model.to_string_lossy().to_string(),
            "--vae".to_string(),
            vae.to_string_lossy().to_string(),
            "--llm".to_string(),
            llm.to_string_lossy().to_string(),
            "-o".to_string(),
            output.to_string_lossy().to_string(),
        ];

        let out_root_canon = out_root.canonicalize().expect("canonical out root");
        let root_canon = root.canonicalize().expect("canonical model root");

        assert!(validate_sd_run_argv(&argv, &out_root_canon, &[root_canon]).is_ok());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(out_root);
    }

    #[test]
    fn rejects_flux2_companion_paths_outside_model_root() {
        let root = unique_test_dir("models");
        let out_root = unique_test_dir("out");
        let outside = unique_test_dir("outside");
        std::fs::create_dir_all(root.join("sd-cpp")).expect("create model dir");
        std::fs::create_dir_all(&out_root).expect("create out dir");
        std::fs::create_dir_all(&outside).expect("create outside dir");
        let model = root.join("sd-cpp").join("flux2-dev-Q4_K_M.gguf");
        let vae = outside.join("full_encoder_small_decoder.safetensors");
        std::fs::write(&model, b"model").expect("write model");
        std::fs::write(&vae, b"vae").expect("write vae");
        let output = out_root.join("image.png");

        let argv = vec![
            "--diffusion-model".to_string(),
            model.to_string_lossy().to_string(),
            "--vae".to_string(),
            vae.to_string_lossy().to_string(),
            "-o".to_string(),
            output.to_string_lossy().to_string(),
        ];

        let out_root_canon = out_root.canonicalize().expect("canonical out root");
        let root_canon = root.canonicalize().expect("canonical model root");

        assert!(validate_sd_run_argv(&argv, &out_root_canon, &[root_canon]).is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(out_root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
