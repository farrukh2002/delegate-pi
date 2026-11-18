mod bounded_directory;
mod cache;
mod index;
mod params;
mod source;
mod transport;

use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{oneshot, Semaphore};

use crate::engine::{OperationFuture, OperationOutcome};
use crate::protocol::{ErrorCode, MAX_FRAME_BYTES};
use cache::{Cache, FORMAT_VERSION, MAX_INDEX_BYTES};
use params::{valid_index_id, IndexParams};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerRequest {
    operation: String,
    params: Value,
    cache: PathBuf,
    stage: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerReply {
    Result { result: Value },
    Error { code: ErrorCode },
}

pub struct GitHandler {
    slots: Arc<Semaphore>,
}

struct WorkerControl {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

struct CancelWorker(Arc<WorkerControl>);

impl Drop for CancelWorker {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
        if let Ok(mut child) = self.0.child.lock() {
            if let Some(child) = child.as_mut() { let _ = child.kill(); }
        }
    }
}

impl Default for GitHandler {
    fn default() -> Self { Self { slots: Arc::new(Semaphore::new(2)) } }
}

impl GitHandler {
    pub fn start(&self, operation: &str, params: Option<Value>) -> OperationFuture {
        let slots = self.slots.clone();
        let operation = operation.to_string();
        Box::pin(async move {
            let params = match params { Some(Value::Object(map)) => Value::Object(map),
                _ => return OperationOutcome::Error(ErrorCode::InvalidParams) };
            if operation == "git_index" {
                if let Err(error) = IndexParams::parse(params.clone()) { return OperationOutcome::Error(error); }
            } else if !params.get("indexId").and_then(Value::as_str).is_some_and(valid_index_id) {
                return OperationOutcome::Error(ErrorCode::InvalidParams);
            }
            let permit = match slots.try_acquire_owned() { Ok(p) => p,
                Err(_) => return OperationOutcome::Error(ErrorCode::Busy) };
            let cache = match cache_root() { Ok(p) => p, Err(e) => return OperationOutcome::Error(e) };
            let control = Arc::new(WorkerControl { child: Mutex::new(None), cancelled: AtomicBool::new(false) });
            let _cancel = CancelWorker(control.clone());
            let (send, receive) = oneshot::channel();
            let spawn = std::thread::Builder::new().name("pi-git-supervisor".into()).spawn(move || {
                let _permit = permit;
                let result = supervise(operation, params, cache, &control);
                let _ = send.send(result);
            });
            if spawn.is_err() { return OperationOutcome::Error(ErrorCode::ResourceLimit); }
            match receive.await {
                Ok(Ok(value)) => OperationOutcome::Result(value),
                Ok(Err(error)) => OperationOutcome::Error(error),
                Err(_) => OperationOutcome::Error(ErrorCode::Internal),
            }
        })
    }
}

fn cache_root() -> Result<PathBuf, ErrorCode> {
    if let Some(root) = std::env::var_os("PI_WEB_CACHE_DIR") {
        if root.is_empty() { return Err(ErrorCode::RepositoryError); }
        return Ok(PathBuf::from(root));
    }
    if let Some(root) = std::env::var_os("XDG_CACHE_HOME").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(root).join("pi-web/git"));
    }
    std::env::var_os("HOME").filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(p).join(".cache/pi-web/git")).ok_or(ErrorCode::RepositoryError)
}

fn supervise(operation: String, params: Value, root: PathBuf, control: &WorkerControl) -> Result<Value, ErrorCode> {
    let cache = Cache::prepare(root)?;
    let stage = cache.create_stage()?;
    let home = stage.path.join("home");
    fs::create_dir(&home).map_err(|_| ErrorCode::RepositoryError)?;
    let input = serde_json::to_vec(&WorkerRequest { operation, params, cache: cache.root, stage: stage.path.clone() })
        .map_err(|_| ErrorCode::InvalidParams)?;
    if input.len() > MAX_FRAME_BYTES { return Err(ErrorCode::InvalidParams); }
    if control.cancelled.load(Ordering::Acquire) { return Err(ErrorCode::Cancelled); }
    let parent_pid = std::process::id();
    let mut command = Command::new("/proc/self/exe");
    command.arg("--git-worker").current_dir(&stage.path).env_clear()
        .env("HOME", &home).env("XDG_CONFIG_HOME", home.join(".config"))
        .env("PATH", "").env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", "/dev/null").env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0").env("GIT_TERMINAL_PROMPT", "0").env("GIT_ALLOW_PROTOCOL", "https")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 { return Err(std::io::Error::last_os_error()); }
            if libc::getppid() as u32 != parent_pid { libc::_exit(1); }
            libc::umask(0o077);
            for (resource, value) in [(libc::RLIMIT_AS, 2_147_483_648_u64), (libc::RLIMIT_CPU, 60),
                (libc::RLIMIT_FSIZE, 536_870_912), (libc::RLIMIT_NOFILE, 256), (libc::RLIMIT_CORE, 0)] {
                let limit = libc::rlimit { rlim_cur: value as libc::rlim_t, rlim_max: value as libc::rlim_t };
                if libc::setrlimit(resource, &limit) != 0 { return Err(std::io::Error::last_os_error()); }
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|_| ErrorCode::RepositoryError)?;
    let stdin = child.stdin.take().ok_or(ErrorCode::Internal)?;
    let stdout = child.stdout.take().ok_or(ErrorCode::Internal)?;
    {
        let mut holder = control.child.lock().map_err(|_| ErrorCode::Internal)?;
        if control.cancelled.load(Ordering::Acquire) { let _ = child.kill(); }
        *holder = Some(child);
    }
    let write_result = { let mut stdin = stdin; stdin.write_all(&input) };
    let mut output = Vec::new();
    let read_result = stdout.take(MAX_FRAME_BYTES as u64 + 1).read_to_end(&mut output);
    let mut holder = control.child.lock().map_err(|_| ErrorCode::Internal)?;
    let child = holder.as_mut().ok_or(ErrorCode::Internal)?;
    if write_result.is_err() || read_result.is_err() || output.len() > MAX_FRAME_BYTES { let _ = child.kill(); }
    let status = child.wait().map_err(|_| ErrorCode::Internal)?;
    *holder = None;
    drop(holder);
    if !status.success() {
        return Err(if matches!(status.signal(), Some(libc::SIGKILL | libc::SIGXCPU | libc::SIGXFSZ | libc::SIGABRT)) {
            ErrorCode::ResourceLimit
        } else { ErrorCode::Internal });
    }
    if read_result.is_err() || output.len() > MAX_FRAME_BYTES { return Err(ErrorCode::Internal); }
    match serde_json::from_slice(&output).map_err(|_| ErrorCode::Internal)? {
        WorkerReply::Result { result } => Ok(result), WorkerReply::Error { code } => Err(code),
    }
}

pub fn run_worker() -> i32 {
    let result = worker_request();
    let reply = match result { Ok(result) => WorkerReply::Result { result }, Err(code) => WorkerReply::Error { code } };
    let bytes = match serde_json::to_vec(&reply) { Ok(bytes) if bytes.len() <= MAX_FRAME_BYTES => bytes,
        _ => return 1 };
    if std::io::stdout().lock().write_all(&bytes).is_err() { return 1; }
    0
}

fn worker_request() -> Result<Value, ErrorCode> {
    deny_external_execution()?;
    let mut bytes = Vec::new();
    std::io::stdin().take(MAX_FRAME_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| ErrorCode::InvalidParams)?;
    if bytes.len() > MAX_FRAME_BYTES { return Err(ErrorCode::InvalidParams); }
    let request: WorkerRequest = serde_json::from_slice(&bytes).map_err(|_| ErrorCode::InvalidParams)?;
    let cache = Cache::prepare(request.cache)?;
    if request.stage.parent() != Some(cache.root.as_path())
        || !request.stage.file_name().is_some_and(|s| s.as_encoded_bytes().starts_with(b".stage-")) {
        return Err(ErrorCode::InvalidParams);
    }
    let lease = cache::lock_file(&request.stage.join("lease"))?;
    fs2::FileExt::lock_shared(&lease).map_err(|_| ErrorCode::RepositoryError)?;
    let _slot = cache.worker_slot()?;
    cache.cleanup_stages(&request.stage)?;
    match request.operation.as_str() {
        "git_index" => build(&cache, &request.stage, request.params),
        "git_search" | "git_read" => {
            let id = request.params.get("indexId").and_then(Value::as_str)
                .filter(|s| valid_index_id(s)).ok_or(ErrorCode::InvalidParams)?;
            let _lock = cache.index_lock(id, false)?;
            let manifest = cache.manifest(id)?;
            let directory = cache.root.join(id).join("index");
            if request.operation == "git_search" {
                index::search_index(&directory, request.params, manifest["result"]["status"] == "partial")
            } else {
                index::read_index(&directory, request.params, manifest["result"]["resolvedCommit"].as_str())
            }
        }
        _ => Err(ErrorCode::UnsupportedOperation),
    }
}

fn build(cache: &Cache, stage: &std::path::Path, value: Value) -> Result<Value, ErrorCode> {
    let params = IndexParams::parse(value)?;
    let _build_lock = cache.build_lock()?;
    let snapshot = source::collect(&params, stage)?;
    let identity = serde_json::to_vec(&json!({"formatVersion":1,"source":snapshot.source,
        "scope":snapshot.scope,"revision":snapshot.revision})).map_err(|_| ErrorCode::Internal)?;
    let id: String = Sha256::digest(identity).iter().map(|b| format!("{b:02x}")).collect();
    let result = json!({"indexId":id,"source":snapshot.source,"scope":snapshot.scope,"revision":snapshot.revision,
        "resolvedCommit":snapshot.resolved_commit,"status":if snapshot.partial() {"partial"} else {"ok"},
        "filesIndexed":snapshot.files.len(),"bytesIndexed":snapshot.bytes,"commitsVisited":snapshot.commits,
        "downloadBytes":snapshot.download_bytes,"skipped":snapshot.skipped,"limitsReached":snapshot.limits,
        "indexedAt":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| ErrorCode::Internal)?.as_secs()});
    if serde_json::to_vec(&result).map_err(|_| ErrorCode::Internal)?.len() > params.max_output_bytes {
        return Err(ErrorCode::OutputLimit);
    }
    let product = stage.join("product");
    fs::create_dir(&product).map_err(|_| ErrorCode::RepositoryError)?;
    let directory = product.join("index");
    fs::create_dir(&directory).map_err(|_| ErrorCode::RepositoryError)?;
    index::build_index(&directory, &snapshot.files, MAX_INDEX_BYTES)?;
    let manifest = serde_json::to_vec(&json!({"formatVersion": FORMAT_VERSION, "result": result}))
        .map_err(|_| ErrorCode::Internal)?;
    let mut file = File::create(product.join("manifest.json")).map_err(|_| ErrorCode::RepositoryError)?;
    file.write_all(&manifest).and_then(|()| file.sync_all()).map_err(|_| ErrorCode::RepositoryError)?;
    File::open(&product).and_then(|f| f.sync_all()).map_err(|_| ErrorCode::RepositoryError)?;
    cache.publish(&id, &product)?;
    Ok(result)
}

fn deny_external_execution() -> Result<(), ErrorCode> {
    let expected_arch = match std::env::consts::ARCH { "x86_64" => 0xc000003e, "aarch64" => 0xc00000b7,
        _ => return Err(ErrorCode::Internal) };
    let mut instructions = [
        libc::sock_filter { code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16, jt: 0, jf: 0, k: 4 },
        libc::sock_filter { code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16, jt: 1, jf: 0, k: expected_arch },
        libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16, jt: 0, jf: 0, k: libc::SECCOMP_RET_KILL_PROCESS },
        libc::sock_filter { code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16, jt: 0, jf: 0, k: 0 },
        libc::sock_filter { code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16, jt: 2, jf: 0, k: libc::SYS_execve as u32 },
        libc::sock_filter { code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16, jt: 1, jf: 0, k: libc::SYS_execveat as u32 },
        libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16, jt: 0, jf: 0, k: libc::SECCOMP_RET_ALLOW },
        libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16, jt: 0, jf: 0, k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32 },
    ];
    let program = libc::sock_fprog { len: instructions.len() as u16, filter: instructions.as_mut_ptr() };
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
        || unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) } != 0 {
        return Err(ErrorCode::ResourceLimit);
    }
    Ok(())
}
