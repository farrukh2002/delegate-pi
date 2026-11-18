use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::params::valid_index_id;
use crate::protocol::ErrorCode;

pub(super) const FORMAT_VERSION: u64 = 2;
pub(super) const MAX_INDEX_BYTES: u64 = 536_870_912;
const MAX_CACHE_BYTES: u64 = 2_147_483_648;
const MAX_CACHE_INDEXES: usize = 32;

pub(super) struct Cache {
    pub root: PathBuf,
}

pub(super) struct Stage {
    pub path: PathBuf,
    _lease: File,
}

impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

impl Cache {
    pub fn prepare(root: PathBuf) -> Result<Self, ErrorCode> {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&root)
            .map_err(|_| ErrorCode::RepositoryError)?;
        let metadata = fs::symlink_metadata(&root).map_err(|_| ErrorCode::RepositoryError)?;
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(ErrorCode::RepositoryError);
        }
        Ok(Self { root: fs::canonicalize(root).map_err(|_| ErrorCode::RepositoryError)? })
    }

    pub fn create_stage(&self) -> Result<Stage, ErrorCode> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| ErrorCode::Internal)?.as_nanos();
        let path = self.root.join(format!(".stage-{}-{nonce}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&path).map_err(|_| ErrorCode::RepositoryError)?;
        let lease = match lock_file(&path.join("lease")) {
            Ok(file) => file,
            Err(error) => { let _ = fs::remove_dir_all(&path); return Err(error); }
        };
        fs2::FileExt::lock_shared(&lease).map_err(|_| ErrorCode::RepositoryError)?;
        Ok(Stage { path, _lease: lease })
    }

    pub fn worker_slot(&self) -> Result<File, ErrorCode> {
        for i in 0..2 {
            let file = lock_file(&self.root.join(format!(".worker-{i}.lock")))?;
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(file),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(_) => return Err(ErrorCode::RepositoryError),
            }
        }
        Err(ErrorCode::Busy)
    }

    pub fn cleanup_stages(&self, active: &Path) -> Result<(), ErrorCode> {
        let mut count = 0;
        for entry in fs::read_dir(&self.root).map_err(|_| ErrorCode::RepositoryError)? {
            let entry = entry.map_err(|_| ErrorCode::RepositoryError)?;
            if !entry.file_name().as_encoded_bytes().starts_with(b".stage-") || entry.path() == active {
                continue;
            }
            count += 1;
            if count > 64 { return Err(ErrorCode::ResourceLimit); }
            if !entry.file_type().map_err(|_| ErrorCode::RepositoryError)?.is_dir() { continue; }
            let lease = match lock_file(&entry.path().join("lease")) {
                Ok(file) => file,
                Err(_) => continue,
            };
            if fs2::FileExt::try_lock_exclusive(&lease).is_ok() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }

    pub fn build_lock(&self) -> Result<File, ErrorCode> {
        let file = lock_file(&self.root.join(".build.lock"))?;
        fs2::FileExt::try_lock_exclusive(&file).map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock { ErrorCode::Busy }
            else { ErrorCode::RepositoryError }
        })?;
        Ok(file)
    }

    pub fn index_lock(&self, id: &str, exclusive: bool) -> Result<File, ErrorCode> {
        if !valid_index_id(id) { return Err(ErrorCode::InvalidParams); }
        let file = lock_file(&self.root.join(".publish.lock"))?;
        if exclusive { fs2::FileExt::lock_exclusive(&file) }
        else { fs2::FileExt::lock_shared(&file) }.map_err(|_| ErrorCode::RepositoryError)?;
        Ok(file)
    }

    pub fn manifest(&self, id: &str) -> Result<Value, ErrorCode> {
        let path = self.root.join(id).join("manifest.json");
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::IndexNotFound
            } else { ErrorCode::IndexIncompatible })?;
        if !file.metadata().map_err(|_| ErrorCode::IndexIncompatible)?.is_file() {
            return Err(ErrorCode::IndexIncompatible);
        }
        let mut data = Vec::new();
        file.take(16385).read_to_end(&mut data).map_err(|_| ErrorCode::IndexIncompatible)?;
        if data.len() > 16384 { return Err(ErrorCode::IndexIncompatible); }
        let value: Value = serde_json::from_slice(&data).map_err(|_| ErrorCode::IndexIncompatible)?;
        if value.get("formatVersion").and_then(Value::as_u64) != Some(FORMAT_VERSION)
            || value.get("result").and_then(|v| v.get("indexId")).and_then(Value::as_str) != Some(id)
            || !matches!(value["result"]["status"].as_str(), Some("ok" | "partial"))
        {
            return Err(ErrorCode::IndexIncompatible);
        }
        Ok(value)
    }

    pub fn publish(&self, id: &str, product: &Path) -> Result<(), ErrorCode> {
        let _lock = self.index_lock(id, true)?;
        let new_size = directory_size(product)?;
        let mut total = new_size;
        let mut indexes = 1;
        for entry in fs::read_dir(&self.root).map_err(|_| ErrorCode::RepositoryError)? {
            let entry = entry.map_err(|_| ErrorCode::RepositoryError)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue; };
            if !valid_index_id(name) || name == id { continue; }
            indexes += 1;
            if indexes > MAX_CACHE_INDEXES { return Err(ErrorCode::ResourceLimit); }
            total = total.checked_add(directory_size(&entry.path())?).ok_or(ErrorCode::ResourceLimit)?;
            if total > MAX_CACHE_BYTES { return Err(ErrorCode::ResourceLimit); }
        }
        if total > MAX_CACHE_BYTES { return Err(ErrorCode::ResourceLimit); }
        let destination = self.root.join(id);
        if destination.exists() {
            let old = CString::new(destination.as_os_str().as_bytes()).map_err(|_| ErrorCode::Internal)?;
            let new = CString::new(product.as_os_str().as_bytes()).map_err(|_| ErrorCode::Internal)?;
            let result = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, new.as_ptr(),
                libc::AT_FDCWD, old.as_ptr(), libc::RENAME_EXCHANGE) };
            if result != 0 { return Err(ErrorCode::RepositoryError); }
        } else {
            fs::rename(product, &destination).map_err(|_| ErrorCode::RepositoryError)?;
        }
        let _ = File::open(&self.root).and_then(|f| f.sync_all());
        Ok(())
    }
}

pub(super) fn lock_file(path: &Path) -> Result<File, ErrorCode> {
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)
        .map_err(|_| ErrorCode::RepositoryError)?;
    if !file.metadata().map_err(|_| ErrorCode::RepositoryError)?.is_file() {
        return Err(ErrorCode::RepositoryError);
    }
    Ok(file)
}

fn directory_size(path: &Path) -> Result<u64, ErrorCode> {
    let mut queue = vec![path.to_path_buf()];
    let mut bytes = 0_u64;
    let mut entries = 0;
    while let Some(path) = queue.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| ErrorCode::RepositoryError)?;
        entries += 1;
        if entries > 100000 || metadata.file_type().is_symlink() { return Err(ErrorCode::ResourceLimit); }
        bytes = bytes.checked_add(metadata.len().max(metadata.blocks().saturating_mul(512)))
            .ok_or(ErrorCode::ResourceLimit)?;
        if bytes > MAX_CACHE_BYTES { return Err(ErrorCode::ResourceLimit); }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|_| ErrorCode::RepositoryError)? {
                queue.push(entry.map_err(|_| ErrorCode::RepositoryError)?.path());
            }
        }
    }
    Ok(bytes)
}
