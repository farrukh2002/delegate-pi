use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tantivy::directory::error::{DeleteError, LockError, OpenReadError, OpenWriteError};
use tantivy::directory::{
    AntiCallToken, Directory, DirectoryLock, FileHandle, FileSlice, Lock, MmapDirectory,
    TerminatingWrite, WatchCallback, WatchHandle, WritePtr,
};

use crate::protocol::ErrorCode;

#[derive(Clone, Debug)]
pub(super) struct BoundedDirectory {
    inner: MmapDirectory,
    budget: Arc<WriteBudget>,
}

impl BoundedDirectory {
    pub(super) fn open(path: &Path, max_bytes: u64) -> Result<Self, ErrorCode> {
        std::fs::create_dir_all(path).map_err(|_| ErrorCode::RepositoryError)?;
        let inner = MmapDirectory::open(path).map_err(|_| ErrorCode::RepositoryError)?;
        Ok(Self {
            inner,
            budget: Arc::new(WriteBudget {
                limit: max_bytes,
                used: AtomicU64::new(0),
                exceeded: AtomicBool::new(false),
            }),
        })
    }

    pub(super) fn exceeded(&self) -> bool {
        self.budget.exceeded.load(Ordering::Relaxed)
    }
}

impl Directory for BoundedDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
        self.inner.get_file_handle(path)
    }

    fn delete(&self, path: &Path) -> Result<(), DeleteError> {
        self.inner.delete(path)
    }

    fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
        self.inner.exists(path)
    }

    fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
        let inner = self.inner.open_write(path)?;
        let writer = BoundedWriter {
            inner: Some(inner),
            budget: self.budget.clone(),
        };
        let writer: Box<dyn TerminatingWrite + Send + Sync> = Box::new(writer);
        Ok(BufWriter::new(writer))
    }

    fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
        self.inner.atomic_read(path)
    }

    fn atomic_write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        self.budget.reserve(data.len() as u64)?;
        self.inner.atomic_write(path, data)
    }

    fn sync_directory(&self) -> io::Result<()> {
        self.inner.sync_directory()
    }

    fn watch(&self, watch_callback: WatchCallback) -> Result<WatchHandle, tantivy::TantivyError> {
        self.inner.watch(watch_callback)
    }

    fn open_read(&self, path: &Path) -> Result<FileSlice, OpenReadError> {
        self.inner.open_read(path)
    }

    fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
        self.inner.acquire_lock(lock)
    }
}

struct BoundedWriter {
    inner: Option<WritePtr>,
    budget: Arc<WriteBudget>,
}

impl Write for BoundedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.budget.reserve(buffer.len() as u64)?;
        let inner = self.inner.as_mut().ok_or_else(closed)?;
        match inner.write(buffer) {
            Ok(written) => {
                if written < buffer.len() {
                    self.budget.release((buffer.len() - written) as u64);
                }
                Ok(written)
            }
            Err(error) => {
                self.budget.release(buffer.len() as u64);
                Err(error)
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.as_mut().ok_or_else(closed)?.flush()
    }
}

impl TerminatingWrite for BoundedWriter {
    fn terminate_ref(&mut self, token: AntiCallToken) -> io::Result<()> {
        let mut inner = self.inner.take().ok_or_else(closed)?;
        inner.flush()?;
        let mut terminated = inner.into_inner().map_err(|error| error.into_error())?;
        TerminatingWrite::terminate_ref(&mut *terminated, token)
    }
}

#[derive(Debug)]
struct WriteBudget {
    limit: u64,
    used: AtomicU64,
    exceeded: AtomicBool,
}

impl WriteBudget {
    fn reserve(&self, bytes: u64) -> io::Result<()> {
        let mut used = self.used.load(Ordering::Relaxed);
        loop {
            let next = match used.checked_add(bytes) {
                Some(next) if next <= self.limit => next,
                _ => {
                    self.exceeded.store(true, Ordering::Relaxed);
                    return Err(limit_error());
                }
            };
            match self
                .used
                .compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Relaxed)
            {
                Ok(_) => return Ok(()),
                Err(current) => used = current,
            }
        }
    }

    fn release(&self, bytes: u64) {
        self.used.fetch_sub(bytes, Ordering::AcqRel);
    }
}

fn closed() -> io::Error {
    io::Error::other("index writer was already terminated")
}

fn limit_error() -> io::Error {
    io::Error::other("index write budget exceeded")
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pi-web-bounded-{name}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn enforces_cumulative_atomic_write_budget() {
        let path = temp_dir("atomic");
        let directory = BoundedDirectory::open(&path, 20).unwrap();
        directory
            .atomic_write(Path::new("a"), b"0123456789")
            .unwrap();
        directory
            .atomic_write(Path::new("b"), b"0123456789")
            .unwrap();
        assert!(!directory.exceeded());
        assert!(directory.atomic_write(Path::new("c"), b"x").is_err());
        assert!(directory.exceeded());
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn enforces_stream_write_budget() {
        let path = temp_dir("stream");
        let directory = BoundedDirectory::open(&path, 8).unwrap();
        let mut writer = directory.open_write(Path::new("a")).unwrap();
        let written = writer.write_all(b"0123456789");
        let terminated = written.and_then(|_| writer.terminate());
        assert!(terminated.is_err());
        assert!(directory.exceeded());
        let _ = std::fs::remove_dir_all(&path);
    }
}
