use std::any::Any;
use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gix::protocol::transport::client::blocking_io::http::{
    self, GetResponse, Http, PostBodyDataKind, PostResponse, Transport as HttpTransport,
    options::FollowRedirects, reqwest as http_reqwest,
};
use gix::protocol::transport::Protocol;
use gix::url::{Scheme, Url};
use gix::utils::io::pipe;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransportError {
    Network,
    Limit,
    Auth,
    Git,
}

pub(crate) fn clone_repository(
    url: &str,
    destination: &Path,
    max_download_bytes: u64,
) -> Result<u64, TransportError> {
    let parsed = parse_https_url(url)?;
    let budget = Arc::new(Budget::new(max_download_bytes));
    let failure = Arc::new(Failure::default());
    let options = transport_options();
    let prepare = gix::clone::PrepareFetch::new(
        url,
        destination,
        gix::create::Kind::Bare,
        gix::create::Options::default(),
        gix::open::Options::isolated(),
    )
    .map_err(|_| TransportError::Git)?;
    let clone_url = parsed;
    let clone_budget = Arc::clone(&budget);
    let clone_failure = Arc::clone(&failure);
    let mut prepare = prepare.configure_connection(move |connection| {
        connection.set_credentials(|_| Ok(None));
        connection.set_transport_options(Box::new(options.clone()));
        let backend = Backend {
            inner: http_reqwest::Remote::default(),
            budget: Arc::clone(&clone_budget),
            failure: Arc::clone(&clone_failure),
        };
        let transport = HttpTransport::new_http(backend, clone_url.clone(), Protocol::V1, false);
        *connection.transport_mut() = Box::new(transport);
        Ok(())
    });
    let interrupt = AtomicBool::new(false);
    let (repository, _) = prepare
        .fetch_only(gix::progress::Discard, &interrupt)
        .map_err(|err| classify(err, &budget, &failure))?;
    drop(repository);
    Ok(budget.consumed())
}

fn parse_https_url(value: &str) -> Result<Url, TransportError> {
    let url = gix::url::parse(value).map_err(|_| TransportError::Git)?;
    let components = url.path_query_fragment();
    if url.scheme != Scheme::Https
        || url.user.is_some()
        || url.password.is_some()
        || url.host.is_none()
        || components.query.is_some()
        || components.fragment.is_some()
    {
        return Err(TransportError::Git);
    }
    Ok(url)
}

fn classify(err: gix::Error, budget: &Budget, failure: &Failure) -> TransportError {
    if budget.hit() {
        return TransportError::Limit;
    }
    if failure.auth() {
        return TransportError::Auth;
    }
    if failure.network() {
        return TransportError::Network;
    }
    if err.classify().is_unauthenticated() || err.classify().is_permission_denied() {
        return TransportError::Auth;
    }
    TransportError::Git
}

fn transport_options() -> http::Options {
    let configure_client: Box<http_reqwest::ConfigureClientFn> = Box::new(
        |builder: reqwest::blocking::ClientBuilder| -> gix::Result<reqwest::blocking::ClientBuilder> {
            Ok(builder
                .no_proxy()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .redirect(reqwest::redirect::Policy::none()))
        },
    );
    let backend = http_reqwest::Options {
        configure_client: Some(configure_client),
        configure_request: None,
    };
    let backend = Arc::new(Mutex::new(backend)) as Arc<Mutex<dyn Any + Send + Sync + 'static>>;
    let mut options = http::Options::default();
    options.follow_redirects = FollowRedirects::None;
    options.backend = Some(backend);
    options
}

struct Backend {
    inner: http_reqwest::Remote,
    budget: Arc<Budget>,
    failure: Arc<Failure>,
}

impl Http for Backend {
    type Headers = CountedHeaders<pipe::Reader>;
    type ResponseBody = CountedBody<pipe::Reader>;
    type PostBody = UploadBody;

    fn get(
        &mut self,
        url: &str,
        base_url: &str,
        headers: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> gix::Result<GetResponse<Self::Headers, Self::ResponseBody>> {
        let response = match self.inner.get(url, base_url, headers) {
            Ok(response) => response,
            Err(err) => {
                self.failure.mark_network();
                return Err(err);
            }
        };
        Ok(GetResponse {
            headers: CountedHeaders {
                inner: response.headers,
                failure: Arc::clone(&self.failure),
            },
            body: CountedBody {
                inner: response.body,
                budget: Arc::clone(&self.budget),
                failure: Arc::clone(&self.failure),
                charged: 0,
                remaining: 1_048_576,
            },
        })
    }

    fn post(
        &mut self,
        url: &str,
        base_url: &str,
        headers: impl IntoIterator<Item = impl AsRef<str>>,
        body: PostBodyDataKind,
    ) -> gix::Result<PostResponse<Self::Headers, Self::ResponseBody, Self::PostBody>> {
        let response = match self.inner.post(url, base_url, headers, body) {
            Ok(response) => response,
            Err(err) => {
                self.failure.mark_network();
                return Err(err);
            }
        };
        Ok(PostResponse {
            post_body: UploadBody {
                inner: response.post_body,
                failure: Arc::clone(&self.failure),
            },
            headers: CountedHeaders {
                inner: response.headers,
                failure: Arc::clone(&self.failure),
            },
            body: CountedBody {
                inner: response.body,
                budget: Arc::clone(&self.budget),
                failure: Arc::clone(&self.failure),
                charged: 0,
                remaining: self.budget.limit,
            },
        })
    }

    fn configure(&mut self, config: &dyn Any) -> gix::Result {
        self.inner.configure(config)
    }
}

struct Budget {
    limit: u64,
    consumed: AtomicU64,
    limit_hit: AtomicBool,
}

impl Budget {
    fn new(limit: u64) -> Self {
        Budget {
            limit,
            consumed: AtomicU64::new(0),
            limit_hit: AtomicBool::new(false),
        }
    }

    fn charge(&self, amount: u64) -> bool {
        let accepted = self.consumed.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
            used.checked_add(amount).filter(|next| *next <= self.limit)
        }).is_ok();
        if !accepted { self.mark_hit(); }
        accepted
    }

    fn consumed(&self) -> u64 {
        self.consumed.load(Ordering::Relaxed)
    }

    fn hit(&self) -> bool {
        self.limit_hit.load(Ordering::Relaxed)
    }

    fn mark_hit(&self) {
        self.limit_hit.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Failure {
    auth: AtomicBool,
    network: AtomicBool,
}

impl Failure {
    fn record(&self, err: &io::Error) {
        if err.kind() == io::ErrorKind::PermissionDenied {
            self.auth.store(true, Ordering::Relaxed);
        } else {
            self.mark_network();
        }
    }

    fn auth(&self) -> bool {
        self.auth.load(Ordering::Relaxed)
    }

    fn mark_network(&self) {
        self.network.store(true, Ordering::Relaxed);
    }

    fn network(&self) -> bool {
        self.network.load(Ordering::Relaxed)
    }
}

struct CountedHeaders<B> {
    inner: B,
    failure: Arc<Failure>,
}

impl<B: BufRead> Read for CountedHeaders<B> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.inner.read(buf) {
            Ok(read) => Ok(read),
            Err(err) => {
                self.failure.record(&err);
                Err(err)
            }
        }
    }
}

impl<B: BufRead> BufRead for CountedHeaders<B> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        match self.inner.fill_buf() {
            Ok(buf) => Ok(buf),
            Err(err) => {
                self.failure.record(&err);
                Err(err)
            }
        }
    }

    fn consume(&mut self, amount: usize) {
        self.inner.consume(amount);
    }
}

struct UploadBody {
    inner: pipe::Writer,
    failure: Arc<Failure>,
}

impl Write for UploadBody {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.inner.write(buf) {
            Ok(written) => Ok(written),
            Err(err) => {
                self.failure.record(&err);
                Err(err)
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct CountedBody<B> {
    inner: B,
    budget: Arc<Budget>,
    failure: Arc<Failure>,
    charged: usize,
    remaining: u64,
}

impl<B: BufRead> Read for CountedBody<B> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() { return Ok(0); }
        let read = {
            let available = self.fill_buf()?;
            let read = available.len().min(buf.len());
            buf[..read].copy_from_slice(&available[..read]);
            read
        };
        self.consume(read);
        Ok(read)
    }
}

impl<B: BufRead> BufRead for CountedBody<B> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        let buf = match self.inner.fill_buf() {
            Ok(buf) => buf,
            Err(err) => {
                self.failure.record(&err);
                return Err(err);
            }
        };
        if buf.is_empty() {
            return Ok(buf);
        }
        let extra = buf.len().saturating_sub(self.charged) as u64;
        if extra > self.remaining || !self.budget.charge(extra) {
            self.budget.mark_hit();
            return Err(io::Error::other("Git download limit exceeded"));
        }
        self.remaining -= extra;
        self.charged = buf.len();
        Ok(buf)
    }

    fn consume(&mut self, amount: usize) {
        self.inner.consume(amount);
        self.charged = self.charged.saturating_sub(amount);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn accepts_only_anonymous_https_urls() {
        assert!(parse_https_url("https://example.com/owner/repo.git").is_ok());
        for value in [
            "",
            "http://example.com/owner/repo.git",
            "ssh://git@example.com/owner/repo.git",
            "file:///tmp/repo.git",
            "https://user@example.com/owner/repo.git",
            "https://user:secret@example.com/owner/repo.git",
            "https://example.com/owner/repo.git?ref=main",
            "https://example.com/owner/repo.git#main",
        ] {
            assert_eq!(parse_https_url(value), Err(TransportError::Git), "{value}");
        }
    }

    #[test]
    fn stops_response_bodies_at_the_limit() {
        let budget = Arc::new(Budget::new(8));
        let failure = Arc::new(Failure::default());
        let mut body = CountedBody {
            inner: Cursor::new(b"0123456789".to_vec()),
            budget: Arc::clone(&budget),
            failure,
            charged: 0,
            remaining: 8,
        };
        let mut out = [0u8; 4];
        assert_eq!(body.read(&mut out).unwrap_err().kind(), io::ErrorKind::Other);
        assert!(budget.hit());
        assert_eq!(budget.consumed(), 0);
    }

    #[test]
    fn accepts_response_bodies_at_the_limit() {
        let budget = Arc::new(Budget::new(8));
        let failure = Arc::new(Failure::default());
        let mut body = CountedBody {
            inner: Cursor::new(b"01234567".to_vec()),
            budget: Arc::clone(&budget),
            failure,
            charged: 0,
            remaining: 8,
        };
        let mut out = [0u8; 8];
        assert_eq!(body.read(&mut out).unwrap(), 8);
        assert_eq!(body.read(&mut out).unwrap(), 0);
        assert!(!budget.hit());
        assert_eq!(budget.consumed(), 8);
    }

    #[test]
    fn records_authentication_failures() {
        let failure = Failure::default();
        failure.record(&io::Error::new(io::ErrorKind::PermissionDenied, "401"));
        assert!(failure.auth());
        assert!(!failure.network());
        let failure = Failure::default();
        failure.record(&io::Error::new(io::ErrorKind::ConnectionReset, "reset"));
        assert!(!failure.auth());
        assert!(failure.network());
    }
}
