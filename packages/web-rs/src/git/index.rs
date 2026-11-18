use std::collections::BTreeSet;
use std::path::Path;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tantivy::collector::DocSetCollector;
use tantivy::query::{AllQuery, BooleanQuery, Occur, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, TantivyDocument, TextFieldIndexing,
    TextOptions, Value as _,
};
use tantivy::tokenizer::NgramTokenizer;
use tantivy::{Index, IndexWriter, Searcher, Term};

use super::bounded_directory::BoundedDirectory;
use super::params::{limit, valid_index_id, valid_text, MAX_FILE_BYTES};
use crate::protocol::ErrorCode;

const TRIGRAM_TOKENIZER: &str = "trigram";
const TRIGRAM_GRAM: usize = 3;
const SNIPPET_BYTES: usize = 512;
const WRITER_MEMORY_BYTES: usize = 15_000_000;
const MATCHER_SIZE_LIMIT: usize = 10 * 1024 * 1024;
const MATCHER_NEST_LIMIT: u32 = 100;

pub(super) struct IndexedFile {
    pub path: String,
    pub revision: Option<String>,
    pub content: String,
}

struct Fields {
    path: Field,
    revision: Field,
    content: Field,
}

pub(super) fn build_index(
    dir: &Path,
    files: &[IndexedFile],
    max_index_bytes: u64,
) -> Result<(), ErrorCode> {
    if max_index_bytes == 0 {
        return Err(ErrorCode::ResourceLimit);
    }
    let directory = BoundedDirectory::open(dir, max_index_bytes)?;
    let guard = directory.clone();
    let (schema, fields) = build_schema();
    let index = Index::open_or_create(directory, schema)
        .map_err(|_| storage_error(&guard))?;
    index.tokenizers().register(
        TRIGRAM_TOKENIZER,
        NgramTokenizer::new(TRIGRAM_GRAM, TRIGRAM_GRAM, false)
            .map_err(|_| ErrorCode::RepositoryError)?,
    );
    let mut writer: IndexWriter =
        index
            .writer_with_num_threads(1, WRITER_MEMORY_BYTES)
            .map_err(|_| ErrorCode::ResourceLimit)?;
    writer
        .delete_all_documents()
        .map_err(|_| storage_error(&guard))?;
    for file in files {
        let mut document = TantivyDocument::new();
        document.add_text(fields.path, &file.path);
        if let Some(revision) = &file.revision {
            document.add_text(fields.revision, revision);
        }
        document.add_text(fields.content, &file.content);
        writer
            .add_document(document)
            .map_err(|_| storage_error(&guard))?;
    }
    writer.commit().map_err(|_| storage_error(&guard))?;
    writer
        .wait_merging_threads()
        .map_err(|_| storage_error(&guard))?;
    if guard.exceeded() {
        return Err(ErrorCode::ResourceLimit);
    }
    Ok(())
}

pub(super) fn search_index(
    dir: &Path,
    params: Value,
    partial: bool,
) -> Result<Value, ErrorCode> {
    let params = SearchParams::parse(params)?;
    let index = open_index(dir)?;
    let fields = fields(&index.schema())?;
    let reader = index.reader().map_err(|_| ErrorCode::IndexIncompatible)?;
    let searcher = reader.searcher();

    let mut matcher_builder = RegexMatcherBuilder::new();
    matcher_builder
        .case_insensitive(!params.case_sensitive)
        .fixed_strings(!params.regex)
        .multi_line(false)
        .dot_matches_new_line(false)
        .line_terminator(Some(b'\n'))
        .size_limit(MATCHER_SIZE_LIMIT)
        .dfa_size_limit(MATCHER_SIZE_LIMIT)
        .nest_limit(MATCHER_NEST_LIMIT);
    let matcher = matcher_builder
        .build(&params.query)
        .map_err(|_| ErrorCode::InvalidParams)?;

    let query = if !params.regex && params.case_sensitive && params.query.chars().count() >= 3 {
        trigram_query(&fields, &params.query)
    } else {
        Box::new(AllQuery) as Box<dyn Query>
    };

    let hits = searcher
        .search(query.as_ref(), &DocSetCollector)
        .map_err(|_| ErrorCode::IndexIncompatible)?;
    let mut documents = Vec::with_capacity(hits.len());
    for address in hits {
        let document: TantivyDocument = searcher
            .doc(address)
            .map_err(|_| ErrorCode::IndexIncompatible)?;
        let path = text(&document, fields.path)?;
        if params
            .path_prefix
            .as_ref()
            .is_some_and(|prefix| !path.starts_with(prefix.as_str()))
        {
            continue;
        }
        let revision = document
            .get_first(fields.revision)
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        documents.push((path, revision, address));
    }
    documents.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });

    let needed = params.max_results + 1;
    let mut found = Vec::new();
    'documents: for (path, revision, address) in documents {
        let document: TantivyDocument = searcher
            .doc(address)
            .map_err(|_| ErrorCode::IndexIncompatible)?;
        let content = text(&document, fields.content)?;
        for (line_number, line) in content.split_inclusive('\n').enumerate() {
            let line = line.strip_suffix('\n').unwrap_or(line);
            let line = line.strip_suffix('\r').unwrap_or(line);
            let Some(hit) = matcher.find(line.as_bytes()).map_err(|_| ErrorCode::InvalidParams)? else {
                continue;
            };
            found.push(SearchItem {
                path: path.clone(),
                revision: revision.clone(),
                line: line_number + 1,
                column: hit.start() + 1,
                snippet: snippet(line, hit.start(), hit.end()),
            });
            if found.len() >= needed { break 'documents; }
        }
    }

    found.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.revision.cmp(&right.revision))
            .then_with(|| left.line.cmp(&right.line))
            .then_with(|| left.column.cmp(&right.column))
    });
    let truncated = found.len() > params.max_results;
    found.truncate(params.max_results);
    let status = if found.is_empty() { "empty" } else { "ok" };
    let mut result = SearchOutput {
        index_id: params.index_id,
        query: params.query,
        status,
        results: found,
        partial,
        truncated,
    };
    loop {
        let encoded = serde_json::to_vec(&result).map_err(|_| ErrorCode::Internal)?;
        if encoded.len() <= params.max_output_bytes {
            return serde_json::to_value(result).map_err(|_| ErrorCode::Internal);
        }
        if result.results.len() <= 1 {
            return Err(ErrorCode::OutputLimit);
        }
        result.results.pop();
        result.truncated = true;
        result.status = if result.results.is_empty() { "empty" } else { "ok" };
    }
}

pub(super) fn read_index(
    dir: &Path,
    params: Value,
    default_revision: Option<&str>,
) -> Result<Value, ErrorCode> {
    let params = ReadParams::parse(params)?;
    let index = open_index(dir)?;
    let fields = fields(&index.schema())?;
    let reader = index.reader().map_err(|_| ErrorCode::IndexIncompatible)?;
    let searcher = reader.searcher();

    let selected = find_document(
        &searcher,
        &fields,
        &params.path,
        params.revision.as_deref(),
        default_revision,
    )?;
    let Some((document, revision)) = selected else {
        return read_output(
            ReadOutput {
                index_id: params.index_id,
                path: params.path,
                revision: params.revision,
                status: "not_found",
                start_line: params.start_line,
                start_column: params.start_column,
                end_line: 0,
                total_lines: 0,
                content: String::new(),
                truncated: false,
                next: None,
            },
            params.max_output_bytes,
        );
    };

    let content = text(&document, fields.content)?;
    let lines = content_lines(&content);
    let total_lines = lines.len();
    let start = params.start_line;
    let end = (start - 1 + params.max_lines).min(total_lines);
    let selected = if let Some(first) = lines.get(start - 1) {
        let offset = params.start_column - 1;
        if offset >= first.len() || !first.is_char_boundary(offset) {
            return Err(ErrorCode::InvalidParams);
        }
        std::iter::once(&first[offset..])
            .chain(lines[start..end].iter().copied())
            .collect::<String>()
    } else if params.start_column == 1 {
        String::new()
    } else {
        return Err(ErrorCode::InvalidParams);
    };
    let next = (end < total_lines).then_some(ReadPosition {
        line: end + 1,
        column: 1,
    });
    let result = ReadOutput {
        index_id: params.index_id,
        path: params.path,
        revision,
        status: "ok",
        start_line: start,
        start_column: params.start_column,
        end_line: if selected.is_empty() { 0 } else { end },
        total_lines,
        content: selected,
        truncated: next.is_some(),
        next,
    };
    read_output(result, params.max_output_bytes)
}

fn read_output(mut page: ReadOutput, max_output_bytes: usize) -> Result<Value, ErrorCode> {
    let encoded_len = serde_json::to_vec(&page)
        .map_err(|_| ErrorCode::Internal)?
        .len();
    if encoded_len <= max_output_bytes {
        return serde_json::to_value(page).map_err(|_| ErrorCode::Internal);
    }
    if page.content.is_empty() {
        return Err(ErrorCode::OutputLimit);
    }
    page.truncated = true;
    page.next = Some(ReadPosition {
        line: page.total_lines,
        column: page.start_column + page.content.len(),
    });
    let start_line = page.start_line;
    let start_column = page.start_column;
    let Value::Object(mut result) = serde_json::to_value(page).map_err(|_| ErrorCode::Internal)?
    else {
        return Err(ErrorCode::Internal);
    };
    crate::http_response::enforce_output_limit(&mut result, "content", max_output_bytes)?;
    let content = result["content"].as_str().ok_or(ErrorCode::Internal)?;
    if content.is_empty() {
        return Err(ErrorCode::OutputLimit);
    }
    let next_line = start_line + content.bytes().filter(|byte| *byte == b'\n').count();
    let next_column = content
        .rsplit_once('\n')
        .map_or(start_column + content.len(), |(_, tail)| tail.len() + 1);
    let end_line = next_line - usize::from(content.ends_with('\n'));
    result.insert("endLine".into(), Value::from(end_line));
    result.insert(
        "next".into(),
        serde_json::to_value(ReadPosition {
            line: next_line,
            column: next_column,
        })
        .map_err(|_| ErrorCode::Internal)?,
    );
    Ok(Value::Object(result))
}

fn storage_error(directory: &BoundedDirectory) -> ErrorCode {
    if directory.exceeded() {
        ErrorCode::ResourceLimit
    } else {
        ErrorCode::RepositoryError
    }
}

fn build_schema() -> (Schema, Fields) {
    let mut builder = SchemaBuilder::new();
    let path = builder.add_text_field("path", tantivy::schema::STRING | tantivy::schema::STORED);
    let revision =
        builder.add_text_field("revision", tantivy::schema::STRING | tantivy::schema::STORED);
    let content = builder.add_text_field(
        "content",
        TextOptions::default()
            .set_stored()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer(TRIGRAM_TOKENIZER)
                    .set_index_option(IndexRecordOption::Basic)
                    .set_fieldnorms(false),
            ),
    );
    (
        builder.build(),
        Fields {
            path,
            revision,
            content,
        },
    )
}

fn fields(schema: &Schema) -> Result<Fields, ErrorCode> {
    Ok(Fields {
        path: schema
            .get_field("path")
            .map_err(|_| ErrorCode::IndexIncompatible)?,
        revision: schema
            .get_field("revision")
            .map_err(|_| ErrorCode::IndexIncompatible)?,
        content: schema
            .get_field("content")
            .map_err(|_| ErrorCode::IndexIncompatible)?,
    })
}

fn open_index(dir: &Path) -> Result<Index, ErrorCode> {
    if !dir.is_dir() {
        return Err(ErrorCode::IndexNotFound);
    }
    let index = Index::open_in_dir(dir).map_err(|_| ErrorCode::IndexIncompatible)?;
    if index.schema() != build_schema().0 { return Err(ErrorCode::IndexIncompatible); }
    Ok(index)
}

fn trigram_query(fields: &Fields, query: &str) -> Box<dyn Query> {
    let characters: Vec<char> = query.chars().collect();
    let mut grams = BTreeSet::new();
    for window in characters.windows(TRIGRAM_GRAM) {
        grams.insert(window.iter().collect::<String>());
    }
    if grams.is_empty() {
        return Box::new(AllQuery);
    }
    let clauses = grams
        .into_iter()
        .map(|gram| {
            let term = Term::from_field_text(fields.content, &gram);
            (
                Occur::Must,
                Box::new(TermQuery::new(term, IndexRecordOption::Basic)) as Box<dyn Query>,
            )
        })
        .collect();
    Box::new(BooleanQuery::new(clauses))
}

fn find_document(
    searcher: &Searcher,
    fields: &Fields,
    path: &str,
    revision: Option<&str>,
    default_revision: Option<&str>,
) -> Result<Option<(TantivyDocument, Option<String>)>, ErrorCode> {
    let path_term = Term::from_field_text(fields.path, path);
    let path_query = Box::new(TermQuery::new(path_term, IndexRecordOption::Basic)) as Box<dyn Query>;
    let query: Box<dyn Query> = match revision {
        Some(revision) => Box::new(BooleanQuery::new(vec![
            (Occur::Must, path_query),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(fields.revision, revision),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>,
            ),
        ])),
        None => path_query,
    };
    let hits = searcher
        .search(query.as_ref(), &DocSetCollector)
        .map_err(|_| ErrorCode::IndexIncompatible)?;
    let mut candidates = Vec::with_capacity(hits.len());
    for address in hits {
        let document: TantivyDocument = searcher
            .doc(address)
            .map_err(|_| ErrorCode::IndexIncompatible)?;
        let revision = document
            .get_first(fields.revision)
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        candidates.push((revision, address));
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    let chosen = if revision.is_some() {
        candidates.first()
    } else {
        default_revision
            .and_then(|wanted| {
                candidates
                    .iter()
                    .find(|(candidate, _)| candidate.as_deref() == Some(wanted))
            })
            .or_else(|| candidates.iter().find(|(candidate, _)| candidate.is_none()))
    };
    let Some(entry) = chosen else {
        return Ok(None);
    };
    let revision = entry.0.clone();
    let document: TantivyDocument = searcher
        .doc(entry.1)
        .map_err(|_| ErrorCode::IndexIncompatible)?;
    Ok(Some((document, revision)))
}

fn text(document: &TantivyDocument, field: Field) -> Result<String, ErrorCode> {
    document
        .get_first(field)
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or(ErrorCode::IndexIncompatible)
}

fn content_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    content.split_inclusive('\n').collect()
}

fn snippet(content: &str, start: usize, end: usize) -> String {
    let start = floor_boundary(content, start);
    let end = end.min(content.len());
    let length = end - start;
    if length >= SNIPPET_BYTES {
        let end = floor_boundary(content, start + SNIPPET_BYTES);
        return content[start..end].to_string();
    }
    let mut low = floor_boundary(content, start.saturating_sub((SNIPPET_BYTES - length) / 2));
    let mut high = floor_boundary(content, (low + SNIPPET_BYTES).min(content.len()));
    if high < end {
        high = end;
        low = floor_boundary(content, high.saturating_sub(SNIPPET_BYTES));
    }
    content[low..high].to_string()
}

fn floor_boundary(content: &str, mut offset: usize) -> usize {
    offset = offset.min(content.len());
    while offset > 0 && !content.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchItem {
    path: String,
    revision: Option<String>,
    line: usize,
    column: usize,
    snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchOutput {
    index_id: String,
    query: String,
    status: &'static str,
    results: Vec<SearchItem>,
    partial: bool,
    truncated: bool,
}

#[derive(Serialize)]
struct ReadPosition {
    line: usize,
    column: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadOutput {
    index_id: String,
    path: String,
    revision: Option<String>,
    status: &'static str,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    total_lines: usize,
    content: String,
    truncated: bool,
    next: Option<ReadPosition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchInput {
    index_id: String,
    query: String,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
    path: Option<String>,
    max_results: Option<u64>,
    max_output_bytes: Option<u64>,
}

struct SearchParams {
    index_id: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    path_prefix: Option<String>,
    max_results: usize,
    max_output_bytes: usize,
}

impl SearchParams {
    fn parse(value: Value) -> Result<Self, ErrorCode> {
        let input: SearchInput =
            serde_json::from_value(value).map_err(|_| ErrorCode::InvalidParams)?;
        if !valid_index_id(&input.index_id) || !valid_text(&input.query, 512) {
            return Err(ErrorCode::InvalidParams);
        }
        let path_prefix = match &input.path {
            Some(path) => {
                if !valid_text(path, 1024) {
                    return Err(ErrorCode::InvalidParams);
                }
                Some(path.clone())
            }
            None => None,
        };
        Ok(Self {
            index_id: input.index_id,
            query: input.query,
            regex: input.regex.unwrap_or(false),
            case_sensitive: input.case_sensitive.unwrap_or(true),
            path_prefix,
            max_results: limit(input.max_results, 10, 1, 50)? as usize,
            max_output_bytes: limit(input.max_output_bytes, 8192, 1024, 49152)? as usize,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    index_id: String,
    path: String,
    revision: Option<String>,
    start_line: Option<u64>,
    start_column: Option<u64>,
    max_lines: Option<u64>,
    max_output_bytes: Option<u64>,
}

struct ReadParams {
    index_id: String,
    path: String,
    revision: Option<String>,
    start_line: usize,
    start_column: usize,
    max_lines: usize,
    max_output_bytes: usize,
}

impl ReadParams {
    fn parse(value: Value) -> Result<Self, ErrorCode> {
        let input: ReadInput =
            serde_json::from_value(value).map_err(|_| ErrorCode::InvalidParams)?;
        if !valid_index_id(&input.index_id) || !valid_text(&input.path, 1024) {
            return Err(ErrorCode::InvalidParams);
        }
        if let Some(revision) = &input.revision {
            if !(revision.len() == 40 || revision.len() == 64)
                || !revision
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ErrorCode::InvalidParams);
            }
        }
        Ok(Self {
            index_id: input.index_id,
            path: input.path,
            revision: input.revision,
            start_line: limit(input.start_line, 1, 1, 10_000_000)? as usize,
            start_column: limit(input.start_column, 1, 1, MAX_FILE_BYTES)? as usize,
            max_lines: limit(input.max_lines, 200, 1, 1000)? as usize,
            max_output_bytes: limit(input.max_output_bytes, 8192, 1024, 49152)? as usize,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pi-web-index-{name}-{}-{nanos}", std::process::id()))
    }

    fn index_id() -> String {
        "0".repeat(64)
    }

    fn file(path: &str, revision: Option<&str>, content: &str) -> IndexedFile {
        IndexedFile {
            path: path.to_string(),
            revision: revision.map(str::to_owned),
            content: content.to_string(),
        }
    }

    fn build(path: &Path, files: &[IndexedFile]) {
        build_index(path, files, 64 * 1024 * 1024).unwrap();
    }

    fn search(path: &Path, value: Value) -> Value {
        search_index(path, value, false).unwrap()
    }

    #[test]
    fn finds_case_sensitive_literal_matches_with_trigram_candidates() {
        let path = temp_dir("literal");
        build(
            &path,
            &[
                file("src/main.rs", None, "fn main() {\n    alpha();\n}\n"),
                file("README.md", None, "Alpha is unrelated\n"),
            ],
        );
        let result = search(
            &path,
            json!({"indexId": index_id(), "query": "alpha"}),
        );
        assert_eq!(result["status"], "ok");
        assert_eq!(result["truncated"], false);
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["path"], "src/main.rs");
        assert_eq!(results[0]["revision"], Value::Null);
        assert_eq!(results[0]["line"], 2);
        assert_eq!(results[0]["column"], 5);
        assert!(results[0]["snippet"].as_str().unwrap().contains("alpha"));
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn scans_case_insensitive_and_regex_queries() {
        let path = temp_dir("scan");
        build(&path, &[file("a.txt", None, "Alpha\nbeta\ngamma\n")]);
        let insensitive = search(
            &path,
            json!({"indexId": index_id(), "query": "alpha", "caseSensitive": false}),
        );
        assert_eq!(insensitive["results"][0]["line"], 1);
        let regex = search(
            &path,
            json!({"indexId": index_id(), "query": "b.ta", "regex": true}),
        );
        assert_eq!(regex["results"][0]["line"], 2);
        assert_eq!(regex["results"][0]["column"], 1);
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn orders_and_filters_by_path_and_revision() {
        let path = temp_dir("order");
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        build(
            &path,
            &[
                file("z.txt", Some(b.as_str()), "needle\n"),
                file("z.txt", Some(a.as_str()), "needle\n"),
                file("a.txt", None, "needle\ntext\nneedle\n"),
            ],
        );
        let result = search(
            &path,
            json!({"indexId": index_id(), "query": "needle", "maxResults": 2}),
        );
        let results = result["results"].as_array().unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["path"], "a.txt");
        assert_eq!(results[1]["line"], 3);
        let filtered = search(
            &path,
            json!({"indexId": index_id(), "query": "needle", "path": "z.txt"}),
        );
        let results = filtered["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["revision"].as_str(), Some(a.as_str()));
        assert_eq!(results[1]["revision"].as_str(), Some(b.as_str()));
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn reads_paged_snapshot_lines() {
        let path = temp_dir("read");
        build(
            &path,
            &[file("src/lib.rs", None, "alpha\nbeta\ngamma\n")],
        );
        let result = read_index(
            &path,
            json!({"indexId": index_id(), "path": "src/lib.rs", "maxLines": 2}),
            None,
        )
        .unwrap();
        assert_eq!(result["status"], "ok");
        assert_eq!(result["startLine"], 1);
        assert_eq!(result["endLine"], 2);
        assert_eq!(result["totalLines"], 3);
        assert_eq!(result["content"], "alpha\nbeta\n");
        assert_eq!(result["truncated"], true);
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn reads_a_selected_history_revision() {
        let path = temp_dir("revision");
        let old = "a".repeat(40);
        let new = "b".repeat(40);
        build(
            &path,
            &[
                file("f.txt", Some(old.as_str()), "old text\n"),
                file("f.txt", Some(new.as_str()), "new text\n"),
            ],
        );
        let result = read_index(
            &path,
            json!({"indexId": index_id(), "path": "f.txt", "revision": new.clone()}),
            None,
        )
        .unwrap();
        assert_eq!(result["revision"].as_str(), Some(new.as_str()));
        assert_eq!(result["content"], "new text\n");
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn reports_missing_files_and_bad_parameters() {
        let path = temp_dir("missing");
        build(&path, &[file("a.txt", None, "text\n")]);
        let result = read_index(
            &path,
            json!({"indexId": index_id(), "path": "missing.txt"}),
            None,
        )
        .unwrap();
        assert_eq!(result["status"], "not_found");
        assert_eq!(result["totalLines"], 0);
        assert_eq!(result["endLine"], 0);
        assert_eq!(result["content"], "");
        assert!(matches!(
            search_index(
                &path,
                json!({"indexId": index_id(), "query": "[" , "regex": true}),
                false
            ),
            Err(ErrorCode::InvalidParams)
        ));
        assert!(matches!(
            search_index(&temp_dir("absent"), json!({"indexId": index_id(), "query": "x"}), false),
            Err(ErrorCode::IndexNotFound)
        ));
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn rejects_output_that_cannot_hold_one_item() {
        let path = temp_dir("budget");
        let long_path = "a".repeat(1000);
        let query = "b".repeat(500);
        build(&path, &[file(&long_path, None, &query)]);
        assert!(matches!(
            search_index(
                &path,
                json!({"indexId": index_id(), "query": query, "maxOutputBytes": 1024}),
                false
            ),
            Err(ErrorCode::OutputLimit)
        ));
        let _ = std::fs::remove_dir_all(&path);
    }
}
