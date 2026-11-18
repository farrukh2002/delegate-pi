use tokio::io::{AsyncRead, AsyncReadExt};

use crate::protocol::MAX_FRAME_BYTES;

const READ_CHUNK_BYTES: usize = 8_192;

#[derive(Debug, PartialEq, Eq)]
pub enum LineRead {
    Frame(Vec<u8>),
    Oversized,
    Eof,
}

pub struct FrameReader<R> {
    inner: R,
    pending: Vec<u8>,
    chunk: [u8; READ_CHUNK_BYTES],
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        FrameReader {
            inner,
            pending: Vec::new(),
            chunk: [0; READ_CHUNK_BYTES],
        }
    }

    pub async fn next_frame(&mut self) -> LineRead {
        loop {
            if let Some(position) = self.pending.iter().position(|&byte| byte == b'\n') {
                if position > MAX_FRAME_BYTES {
                    return LineRead::Oversized;
                }
                let mut frame: Vec<u8> = self.pending.drain(..=position).collect();
                frame.pop();
                return LineRead::Frame(frame);
            }
            if self.pending.len() > MAX_FRAME_BYTES {
                return LineRead::Oversized;
            }
            match self.inner.read(&mut self.chunk).await {
                Ok(0) => return LineRead::Eof,
                Ok(read) => self.pending.extend_from_slice(&self.chunk[..read]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return LineRead::Eof,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    fn frame_of(length: usize) -> Vec<u8> {
        let mut bytes = vec![b'x'; length];
        bytes.push(b'\n');
        bytes
    }

    #[tokio::test]
    async fn reads_a_frame_at_the_size_limit() {
        let bytes = frame_of(MAX_FRAME_BYTES);
        let mut reader = FrameReader::new(bytes.as_slice());
        assert_eq!(
            reader.next_frame().await,
            LineRead::Frame(vec![b'x'; MAX_FRAME_BYTES])
        );
        assert_eq!(reader.next_frame().await, LineRead::Eof);
    }

    #[tokio::test]
    async fn rejects_a_terminated_frame_over_the_size_limit() {
        let bytes = frame_of(MAX_FRAME_BYTES + 1);
        let mut reader = FrameReader::new(bytes.as_slice());
        assert_eq!(reader.next_frame().await, LineRead::Oversized);
    }

    #[tokio::test]
    async fn rejects_an_unterminated_frame_over_the_size_limit() {
        let bytes = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut reader = FrameReader::new(bytes.as_slice());
        assert_eq!(reader.next_frame().await, LineRead::Oversized);
    }

    #[tokio::test]
    async fn reads_consecutive_frames_from_one_chunk() {
        let mut bytes = b"one\ntwo\n".to_vec();
        bytes.extend(frame_of(4));
        let mut reader = FrameReader::new(bytes.as_slice());
        assert_eq!(reader.next_frame().await, LineRead::Frame(b"one".to_vec()));
        assert_eq!(reader.next_frame().await, LineRead::Frame(b"two".to_vec()));
        assert_eq!(reader.next_frame().await, LineRead::Frame(b"xxxx".to_vec()));
        assert_eq!(reader.next_frame().await, LineRead::Eof);
    }

    #[tokio::test]
    async fn reads_empty_frames() {
        let mut reader = FrameReader::new(b"\n\n".as_slice());
        assert_eq!(reader.next_frame().await, LineRead::Frame(Vec::new()));
        assert_eq!(reader.next_frame().await, LineRead::Frame(Vec::new()));
        assert_eq!(reader.next_frame().await, LineRead::Eof);
    }

    #[tokio::test]
    async fn ignores_an_unterminated_tail_at_eof() {
        let mut reader = FrameReader::new(b"partial".as_slice());
        assert_eq!(reader.next_frame().await, LineRead::Eof);
    }

    #[tokio::test]
    async fn reads_frames_split_across_chunks() {
        let (mut sender, receiver) = duplex(1024);
        let mut reader = FrameReader::new(receiver);
        let writer = tokio::spawn(async move {
            for chunk in [b"{\"a\"".as_slice(), b":1}\n{\"b\"".as_slice(), b":2}\n"] {
                sender.write_all(chunk).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        assert_eq!(
            reader.next_frame().await,
            LineRead::Frame(b"{\"a\":1}".to_vec())
        );
        assert_eq!(
            reader.next_frame().await,
            LineRead::Frame(b"{\"b\":2}".to_vec())
        );
        writer.await.unwrap();
    }
}
