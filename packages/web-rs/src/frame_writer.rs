use serde::Serialize;
use std::io;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::protocol::MAX_FRAME_BYTES;

pub struct FrameWriter<W> {
    inner: Mutex<W>,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(inner: W) -> Self {
        FrameWriter {
            inner: Mutex::new(inner),
        }
    }

    pub async fn send<T: Serialize>(&self, frame: &T) -> io::Result<()> {
        let mut line = serde_json::to_vec(frame)?;
        if line.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Response frame exceeds protocol limit",
            ));
        }
        line.push(b'\n');
        let mut inner = self.inner.lock().await;
        inner.write_all(&line).await?;
        inner.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_FRAME_BYTES;

    #[tokio::test]
    async fn rejects_an_oversized_response() {
        let writer = FrameWriter::new(tokio::io::sink());
        let error = writer.send(&"x".repeat(MAX_FRAME_BYTES)).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
