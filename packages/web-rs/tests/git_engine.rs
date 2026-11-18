use serde_json::{json, Value};
use std::fs::{self, DirBuilder};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GIT_TIMEOUT_MS: u64 = 120_000;
const MAX_NATIVE_FRAME_BYTES: usize = 65_536;
const READ_TIMEOUT: Duration = Duration::from_secs(130);
const PRIVATE_MODE: u32 = 0o700;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "pi-web-git-{label}-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        DirBuilder::new()
            .recursive(true)
            .mode(PRIVATE_MODE)
            .create(&path)
            .unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct Repository {
    root: PathBuf,
    home: PathBuf,
    hooks: PathBuf,
}

impl Repository {
    fn init(root: PathBuf, home: PathBuf) -> Self {
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        let hooks = home.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let repo = Self { root, home, hooks };
        repo.git(&["init", "--quiet"]);
        repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        repo.git(&["config", "--local", "user.name", "Pi Web Test"]);
        repo.git(&["config", "--local", "user.email", "pi-web@example.invalid"]);
        repo.git(&["config", "--local", "commit.gpgsign", "false"]);
        repo.git(&["config", "--local", "core.hooksPath", repo.hooks.to_str().unwrap()]);
        repo.git(&["config", "--local", "gc.auto", "0"]);
        repo
    }

    fn write(&self, relative: &str, contents: impl AsRef<[u8]>) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn remove(&self, relative: &str) {
        fs::remove_file(self.root.join(relative)).unwrap();
    }

    fn symlink(&self, target: &str, relative: &str) {
        std::os::unix::fs::symlink(target, self.root.join(relative)).unwrap();
    }

    fn commit(&self, message: &str) -> String {
        self.git(&["add", "--all"]);
        self.git(&["commit", "--quiet", "--message", message]);
        self.rev("HEAD")
    }

    fn rev(&self, revision: &str) -> String {
        self.git(&["rev-parse", revision])
    }

    fn git(&self, args: &[&str]) -> String {
        let output = self.command(args).output().expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("git stdout is utf8")
            .trim_end()
            .to_string()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        command
            .current_dir(&self.root)
            .args(args)
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_COUNT", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Pi Web Test")
            .env("GIT_AUTHOR_EMAIL", "pi-web@example.invalid")
            .env("GIT_AUTHOR_DATE", "2005-04-07T22:13:13 +0200")
            .env("GIT_COMMITTER_NAME", "Pi Web Test")
            .env("GIT_COMMITTER_EMAIL", "pi-web@example.invalid")
            .env("GIT_COMMITTER_DATE", "2005-04-07T22:13:13 +0200")
            .env("LC_ALL", "C");
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG_PARAMETERS",
        ] {
            command.env_remove(name);
        }
        command
    }
}

struct Engine {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Option<String>>,
}

impl Engine {
    fn start(cache: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-web"))
            .env("PI_WEB_CACHE_DIR", cache)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn pi-web");
        let stdin = child.stdin.take().expect("engine stdin");
        let stdout = child.stdout.take().expect("engine stdout");
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(Some(line)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = sender.send(None);
        });
        let engine = Self {
            child,
            stdin: Some(stdin),
            lines,
        };
        let ready = engine.line();
        assert_eq!(ready["type"], json!("ready"));
        assert_eq!(ready["protocolVersion"], json!(1));
        assert!(ready["engineVersion"].is_string());
        engine
    }

    fn line(&self) -> Value {
        match self.lines.recv_timeout(READ_TIMEOUT) {
            Ok(Some(line)) => {
                assert!(
                    line.len() <= MAX_NATIVE_FRAME_BYTES,
                    "native frame is {} bytes",
                    line.len()
                );
                serde_json::from_str(&line).expect("engine frame is json")
            }
            Ok(None) => panic!("engine closed stdout"),
            Err(error) => panic!("no engine frame within timeout: {error}"),
        }
    }

    fn write(&mut self, text: &str) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin.write_all(text.as_bytes()).expect("write frame");
        stdin.flush().expect("flush frame");
    }

    fn send_request(&mut self, id: &str, operation: &str, params: Value, timeout_ms: u64) {
        let frame = json!({
            "type": "request",
            "id": id,
            "operation": operation,
            "timeoutMs": timeout_ms,
            "params": params,
        });
        self.write(&format!("{frame}\n"));
    }

    fn send_cancel(&mut self, id: &str) {
        let frame = json!({"type": "cancel", "id": id});
        self.write(&format!("{frame}\n"));
    }

    fn exchange(&mut self, id: &str, operation: &str, params: Value, timeout_ms: u64) -> Value {
        self.send_request(id, operation, params, timeout_ms);
        self.line()
    }

    fn call(&mut self, id: &str, operation: &str, params: Value) -> Value {
        self.call_with_timeout(id, operation, params, GIT_TIMEOUT_MS)
    }

    fn call_with_timeout(
        &mut self,
        id: &str,
        operation: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Value {
        let frame = self.exchange(id, operation, params, timeout_ms);
        assert_eq!(frame["type"], json!("result"), "unexpected frame: {frame}");
        assert_eq!(frame["id"], json!(id), "unexpected frame: {frame}");
        frame["result"].clone()
    }

    fn error(&mut self, id: &str, operation: &str, params: Value) -> String {
        let frame = self.exchange(id, operation, params, GIT_TIMEOUT_MS);
        assert_eq!(frame["type"], json!("error"), "unexpected frame: {frame}");
        assert_eq!(frame["id"], json!(id), "unexpected frame: {frame}");
        frame["code"].as_str().expect("error code").to_string()
    }

    fn shutdown(mut self) {
        self.write("{\"type\":\"shutdown\"}\n");
        drop(self.stdin.take());
        let status = self.child.wait().expect("wait for engine");
        assert_eq!(status.code(), Some(0));
        match self.lines.recv_timeout(READ_TIMEOUT) {
            Ok(None) => {}
            Ok(Some(line)) => panic!("unexpected frame after shutdown: {line}"),
            Err(error) => panic!("engine did not close stdout: {error}"),
        }
    }
}

fn assert_index_id(value: &Value) -> String {
    let id = value.as_str().expect("index id string");
    assert_eq!(id.len(), 64, "index id: {id}");
    assert!(
        id.bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "index id: {id}"
    );
    id.to_string()
}

fn search(engine: &mut Engine, id: &str, index_id: &str, query: &str) -> Value {
    engine.call(
        id,
        "git_search",
        json!({"indexId": index_id, "query": query}),
    )
}

fn read(engine: &mut Engine, id: &str, index_id: &str, path: &str) -> Value {
    engine.call(id, "git_read", json!({"indexId": index_id, "path": path}))
}

fn read_at(engine: &mut Engine, id: &str, index_id: &str, path: &str, revision: &str) -> Value {
    engine.call(
        id,
        "git_read",
        json!({"indexId": index_id, "path": path, "revision": revision}),
    )
}

fn stage_dirs(cache: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(cache) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".stage-")
        })
        .map(|entry| entry.path())
        .collect()
}

fn wait_for_stage_cleanup(cache: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut clear_since = Instant::now();
    loop {
        let stages = stage_dirs(cache);
        if stages.is_empty() {
            if clear_since.elapsed() >= Duration::from_millis(500) {
                return;
            }
        } else {
            clear_since = Instant::now();
        }
        if Instant::now() >= deadline {
            panic!("staging directories remain: {stages:?}");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_stage(cache: &Path) -> Vec<PathBuf> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let stages = stage_dirs(cache);
        if !stages.is_empty() {
            return stages;
        }
        if Instant::now() >= deadline {
            panic!("no staging directory appeared");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn worktree_index_covers_current_files_and_reports_skips() {
    let temp = TempRoot::new("worktree");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write(".gitignore", "*.log\n");
    repo.write("README.md", "readme\n");
    repo.write(
        "src/main.rs",
        "fn main() {\n    println!(\"head-marker\");\n}\n",
    );
    let head = repo.commit("initial");
    repo.write(
        "src/main.rs",
        "fn main() {\n    println!(\"head-marker\");\n}\n// worktree-marker\n",
    );
    repo.write("src/uncommitted.txt", "uncommitted-marker\n");
    repo.write("ignored.log", "ignored-marker\n");
    repo.write("binary.bin", b"binary-marker\0payload");
    repo.write("nonutf8.txt", b"nonutf8-marker \xff\n");
    repo.write("large.txt", format!("large-marker\n{}", "x".repeat(2048)));
    repo.symlink("src/main.rs", "link.txt");
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let index = engine.call(
        "index",
        "git_index",
        json!({"source": source, "scope": "worktree", "maxFileBytes": 1024}),
    );
    let id = assert_index_id(&index["indexId"]);
    assert_eq!(index["scope"], json!("worktree"));
    assert_eq!(index["revision"], Value::Null);
    assert_eq!(index["resolvedCommit"], json!(head.as_str()));
    assert_eq!(index["status"], json!("partial"));
    assert_eq!(index["filesIndexed"], json!(4));
    assert_eq!(index["skipped"]["binary"], json!(1));
    assert_eq!(index["skipped"]["large"], json!(1));
    assert_eq!(index["skipped"]["nonUtf8"], json!(1));
    assert_eq!(index["skipped"]["unsafePath"], json!(1));
    assert_eq!(index["skipped"]["unreadable"], json!(0));
    assert_eq!(index["limitsReached"], json!([]));
    let canonical = fs::canonicalize(&repo.root).unwrap();
    assert_eq!(index["source"], json!(canonical.to_str().unwrap()));
    assert_eq!(fs::metadata(&cache).unwrap().mode() & 0o777, PRIVATE_MODE);

    let found = search(&mut engine, "search-worktree", &id, "worktree-marker");
    let results = found["results"].as_array().unwrap();
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["partial"], json!(true));
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], json!("src/main.rs"));
    assert_eq!(results[0]["revision"], Value::Null);
    assert_eq!(results[0]["line"], json!(4));
    assert!(results[0]["snippet"]
        .as_str()
        .unwrap()
        .contains("worktree-marker"));

    let uncommitted = search(&mut engine, "search-uncommitted", &id, "uncommitted-marker");
    assert_eq!(uncommitted["status"], json!("ok"));
    assert_eq!(uncommitted["results"][0]["path"], json!("src/uncommitted.txt"));

    let ignored = search(&mut engine, "search-ignored", &id, "ignored-marker");
    assert_eq!(ignored["status"], json!("empty"));
    assert_eq!(ignored["results"], json!([]));

    let binary = search(&mut engine, "search-binary", &id, "binary-marker");
    assert_eq!(binary["status"], json!("empty"));

    let current = read(&mut engine, "read-worktree", &id, "src/main.rs");
    assert_eq!(current["status"], json!("ok"));
    assert_eq!(current["revision"], Value::Null);
    assert_eq!(current["totalLines"], json!(4));
    assert!(current["content"]
        .as_str()
        .unwrap()
        .contains("worktree-marker"));

    let missing = read(&mut engine, "read-missing", &id, "ignored.log");
    assert_eq!(missing["status"], json!("not_found"));
    assert_eq!(missing["content"], json!(""));
    assert_eq!(missing["totalLines"], json!(0));

    let head_index = engine.call(
        "head-index",
        "git_index",
        json!({"source": source, "scope": "head"}),
    );
    let head_id = assert_index_id(&head_index["indexId"]);
    assert_ne!(head_id, id);
    assert_eq!(head_index["status"], json!("ok"));
    assert_eq!(head_index["resolvedCommit"], json!(head.as_str()));
    assert_eq!(head_index["filesIndexed"], json!(3));

    let head_search = search(&mut engine, "head-search", &head_id, "worktree-marker");
    assert_eq!(head_search["status"], json!("empty"));
    let head_read = read(&mut engine, "head-read", &head_id, "src/main.rs");
    assert_eq!(head_read["revision"], json!(head.as_str()));
    assert!(head_read["content"].as_str().unwrap().contains("head-marker"));
    assert!(!head_read["content"]
        .as_str()
        .unwrap()
        .contains("worktree-marker"));

    engine.shutdown();
}

#[test]
fn worktree_indexes_tracked_ignored_files_without_entering_submodules() {
    let temp = TempRoot::new("worktree-coverage");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write(".gitignore", "ignored/\n");
    repo.write("ignored/config.txt", "original\n");
    repo.git(&["add", "--force", "ignored/config.txt"]);
    let head = repo.commit("initial");
    repo.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{head},modules/plugin"),
    ]);
    repo.git(&["commit", "--quiet", "--message", "add submodule"]);
    repo.write("ignored/config.txt", "tracked-worktree-config\n");
    repo.write("ignored/private.txt", "untracked-ignored-text\n");
    repo.write("modules/plugin/file.txt", "submodule-only-text\n");
    let mut engine = Engine::start(&temp.path().join("cache"));
    for scope in ["worktree", "head", "history"] {
        let index = engine.call(
            "index",
            "git_index",
            json!({"source": repo.root, "scope": scope}),
        );
        assert_eq!(index["status"], "partial", "scope {scope}");
        assert_eq!(index["skipped"]["submodule"], 1, "scope {scope}");
        let id = assert_index_id(&index["indexId"]);
        if scope == "worktree" {
            let found = search(&mut engine, "tracked", &id, "tracked-worktree-config");
            assert_eq!(found["results"][0]["path"], "ignored/config.txt");
            assert_eq!(found["partial"], true);
            assert_eq!(
                search(&mut engine, "ignored", &id, "untracked-ignored-text")["status"],
                "empty"
            );
            assert_eq!(
                search(&mut engine, "submodule", &id, "submodule-only-text")["status"],
                "empty"
            );
        }
    }
    engine.shutdown();
}

#[test]
fn worktree_marks_sparse_checkouts_as_partial() {
    let temp = TempRoot::new("sparse-coverage");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("included/one.txt", "included-marker\n");
    repo.write("excluded/two.txt", "excluded-marker\n");
    repo.commit("initial");
    let mut engine = Engine::start(&temp.path().join("cache"));
    for mode in ["--no-sparse-index", "--sparse-index"] {
        repo.git(&["sparse-checkout", "set", "--cone", mode, "included"]);
        assert!(!repo.root.join("excluded/two.txt").exists());
        let index = engine.call("index", "git_index", json!({"source": repo.root}));
        assert_eq!(index["status"], "partial", "{mode}");
        assert_eq!(index["limitsReached"], json!(["sparse_checkout"]));
        let id = assert_index_id(&index["indexId"]);
        assert_eq!(
            search(&mut engine, "included", &id, "included-marker")["status"],
            "ok"
        );
        let missing = search(&mut engine, "excluded", &id, "excluded-marker");
        assert_eq!(missing["status"], "empty");
        assert_eq!(missing["partial"], true);
    }
    engine.shutdown();
}

#[test]
fn history_marks_a_shallow_boundary_as_partial() {
    let temp = TempRoot::new("shallow-history");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("example.txt", "before-shallow-boundary\n");
    repo.commit("old");
    repo.write("example.txt", "after-shallow-boundary\n");
    let tip = repo.commit("tip");
    repo.write(".git/shallow", format!("{tip}\n"));
    let mut engine = Engine::start(&temp.path().join("cache"));
    let index = engine.call(
        "index",
        "git_index",
        json!({"source": repo.root, "scope": "history"}),
    );
    assert_eq!(index["status"], "partial");
    assert_eq!(index["commitsVisited"], 1);
    assert_eq!(index["limitsReached"], json!(["shallow_history"]));
    let id = assert_index_id(&index["indexId"]);
    let missing = search(&mut engine, "before", &id, "before-shallow-boundary");
    assert_eq!(missing["status"], "empty");
    assert_eq!(missing["partial"], true);
    engine.shutdown();
}

#[test]
fn history_scope_keeps_deleted_and_replaced_versions() {
    let temp = TempRoot::new("history");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("docs/notes.txt", "historical alpha\n");
    repo.write("stable.txt", "stable\n");
    repo.write("deleted.txt", "gone marker\n");
    let first = repo.commit("first");
    repo.write("docs/notes.txt", "current beta\n");
    repo.remove("deleted.txt");
    let second = repo.commit("second");
    repo.write("later.txt", "later gamma\n");
    let third = repo.commit("third");
    assert_ne!(first, second);
    assert_ne!(second, third);
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let head = engine.call(
        "head",
        "git_index",
        json!({"source": source, "scope": "head"}),
    );
    let head_id = assert_index_id(&head["indexId"]);
    assert_eq!(head["scope"], json!("head"));
    assert_eq!(head["revision"], json!("HEAD"));
    assert_eq!(head["resolvedCommit"], json!(third.as_str()));
    assert_eq!(head["status"], json!("ok"));
    assert_eq!(head["filesIndexed"], json!(3));

    assert_eq!(
        search(&mut engine, "head-alpha", &head_id, "alpha")["status"],
        json!("empty")
    );
    let beta = search(&mut engine, "head-beta", &head_id, "beta");
    assert_eq!(beta["results"][0]["path"], json!("docs/notes.txt"));
    assert_eq!(beta["results"][0]["revision"], json!(third.as_str()));
    assert_eq!(
        search(&mut engine, "head-gone", &head_id, "gone")["status"],
        json!("empty")
    );
    let head_notes = read(&mut engine, "head-notes", &head_id, "docs/notes.txt");
    assert_eq!(head_notes["revision"], json!(third.as_str()));
    assert_eq!(head_notes["content"], json!("current beta\n"));
    assert_eq!(
        read(&mut engine, "head-deleted", &head_id, "deleted.txt")["status"],
        json!("not_found")
    );

    let history = engine.call(
        "history",
        "git_index",
        json!({"source": source, "scope": "history"}),
    );
    let history_id = assert_index_id(&history["indexId"]);
    assert_eq!(history["scope"], json!("history"));
    assert_eq!(history["revision"], json!("HEAD"));
    assert_eq!(history["resolvedCommit"], json!(third.as_str()));
    assert_eq!(history["status"], json!("ok"));
    assert_eq!(history["filesIndexed"], json!(5));
    assert_eq!(history["commitsVisited"], json!(3));
    assert_eq!(history["skipped"]["duplicate"], json!(3));
    assert_eq!(history["limitsReached"], json!([]));

    let alpha = search(&mut engine, "history-alpha", &history_id, "alpha");
    assert_eq!(alpha["partial"], json!(false));
    assert_eq!(alpha["results"][0]["path"], json!("docs/notes.txt"));
    assert_eq!(alpha["results"][0]["revision"], json!(first.as_str()));
    let old = read_at(
        &mut engine,
        "history-old",
        &history_id,
        "docs/notes.txt",
        &first,
    );
    assert_eq!(old["status"], json!("ok"));
    assert_eq!(old["revision"], json!(first.as_str()));
    assert_eq!(old["content"], json!("historical alpha\n"));
    assert_eq!(old["totalLines"], json!(1));

    let current = read(&mut engine, "history-current", &history_id, "docs/notes.txt");
    assert_eq!(current["revision"], json!(third.as_str()));
    assert_eq!(current["content"], json!("current beta\n"));

    let gone = search(&mut engine, "history-gone", &history_id, "gone");
    assert_eq!(gone["results"][0]["path"], json!("deleted.txt"));
    assert_eq!(gone["results"][0]["revision"], json!(first.as_str()));
    let deleted = read_at(
        &mut engine,
        "history-deleted",
        &history_id,
        "deleted.txt",
        &first,
    );
    assert_eq!(deleted["content"], json!("gone marker\n"));

    let later = read(&mut engine, "history-later", &history_id, "later.txt");
    assert_eq!(later["revision"], json!(third.as_str()));
    assert_eq!(later["content"], json!("later gamma\n"));

    let absent = read_at(
        &mut engine,
        "history-absent",
        &history_id,
        "docs/notes.txt",
        &"f".repeat(40),
    );
    assert_eq!(absent["status"], json!("not_found"));
    assert_eq!(absent["content"], json!(""));

    engine.shutdown();
}

#[test]
fn reindex_replaces_stale_worktree_snapshot_with_same_id() {
    let temp = TempRoot::new("refresh");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("app.txt", "generation-one\n");
    repo.commit("initial");
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let first = engine.call(
        "first",
        "git_index",
        json!({"source": source, "scope": "worktree"}),
    );
    let id = assert_index_id(&first["indexId"]);
    assert_eq!(
        search(&mut engine, "before-change", &id, "generation-one")["status"],
        json!("ok")
    );

    repo.write("app.txt", "generation-two\n");
    assert_eq!(
        search(&mut engine, "stale", &id, "generation-two")["status"],
        json!("empty")
    );
    let stale = read(&mut engine, "stale-read", &id, "app.txt");
    assert_eq!(stale["content"], json!("generation-one\n"));

    let refreshed = engine.call(
        "refresh",
        "git_index",
        json!({"source": source, "scope": "worktree"}),
    );
    assert_eq!(refreshed["indexId"], json!(id.as_str()));
    let found = search(&mut engine, "after-change", &id, "generation-two");
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["results"][0]["path"], json!("app.txt"));
    let current = read(&mut engine, "current-read", &id, "app.txt");
    assert_eq!(current["content"], json!("generation-two\n"));

    engine.shutdown();
}

#[test]
fn failed_refresh_keeps_the_last_snapshot() {
    let temp = TempRoot::new("failed-refresh");
    let cache = temp.path().join("cache");
    let nested = (0..4)
        .map(|_| "p".repeat(200))
        .collect::<Vec<_>>()
        .join("/");
    let repo = Repository::init(temp.path().join(&nested), temp.path().join("home"));
    repo.write("marker.txt", "stable-cache-marker\n");
    repo.commit("initial");
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let index = engine.call(
        "index",
        "git_index",
        json!({"source": source, "scope": "worktree"}),
    );
    let id = assert_index_id(&index["indexId"]);
    assert_eq!(
        search(&mut engine, "before-failure", &id, "stable-cache-marker")["status"],
        json!("ok")
    );

    let code = engine.error(
        "refresh",
        "git_index",
        json!({"source": source, "scope": "worktree", "maxOutputBytes": 1024}),
    );
    assert_eq!(code, "output_limit");

    let found = search(&mut engine, "after-failure", &id, "stable-cache-marker");
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["results"][0]["path"], json!("marker.txt"));
    let content = read(&mut engine, "after-failure-read", &id, "marker.txt");
    assert_eq!(content["status"], json!("ok"));
    assert_eq!(content["content"], json!("stable-cache-marker\n"));

    engine.shutdown();
}

#[test]
fn cache_survives_engine_restarts() {
    let temp = TempRoot::new("persistence");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("state.txt", "persistent-marker\n");
    repo.commit("initial");
    let source = repo.root.to_str().unwrap();

    let (id, before) = {
        let mut engine = Engine::start(&cache);
        let index = engine.call(
            "index",
            "git_index",
            json!({"source": source, "scope": "worktree"}),
        );
        let id = assert_index_id(&index["indexId"]);
        let found = search(&mut engine, "before-restart", &id, "persistent-marker");
        assert_eq!(found["status"], json!("ok"));
        engine.shutdown();
        (id, found)
    };

    assert!(cache.join(&id).join("manifest.json").is_file());
    assert!(cache.join(&id).join("index").is_dir());
    let mut engine = Engine::start(&cache);
    let after = search(&mut engine, "after-restart", &id, "persistent-marker");
    assert_eq!(after, before);
    let content = read(&mut engine, "after-restart-read", &id, "state.txt");
    assert_eq!(content["status"], json!("ok"));
    assert_eq!(content["content"], json!("persistent-marker\n"));
    engine.shutdown();
}

#[test]
fn old_manifests_require_reindexing() {
    let temp = TempRoot::new("old-manifest");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("state.txt", "snapshot-marker\n");
    let mut engine = Engine::start(&cache);
    let params = json!({"source": repo.root});
    let index = engine.call("index", "git_index", params.clone());
    let id = assert_index_id(&index["indexId"]);
    fs::write(
        cache.join(&id).join("manifest.json"),
        json!({"formatVersion": 1, "result": index}).to_string(),
    )
    .unwrap();
    assert_eq!(
        engine.error(
            "old-search",
            "git_search",
            json!({"indexId": id, "query": "snapshot-marker"})
        ),
        "index_incompatible"
    );
    assert_eq!(
        engine.error(
            "old-read",
            "git_read",
            json!({"indexId": id, "path": "state.txt"})
        ),
        "index_incompatible"
    );
    let refreshed = engine.call("refresh", "git_index", params);
    assert_eq!(refreshed["indexId"], id);
    assert_eq!(
        read(&mut engine, "new-read", &id, "state.txt")["content"],
        "snapshot-marker\n"
    );
    engine.shutdown();
}

#[test]
fn index_limits_report_partial_coverage() {
    let temp = TempRoot::new("limits");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("f1.txt", "limit marker f1\n");
    repo.write("f2.txt", "limit marker f2\n");
    repo.commit("first");
    repo.write("f3.txt", "limit marker f3\n");
    repo.write("f4.txt", "limit marker f4\n");
    repo.commit("second");
    repo.write("f5.txt", "limit marker f5\n");
    repo.write("f6.txt", "limit marker f6\n");
    repo.commit("third");
    repo.write("big-a.txt", "a".repeat(600_000));
    repo.write("big-b.txt", "b".repeat(600_000));
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let files = engine.call(
        "file-limit",
        "git_index",
        json!({"source": source, "scope": "worktree", "maxFiles": 2}),
    );
    assert_eq!(files["filesIndexed"], json!(2));
    assert_eq!(files["limitsReached"], json!(["file_limit"]));
    assert_eq!(files["status"], json!("partial"));
    let files_id = assert_index_id(&files["indexId"]);
    let file_search = search(&mut engine, "file-limit-search", &files_id, "limit marker");
    assert_eq!(file_search["partial"], json!(true));

    let commits = engine.call(
        "commit-limit",
        "git_index",
        json!({"source": source, "scope": "history", "maxCommits": 2}),
    );
    assert_eq!(commits["commitsVisited"], json!(2));
    assert_eq!(commits["filesIndexed"], json!(6));
    assert_eq!(commits["skipped"]["duplicate"], json!(4));
    assert_eq!(commits["limitsReached"], json!(["commit_limit"]));
    assert_eq!(commits["status"], json!("partial"));
    let commits_id = assert_index_id(&commits["indexId"]);
    let commit_search = search(
        &mut engine,
        "commit-limit-search",
        &commits_id,
        "limit marker f5",
    );
    assert_eq!(commit_search["partial"], json!(true));
    assert_eq!(commit_search["results"][0]["path"], json!("f5.txt"));

    let bytes = engine.call(
        "byte-limit",
        "git_index",
        json!({"source": source, "scope": "worktree", "maxTotalBytes": 1_048_576}),
    );
    assert_eq!(bytes["limitsReached"], json!(["byte_limit"]));
    assert_eq!(bytes["filesIndexed"], json!(1));
    assert_eq!(bytes["bytesIndexed"], json!(600_000));
    assert_eq!(bytes["status"], json!("partial"));

    engine.shutdown();
}

#[test]
fn malformed_parameters_and_traversal_ids_are_rejected() {
    let temp = TempRoot::new("invalid");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("safe.txt", "safe\n");
    repo.commit("initial");
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let invalid_indexes = vec![
        json!({}),
        json!({"source": source, "maxFiles": 0}),
        json!({"source": source, "maxFiles": 20_001}),
        json!({"source": source, "maxCommits": 0}),
        json!({"source": source, "maxCommits": 10_001}),
        json!({"source": source, "maxFileBytes": 1023}),
        json!({"source": source, "maxFileBytes": 4_194_305}),
        json!({"source": source, "maxTotalBytes": 1_048_575}),
        json!({"source": source, "maxDownloadBytes": 268_435_457}),
        json!({"source": source, "maxOutputBytes": 49_153}),
        json!({"source": source, "scope": "worktree", "revision": "HEAD"}),
        json!({"source": source, "scope": "bogus"}),
        json!({"source": source, "revision": "x".repeat(257)}),
        json!({"source": format!("{source}\n")}),
        json!({"source": source, "headers": {}}),
        json!({"source": ""}),
        json!({"source": "http://example.invalid/repo.git"}),
        json!({"source": "https://user:pass@example.invalid/repo.git"}),
        json!({"source": "https://example.invalid/repo.git?ref=main"}),
    ];
    for (index, params) in invalid_indexes.into_iter().enumerate() {
        let code = engine.error(&format!("bad-index-{index}"), "git_index", params);
        assert_eq!(code, "invalid_params");
    }
    assert_eq!(
        engine.error("missing-index-params", "git_index", Value::Null),
        "invalid_params"
    );
    let absent_source = temp.path().join("absent");
    assert_eq!(
        engine.error(
            "absent-source",
            "git_index",
            json!({"source": absent_source.to_str().unwrap()}),
        ),
        "repository_error"
    );

    let index = engine.call(
        "valid-index",
        "git_index",
        json!({"source": source, "scope": "worktree"}),
    );
    let id = assert_index_id(&index["indexId"]);

    let invalid_ids = [
        "../index".to_string(),
        "A".repeat(64),
        "0".repeat(63),
        "0".repeat(65),
        String::new(),
    ];
    for (index, invalid) in invalid_ids.iter().enumerate() {
        let params = json!({"indexId": invalid, "query": "safe"});
        assert_eq!(
            engine.error(&format!("bad-search-id-{index}"), "git_search", params),
            "invalid_params"
        );
        let params = json!({"indexId": invalid, "path": "safe.txt"});
        assert_eq!(
            engine.error(&format!("bad-read-id-{index}"), "git_read", params),
            "invalid_params"
        );
    }
    let absent_id = "0".repeat(64);
    assert_eq!(
        engine.error(
            "missing-index",
            "git_search",
            json!({"indexId": &absent_id, "query": "safe"}),
        ),
        "index_not_found"
    );
    assert_eq!(
        engine.error(
            "missing-index-read",
            "git_read",
            json!({"indexId": &absent_id, "path": "safe.txt"}),
        ),
        "index_not_found"
    );
    assert_eq!(
        engine.error("missing-search-params", "git_search", Value::Null),
        "invalid_params"
    );

    let invalid_searches = vec![
        json!({"indexId": &id, "query": ""}),
        json!({"indexId": &id, "query": "x".repeat(513)}),
        json!({"indexId": &id, "query": "safe\n"}),
        json!({"indexId": &id, "query": "safe", "maxResults": 0}),
        json!({"indexId": &id, "query": "safe", "maxResults": 51}),
        json!({"indexId": &id, "query": "safe", "maxOutputBytes": 1023}),
        json!({"indexId": &id, "query": "safe", "path": "x".repeat(1025)}),
        json!({"indexId": &id, "query": "safe", "regex": "yes"}),
        json!({"indexId": &id, "query": "[", "regex": true}),
        json!({"indexId": &id, "query": "safe", "unknown": true}),
    ];
    for (index, params) in invalid_searches.into_iter().enumerate() {
        let code = engine.error(&format!("bad-search-{index}"), "git_search", params);
        assert_eq!(code, "invalid_params");
    }

    let invalid_reads = vec![
        json!({"indexId": &id, "path": "a\nb"}),
        json!({"indexId": &id, "path": "x".repeat(1025)}),
        json!({"indexId": &id, "path": "safe.txt", "revision": "HEAD"}),
        json!({"indexId": &id, "path": "safe.txt", "revision": "a".repeat(39)}),
        json!({"indexId": &id, "path": "safe.txt", "revision": "A".repeat(40)}),
        json!({"indexId": &id, "path": "safe.txt", "startLine": 0}),
        json!({"indexId": &id, "path": "safe.txt", "maxLines": 1001}),
        json!({"indexId": &id, "path": "safe.txt", "maxOutputBytes": 1023}),
        json!({"indexId": &id, "path": "safe.txt", "extra": true}),
    ];
    for (index, params) in invalid_reads.into_iter().enumerate() {
        let code = engine.error(&format!("bad-read-{index}"), "git_read", params);
        assert_eq!(code, "invalid_params");
    }

    for (index, path) in ["/etc/passwd", "../outside.txt", "src/../safe.txt"]
        .iter()
        .enumerate()
    {
        let result = read(&mut engine, &format!("traversal-{index}"), &id, path);
        assert_eq!(result["status"], json!("not_found"), "path {path}");
        assert_eq!(result["content"], json!(""));
        assert_eq!(result["totalLines"], json!(0));
        assert_eq!(result["endLine"], json!(0));
    }
    let escaped_prefix = engine.call(
        "escaped-prefix",
        "git_search",
        json!({"indexId": &id, "query": "safe", "path": "../"}),
    );
    assert_eq!(escaped_prefix["status"], json!("empty"));

    engine.shutdown();
}

#[test]
fn search_handles_unicode_regex_long_lines_and_output_bounds() {
    let temp = TempRoot::new("text");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    let long_line = format!("prefix {} needle-tail", "x".repeat(3000));
    repo.write(
        "unicode.txt",
        format!("café naïve 日本語 alpha\n{long_line}\n日本語 needle\n"),
    );
    for index in 0..10 {
        repo.write(&format!("many/{index:02}.txt"), "needle\n");
    }
    let deep_dir = (0..5)
        .map(|_| "d".repeat(180))
        .collect::<Vec<_>>()
        .join("/");
    let deep_path = format!("{deep_dir}/target.txt");
    repo.write(&deep_path, "b".repeat(500));
    repo.commit("text fixture");
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    let index = engine.call(
        "index",
        "git_index",
        json!({"source": source, "scope": "worktree"}),
    );
    let id = assert_index_id(&index["indexId"]);
    assert_eq!(index["status"], json!("ok"));
    assert_eq!(index["filesIndexed"], json!(12));

    let literal = search(&mut engine, "literal", &id, "café");
    assert_eq!(literal["results"][0]["path"], json!("unicode.txt"));
    assert_eq!(literal["results"][0]["line"], json!(1));
    assert_eq!(literal["results"][0]["column"], json!(1));
    assert_eq!(
        search(&mut engine, "literal-upper", &id, "CAFÉ")["status"],
        json!("empty")
    );
    let insensitive = engine.call(
        "literal-insensitive",
        "git_search",
        json!({"indexId": &id, "query": "CAFÉ", "caseSensitive": false}),
    );
    assert_eq!(insensitive["results"][0]["path"], json!("unicode.txt"));
    assert_eq!(insensitive["results"][0]["line"], json!(1));

    let regex = engine.call(
        "regex",
        "git_search",
        json!({"indexId": &id, "query": "na[iï]ve", "regex": true}),
    );
    assert_eq!(regex["results"][0]["path"], json!("unicode.txt"));
    assert_eq!(regex["results"][0]["line"], json!(1));
    assert_eq!(regex["results"][0]["column"], json!(7));
    assert_eq!(
        engine.error(
            "bad-regex",
            "git_search",
            json!({"indexId": &id, "query": "[", "regex": true}),
        ),
        "invalid_params"
    );
    let cross_line = engine.call(
        "cross-line",
        "git_search",
        json!({"indexId": &id, "query": "alpha.*日本語", "regex": true}),
    );
    assert_eq!(cross_line["status"], json!("empty"));

    let tail = engine.call(
        "long-line",
        "git_search",
        json!({"indexId": &id, "query": "needle-tail", "path": "unicode.txt"}),
    );
    let tail_item = &tail["results"][0];
    assert_eq!(tail_item["path"], json!("unicode.txt"));
    assert_eq!(tail_item["line"], json!(2));
    assert_eq!(tail_item["column"], json!(3009));
    let snippet = tail_item["snippet"].as_str().unwrap();
    assert!(snippet.contains("needle-tail"));
    assert!(snippet.len() <= 512);

    let unicode_line = engine.call(
        "unicode-line",
        "git_search",
        json!({"indexId": &id, "query": "needle", "path": "unicode.txt"}),
    );
    let needle_line = unicode_line["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["line"] == json!(3))
        .expect("unicode line result");
    assert_eq!(needle_line["column"], json!(11));

    let page = engine.call(
        "page",
        "git_read",
        json!({"indexId": &id, "path": "unicode.txt", "startLine": 2, "maxLines": 1, "maxOutputBytes": 1024}),
    );
    assert_eq!(page["status"], json!("ok"));
    assert_eq!(page["startLine"], json!(2));
    assert_eq!(page["endLine"], json!(2));
    assert_eq!(page["totalLines"], json!(3));
    assert_eq!(page["truncated"], json!(true));
    let page_content = page["content"].as_str().unwrap();
    assert!(page_content.starts_with("prefix "));
    assert!(page_content.len() < long_line.len());

    let past = engine.call(
        "past-eof",
        "git_read",
        json!({"indexId": &id, "path": "unicode.txt", "startLine": 100}),
    );
    assert_eq!(past["status"], json!("ok"));
    assert_eq!(past["startLine"], json!(100));
    assert_eq!(past["endLine"], json!(0));
    assert_eq!(past["totalLines"], json!(3));
    assert_eq!(past["content"], json!(""));

    let bounded = engine.call(
        "bounded",
        "git_search",
        json!({"indexId": &id, "query": "needle", "maxResults": 50, "maxOutputBytes": 1024}),
    );
    assert_eq!(bounded["truncated"], json!(true));
    let bounded_results = bounded["results"].as_array().unwrap();
    assert!(!bounded_results.is_empty());
    assert!(bounded_results.len() < 12);
    assert!(serde_json::to_vec(&bounded).unwrap().len() <= 1024);

    assert_eq!(
        engine.error(
            "single-item-limit",
            "git_search",
            json!({"indexId": &id, "query": "b".repeat(500), "maxOutputBytes": 1024}),
        ),
        "output_limit"
    );

    engine.shutdown();
}

#[test]
fn read_continuations_reconstruct_long_utf8_lines_without_skips() {
    let temp = TempRoot::new("read-continuation");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    let expected = format!("first\n{}\nlast", "日\"\\".repeat(900));
    repo.write("long.txt", &expected);
    repo.commit("lines");
    let mut engine = Engine::start(&temp.path().join("cache"));
    let index = engine.call("index", "git_index", json!({"source": repo.root}));
    let id = assert_index_id(&index["indexId"]);
    let mut cursor = json!({"line": 1, "column": 1});
    let mut content = String::new();
    for request in 1..=30 {
        let page = engine.call(
            &format!("page-{request}"),
            "git_read",
            json!({"indexId": id, "path": "long.txt", "startLine": cursor["line"],
                "startColumn": cursor["column"], "maxLines": 1, "maxOutputBytes": 1024}),
        );
        assert!(serde_json::to_vec(&page).unwrap().len() <= 1024);
        assert_eq!(page["startLine"], cursor["line"]);
        assert_eq!(page["startColumn"], cursor["column"]);
        assert_eq!(page["truncated"], !page["next"].is_null());
        let chunk = page["content"].as_str().unwrap();
        assert!(!chunk.is_empty());
        content.push_str(chunk);
        if request == 1 {
            assert_eq!(page["next"], json!({"line": 2, "column": 1}));
        }
        if page["next"].is_null() {
            break;
        }
        cursor = page["next"].clone();
    }
    assert_eq!(content, expected);
    assert_eq!(
        engine.error(
            "bad-boundary",
            "git_read",
            json!({"indexId": id, "path": "long.txt", "startLine": 2, "startColumn": 2})
        ),
        "invalid_params"
    );
    engine.shutdown();
}

#[test]
fn deadline_and_cancel_keep_engine_responsive_and_clean_stages() {
    let temp = TempRoot::new("cancel");
    let cache = temp.path().join("cache");
    let repo = Repository::init(temp.path().join("repo"), temp.path().join("home"));
    repo.write("README.md", "fixture\n");
    repo.commit("base");
    for index in 0..1500 {
        repo.write(
            &format!("files/{index:04}.txt"),
            format!("slow file {index}\n{}", "y".repeat(8192)),
        );
    }
    let source = repo.root.to_str().unwrap();
    let mut engine = Engine::start(&cache);

    engine.send_request("timeout", "git_index", json!({"source": source}), 1);
    let timed_out = engine.line();
    assert_eq!(timed_out["type"], json!("error"));
    assert_eq!(timed_out["id"], json!("timeout"));
    assert_eq!(timed_out["code"], json!("timeout"));

    let status = engine.call("status-after-timeout", "status", json!({}));
    assert!(status["engineVersion"].is_string());
    let operations = status["operations"].as_array().unwrap();
    for operation in ["git_index", "git_search", "git_read"] {
        assert!(operations.contains(&json!(operation)));
    }
    wait_for_stage_cleanup(&cache);

    engine.send_request(
        "cancel",
        "git_index",
        json!({"source": source}),
        GIT_TIMEOUT_MS,
    );
    let stages = wait_for_stage(&cache);
    assert!(!stages.is_empty());
    engine.send_cancel("cancel");
    let cancelled = engine.line();
    assert_eq!(cancelled["type"], json!("error"));
    assert_eq!(cancelled["id"], json!("cancel"));
    assert_eq!(cancelled["code"], json!("cancelled"));

    let status = engine.call("status-after-cancel", "status", json!({}));
    assert!(status["engineVersion"].is_string());
    wait_for_stage_cleanup(&cache);

    let small = {
        let mut attempt = 0;
        loop {
            let id = format!("small-index-{attempt}");
            let frame = engine.exchange(
                &id,
                "git_index",
                json!({"source": source, "maxFiles": 1}),
                GIT_TIMEOUT_MS,
            );
            if frame["type"] == json!("result") {
                break frame["result"].clone();
            }
            assert_eq!(frame["type"], json!("error"), "unexpected frame: {frame}");
            assert_eq!(frame["code"], json!("busy"), "unexpected frame: {frame}");
            attempt += 1;
            assert!(attempt < 50, "engine stayed busy");
            thread::sleep(Duration::from_millis(50));
        }
    };
    assert_eq!(small["filesIndexed"], json!(1));
    assert_eq!(small["status"], json!("partial"));
    assert_eq!(small["limitsReached"], json!(["file_limit"]));
    wait_for_stage_cleanup(&cache);

    engine.shutdown();
}
