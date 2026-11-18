use std::collections::{BTreeSet, HashSet, VecDeque};
use std::ffi::{CString, OsStr};
use std::fs::{self, File};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

use gix::{
    index::entry::{Flags, Mode},
    ObjectId,
};
use serde::Serialize;

use super::index::IndexedFile;
use super::params::{IndexParams, Scope};
use super::transport::{clone_repository, TransportError};
use crate::protocol::ErrorCode;

const MAX_ENTRIES: u64 = 200_000;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Skipped {
    binary: u64,
    large: u64,
    non_utf8: u64,
    unsafe_path: u64,
    unreadable: u64,
    submodule: u64,
    duplicate: u64,
}

pub(super) struct Snapshot {
    pub source: String,
    pub scope: Scope,
    pub revision: Option<String>,
    pub resolved_commit: Option<String>,
    pub files: Vec<IndexedFile>,
    pub bytes: u64,
    pub commits: u64,
    pub download_bytes: u64,
    pub skipped: Skipped,
    pub limits: Vec<&'static str>,
    entries: u64,
}

impl Snapshot {
    pub fn partial(&self) -> bool {
        !self.limits.is_empty()
            || self.skipped.large > 0
            || self.skipped.non_utf8 > 0
            || self.skipped.unsafe_path > 0
            || self.skipped.unreadable > 0
            || self.skipped.submodule > 0
    }

    fn entry(&mut self) -> bool {
        if self.entries >= MAX_ENTRIES {
            self.reached("entry_limit");
            return false;
        }
        self.entries += 1;
        true
    }

    fn reached(&mut self, limit: &'static str) {
        if !self.limits.contains(&limit) { self.limits.push(limit); }
    }

    fn add(&mut self, path: String, revision: Option<String>, data: Vec<u8>, params: &IndexParams) -> bool {
        if data.contains(&0) { self.skipped.binary += 1; return true; }
        let text = match String::from_utf8(data) {
            Ok(text) => text,
            Err(_) => { self.skipped.non_utf8 += 1; return true; }
        };
        if self.files.len() as u64 >= params.max_files { self.reached("file_limit"); return false; }
        if self.bytes + text.len() as u64 > params.max_total_bytes { self.reached("byte_limit"); return false; }
        self.bytes += text.len() as u64;
        self.files.push(IndexedFile { path, revision, content: text });
        true
    }
}

pub(super) fn collect(params: &IndexParams, stage: &Path) -> Result<Snapshot, ErrorCode> {
    let remote = remote_url(&params.source)?;
    if remote.is_some() && params.scope == Some(Scope::Worktree) { return Err(ErrorCode::InvalidParams); }
    let (repo, source, download_bytes) = if let Some(url) = remote {
        let destination = stage.join("repository");
        let bytes = clone_repository(url.as_str(), &destination, params.max_download_bytes)
            .map_err(|e| match e {
                TransportError::Network => ErrorCode::NetworkError,
                TransportError::Limit => ErrorCode::ResourceLimit,
                TransportError::Auth => ErrorCode::RepositoryAuthRequired,
                TransportError::Git => ErrorCode::RepositoryError,
            })?;
        let repo = gix::open_opts(&destination, gix::open::Options::isolated())
            .map_err(|_| ErrorCode::RepositoryError)?;
        (repo, url.to_string(), bytes)
    } else {
        let path = fs::canonicalize(&params.source).map_err(|_| ErrorCode::RepositoryError)?;
        if !path.is_dir() { return Err(ErrorCode::InvalidParams); }
        let repo = gix::discover_opts(&path, Default::default(), gix::open::Options::isolated())
            .map_err(|_| ErrorCode::RepositoryError)?;
        let root = repo.workdir().unwrap_or_else(|| repo.path());
        let root = fs::canonicalize(root).map_err(|_| ErrorCode::RepositoryError)?;
        let source = root.to_str().filter(|s| super::params::valid_text(s, 4096))
            .ok_or(ErrorCode::InvalidParams)?.to_string();
        (repo, source, 0)
    };
    let scope = params.scope.unwrap_or(if download_bytes > 0 || repo.workdir().is_none() {
        Scope::Head
    } else { Scope::Worktree });
    if scope == Scope::Worktree && (params.revision.is_some() || repo.workdir().is_none()) {
        return Err(ErrorCode::InvalidParams);
    }
    let revision = if scope == Scope::Worktree { None }
        else { Some(params.revision.clone().unwrap_or_else(|| "HEAD".into())) };
    let unborn = repo.head().map_err(|_| ErrorCode::RepositoryError)?.is_unborn();
    let commit_id = if scope == Scope::Worktree {
        repo.head_id().ok().map(|id| id.detach())
    } else if unborn && revision.as_deref() == Some("HEAD") {
        None
    } else {
        let id = repo.rev_parse_single(revision.as_deref().unwrap_or("HEAD"))
            .map_err(|_| ErrorCode::RepositoryError)?;
        let commit = id.object().and_then(|o| o.peel_to_commit())
            .map_err(|_| ErrorCode::RepositoryError)?;
        Some(commit.id)
    };
    let mut snapshot = Snapshot { source, scope, revision, resolved_commit: commit_id.map(|id| id.to_string()),
        files: Vec::new(), bytes: 0, commits: 0, download_bytes, skipped: Skipped::default(),
        limits: Vec::new(), entries: 0 };
    if scope == Scope::Worktree {
        worktree(&repo, params, &mut snapshot)?;
    } else if let Some(commit) = commit_id {
        committed(&repo, commit, params, &mut snapshot)?;
    }
    Ok(snapshot)
}

fn remote_url(source: &str) -> Result<Option<reqwest::Url>, ErrorCode> {
    if !source.contains("://") && !source.starts_with("git@") { return Ok(None); }
    let url = reqwest::Url::parse(source).map_err(|_| ErrorCode::InvalidParams)?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
    { return Err(ErrorCode::InvalidParams); }
    Ok(Some(url))
}

fn worktree(
    repo: &gix::Repository,
    params: &IndexParams,
    snapshot: &mut Snapshot,
) -> Result<(), ErrorCode> {
    let root = repo.workdir().ok_or(ErrorCode::InvalidParams)?;
    let root_fd = File::open(root).map_err(|_| ErrorCode::RepositoryError)?;
    let index = repo
        .index_or_empty()
        .map_err(|_| ErrorCode::RepositoryError)?;
    snapshot.entries = index.entries().len() as u64;
    if snapshot.entries > MAX_ENTRIES {
        return Err(ErrorCode::ResourceLimit);
    }
    let mut tracked = BTreeSet::new();
    let mut submodules = HashSet::new();
    for entry in index.entries() {
        let path = Path::new(OsStr::from_bytes(entry.path(&index)));
        if entry.mode == Mode::DIR || entry.flags.contains(Flags::SKIP_WORKTREE) {
            snapshot.reached("sparse_checkout");
        }
        if entry.mode == Mode::COMMIT {
            submodules.insert(root.join(path));
        } else if entry.mode != Mode::DIR {
            tracked.insert(path);
        }
    }
    snapshot.skipped.submodule = submodules.len() as u64;
    if !submodules.is_empty() {
        tracked.retain(|path| {
            !root
                .join(path)
                .ancestors()
                .any(|prefix| submodules.contains(prefix))
        });
    }
    let mut walker = ignore::WalkBuilder::new(root);
    walker
        .hidden(false)
        .parents(false)
        .git_global(false)
        .follow_links(false)
        .max_depth(Some(64))
        .sort_by_file_path(|a, b| a.cmp(b))
        .filter_entry(move |entry| {
            entry.file_name() != ".git" && !submodules.contains(entry.path())
        });
    for entry in walker.build() {
        if !snapshot.entry() {
            return Ok(());
        }
        let Ok(entry) = entry else {
            snapshot.skipped.unreadable += 1;
            continue;
        };
        let Some(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if entry.depth() == 64 {
                snapshot.skipped.unsafe_path += 1;
            }
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| ErrorCode::RepositoryError)?;
        tracked.remove(path);
        if !kind.is_file() {
            snapshot.skipped.unsafe_path += 1;
            continue;
        }
        if !add_worktree_file(&root_fd, path, params, snapshot) {
            return Ok(());
        }
    }
    for path in tracked {
        if !add_worktree_file(&root_fd, path, params, snapshot) {
            break;
        }
    }
    Ok(())
}

fn add_worktree_file(
    root: &File,
    path: &Path,
    params: &IndexParams,
    snapshot: &mut Snapshot,
) -> bool {
    let Some(path) = path.to_str().filter(|s| safe_path(s)) else {
        snapshot.skipped.unsafe_path += 1;
        return true;
    };
    match read_beneath(root, path, params.max_file_bytes) {
        Ok(Some(data)) => return snapshot.add(path.to_string(), None, data, params),
        Ok(None) => snapshot.skipped.large += 1,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            snapshot.skipped.unsafe_path += 1
        }
        Err(_) => snapshot.skipped.unreadable += 1,
    }
    true
}

fn committed(repo: &gix::Repository, tip: ObjectId, params: &IndexParams, snapshot: &mut Snapshot) -> Result<(), ErrorCode> {
    let mut commits = VecDeque::from([tip]);
    let mut seen_commits = HashSet::new();
    let mut versions = HashSet::new();
    let shallow = if snapshot.scope == Scope::History {
        repo.shallow_commits()
            .map_err(|_| ErrorCode::RepositoryError)?
    } else {
        None
    };
    while let Some(id) = commits.pop_front() {
        if !seen_commits.insert(id) { continue; }
        if snapshot.commits >= params.max_commits { snapshot.reached("commit_limit"); break; }
        if repo.find_header(id).map_err(|_| ErrorCode::RepositoryError)?.size() > 262_144 {
            return Err(ErrorCode::ResourceLimit);
        }
        let commit = repo.find_commit(id).map_err(|_| ErrorCode::RepositoryError)?;
        snapshot.commits += 1;
        let tree = commit.tree_id().map_err(|_| ErrorCode::RepositoryError)?.detach();
        if !tree_files(repo, tree, id, params, snapshot, &mut versions)? { break; }
        if snapshot.scope != Scope::History { break; }
        if shallow
            .as_ref()
            .is_some_and(|ids| ids.binary_search(&id).is_ok())
        {
            snapshot.reached("shallow_history");
            continue;
        }
        for parent in commit.parent_ids() {
            if commits.len() >= MAX_ENTRIES as usize { snapshot.reached("entry_limit"); return Ok(()); }
            commits.push_back(parent.detach());
        }
    }
    Ok(())
}

fn tree_files(repo: &gix::Repository, tree: ObjectId, revision: ObjectId, params: &IndexParams,
    snapshot: &mut Snapshot, versions: &mut HashSet<(String, ObjectId)>) -> Result<bool, ErrorCode>
{
    let mut trees = vec![(tree, String::new(), 0)];
    while let Some((id, prefix, depth)) = trees.pop() {
        if repo.find_header(id).map_err(|_| ErrorCode::RepositoryError)?.size() > 4_194_304 {
            return Err(ErrorCode::ResourceLimit);
        }
        let tree = repo.find_tree(id).map_err(|_| ErrorCode::RepositoryError)?;
        for entry in gix::objs::TreeRefIter::from_bytes(&tree.data, repo.object_hash()) {
            if !snapshot.entry() { return Ok(false); }
            let entry = entry.map_err(|_| ErrorCode::RepositoryError)?;
            let Ok(name) = std::str::from_utf8(entry.filename) else { snapshot.skipped.unsafe_path += 1; continue; };
            if name.contains('/') || name == "." || name == ".." { snapshot.skipped.unsafe_path += 1; continue; }
            let path = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
            if !safe_path(&path) { snapshot.skipped.unsafe_path += 1; continue; }
            let oid = entry.oid.to_owned();
            match entry.mode.kind() {
                gix::objs::tree::EntryKind::Tree => {
                    if depth >= 64 { snapshot.skipped.unsafe_path += 1; }
                    else { trees.push((oid, path, depth + 1)); }
                }
                gix::objs::tree::EntryKind::Commit => snapshot.skipped.submodule += 1,
                gix::objs::tree::EntryKind::Link => snapshot.skipped.unsafe_path += 1,
                gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                    if !versions.insert((path.clone(), oid)) { snapshot.skipped.duplicate += 1; continue; }
                    let header = repo.find_header(oid).map_err(|_| ErrorCode::RepositoryError)?;
                    if header.kind() != gix::objs::Kind::Blob { return Err(ErrorCode::RepositoryError); }
                    if header.size() > params.max_file_bytes { snapshot.skipped.large += 1; continue; }
                    let blob = repo.find_blob(oid).map_err(|_| ErrorCode::RepositoryError)?;
                    if blob.data.len() as u64 > params.max_file_bytes { snapshot.skipped.large += 1; continue; }
                    if !snapshot.add(path, Some(revision.to_string()), blob.data.clone(), params) { return Ok(false); }
                }
            }
        }
    }
    Ok(true)
}

pub(super) fn safe_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 1024 && !path.chars().any(char::is_control)
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(s) if s != ".git"))
}

fn read_beneath(root: &File, path: &str, max: u64) -> std::io::Result<Option<Vec<u8>>> {
    let components: Vec<_> = Path::new(path).components().collect();
    let mut parent = root.try_clone()?;
    for (i, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else { return Err(std::io::ErrorKind::InvalidInput.into()); };
        let name = CString::new(name.as_encoded_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let last = i + 1 == components.len();
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
            | if last { 0 } else { libc::O_DIRECTORY };
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        let file = unsafe { File::from_raw_fd(fd) };
        if !last { parent = file; continue; }
        let metadata = file.metadata()?;
        if !metadata.is_file() { return Err(std::io::ErrorKind::InvalidInput.into()); }
        if metadata.len() > max { return Ok(None); }
        let mut bytes = Vec::new();
        file.take(max + 1).read_to_end(&mut bytes)?;
        return if bytes.len() as u64 > max { Ok(None) } else { Ok(Some(bytes)) };
    }
    Err(std::io::ErrorKind::InvalidInput.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_remote_protocols_credentials_and_queries() {
        for value in ["http://example.com/repo.git", "ssh://example.com/repo", "git@example.com:x",
            "https://u:p@example.com/repo", "https://example.com/repo?q=1", "https://example.com/repo#x"] {
            assert!(remote_url(value).is_err(), "{value}");
        }
        assert!(remote_url("https://example.com/repo.git").unwrap().is_some());
        assert!(remote_url("/tmp/repo").unwrap().is_none());
    }

    #[test]
    fn accepts_only_safe_relative_paths() {
        for path in ["", "/etc/passwd", "../x", "a/../x", ".git/config", "a/.git/config", "a\nb"] {
            assert!(!safe_path(path), "{path}");
        }
        assert!(safe_path("src/.config/file.rs"));
    }
}
