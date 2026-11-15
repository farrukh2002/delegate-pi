use image::codecs::jpeg::JpegEncoder;
use image::{imageops, DynamicImage, ImageEncoder, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};

const DEFAULT_MAX_WIDTH: u32 = 2000;
const DEFAULT_MAX_HEIGHT: u32 = 2000;
const DEFAULT_MAX_BYTES: usize = 4_718_592; // 4.5 MiB measured on the base64 payload
const DEFAULT_JPEG_QUALITY: u8 = 80;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    #[serde(default = "default_max_width")]
    max_width: u32,
    #[serde(default = "default_max_height")]
    max_height: u32,
    #[serde(default = "default_max_bytes")]
    max_bytes: usize,
    #[serde(default = "default_jpeg_quality")]
    jpeg_quality: u8,
    #[serde(default)]
    mime_type: String,
    bytes: usize,
}

fn default_max_width() -> u32 {
    DEFAULT_MAX_WIDTH
}
fn default_max_height() -> u32 {
    DEFAULT_MAX_HEIGHT
}
fn default_max_bytes() -> usize {
    DEFAULT_MAX_BYTES
}
fn default_jpeg_quality() -> u8 {
    DEFAULT_JPEG_QUALITY
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultPayload {
    mime_type: &'static str,
    original_width: u32,
    original_height: u32,
    width: u32,
    height: u32,
    was_resized: bool,
    bytes: usize,
}

struct Reply {
    ok: bool,
    error: Option<String>,
    result: Option<ResultPayload>,
    data: Vec<u8>,
}

impl Reply {
    fn failure(message: impl Into<String>) -> Reply {
        Reply {
            ok: false,
            error: Some(message.into()),
            result: None,
            data: Vec::new(),
        }
    }
}

#[derive(Serialize)]
struct ReplyJson<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a ResultPayload>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Png,
    Jpeg,
    WebP,
    Gif,
    Bmp,
}

struct Image {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl Image {
    fn from_buffer(buffer: RgbaImage) -> Image {
        Image {
            width: buffer.width(),
            height: buffer.height(),
            rgba: buffer.into_raw(),
        }
    }

    fn into_buffer(self) -> RgbaImage {
        RgbaImage::from_raw(self.width, self.height, self.rgba).expect("rgba buffer")
    }
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "resize".to_string());
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        std::process::exit(2);
    }
    let newline = input.iter().position(|&byte| byte == b'\n').unwrap_or(input.len());
    let header: Header = match serde_json::from_slice(&input[..newline]) {
        Ok(value) => value,
        Err(error) => {
            write(&Reply::failure(format!("bad request: {error}")));
            return;
        }
    };
    let payload_start = (newline + 1).min(input.len());
    input.drain(..payload_start);
    let payload = input;
    if header.bytes != 0 && payload.len() != header.bytes {
        write(&Reply::failure("payload length mismatch"));
        return;
    }
    let reply = match mode.as_str() {
        "transcode" => transcode(payload, &header),
        _ => process(payload, &header),
    };
    write(&reply);
}

fn write(reply: &Reply) {
    let json = ReplyJson {
        ok: reply.ok,
        error: reply.error.as_deref(),
        result: reply.result.as_ref(),
    };
    let mut stdout = std::io::BufWriter::new(std::io::stdout());
    let line = serde_json::to_vec(&json).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let _ = stdout.write_all(&line);
    let _ = stdout.write_all(b"\n");
    if reply.result.is_some() {
        let _ = stdout.write_all(&reply.data);
    }
    let _ = stdout.flush();
}

fn process(payload: Vec<u8>, header: &Header) -> Reply {
    let bytes: &[u8] = &payload;
    let format = match detect(bytes) {
        Some(format) => format,
        None => return Reply::failure("unsupported image format"),
    };
    let (stored_width, stored_height) = match dimensions(bytes, format) {
        Ok(value) => value,
        Err(error) => return Reply::failure(error),
    };
    let orientation = exif_orientation(bytes, format);
    let (original_width, original_height) = oriented_dims(stored_width, stored_height, orientation);
    let input_base64 = encoded_base64_len(bytes.len());

    if original_width <= header.max_width
        && original_height <= header.max_height
        && input_base64 < header.max_bytes
    {
        let mime = if header.mime_type.is_empty() {
            match format {
                Format::Png => "image/png",
                Format::Jpeg => "image/jpeg",
                Format::WebP => "image/webp",
                Format::Gif => "image/gif",
                Format::Bmp => "image/bmp",
            }
        } else {
            mime_of(&header.mime_type)
        };
        return Reply {
            ok: true,
            error: None,
            result: Some(ResultPayload {
                mime_type: mime,
                original_width,
                original_height,
                width: original_width,
                height: original_height,
                was_resized: false,
                bytes: bytes.len(),
            }),
            data: payload,
        };
    }

    let (target_width, target_height) =
        scaled_target(original_width, original_height, header.max_width, header.max_height);
    let (decode_width, decode_height) = if swaps_axes(orientation) {
        (target_height, target_width)
    } else {
        (target_width, target_height)
    };

    let decoded = decode_small(bytes, format, decode_width, decode_height);
    drop(payload);
    let mut image = match decoded {
        Ok(value) => value,
        Err(error) => return Reply::failure(error),
    };
    if orientation != 1 {
        image = apply_orientation(image, orientation);
    }

    let qualities = quality_steps(header.jpeg_quality);
    loop {
        if let Some((data, mime)) = encode_fitting(&image, &qualities, header.max_bytes) {
            return Reply {
                ok: true,
                error: None,
                result: Some(ResultPayload {
                    mime_type: mime,
                    original_width,
                    original_height,
                    width: image.width,
                    height: image.height,
                    was_resized: true,
                    bytes: data.len(),
                }),
                data,
            };
        }
        if image.width == 1 && image.height == 1 {
            return Reply {
                ok: true,
                error: None,
                result: None,
                data: Vec::new(),
            };
        }
        let next_width = ((image.width as f64 * 0.75) as u32).max(1);
        let next_height = ((image.height as f64 * 0.75) as u32).max(1);
        image = resize_to(&image, next_width, next_height);
    }
}

fn transcode(payload: Vec<u8>, header: &Header) -> Reply {
    let bytes: &[u8] = &payload;
    let format = match detect(bytes) {
        Some(format) => format,
        None => return Reply::failure("unsupported image format"),
    };
    let orientation = exif_orientation(bytes, format);
    if format == Format::Png && orientation == 1 {
        let (width, height) = match dimensions(bytes, format) {
            Ok(value) => value,
            Err(error) => return Reply::failure(error),
        };
        return Reply {
            ok: true,
            error: None,
            result: Some(ResultPayload {
                mime_type: "image/png",
                original_width: width,
                original_height: height,
                width,
                height,
                was_resized: false,
                bytes: bytes.len(),
            }),
            data: payload,
        };
    }
    let image_format = match format {
        Format::Png => ImageFormat::Png,
        Format::Jpeg => ImageFormat::Jpeg,
        Format::WebP => ImageFormat::WebP,
        Format::Gif => ImageFormat::Gif,
        Format::Bmp => ImageFormat::Bmp,
    };
    let decoded = image::load_from_memory_with_format(bytes, image_format);
    drop(payload);
    let decoded = match decoded {
        Ok(value) => value,
        Err(error) => return Reply::failure(error.to_string()),
    };
    let image = Image::from_buffer(decoded.to_rgba8());
    let image = if orientation == 1 {
        image
    } else {
        apply_orientation(image, orientation)
    };
    // Display conversion, not a size budget: fast compression keeps the UI responsive.
    let data = encode_png_with(&image, png::Compression::Fast);
    let _ = header;
    Reply {
        ok: true,
        error: None,
        result: Some(ResultPayload {
            mime_type: "image/png",
            original_width: image.width,
            original_height: image.height,
            width: image.width,
            height: image.height,
            was_resized: false,
            bytes: data.len(),
        }),
        data,
    }
}

fn mime_of(mime_type: &str) -> &'static str {
    match mime_type {
        value if value.starts_with("image/jpeg") || value.starts_with("image/jpg") => "image/jpeg",
        value if value.starts_with("image/gif") => "image/gif",
        value if value.starts_with("image/webp") => "image/webp",
        _ => "image/png",
    }
}

fn detect(bytes: &[u8]) -> Option<Format> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(Format::Png);
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some(Format::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(Format::WebP);
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return Some(Format::Gif);
    }
    if bytes.len() >= 14 && &bytes[0..2] == b"BM" {
        return Some(Format::Bmp);
    }
    None
}

fn encoded_base64_len(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

fn scaled_target(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let mut target_width = width;
    let mut target_height = height;
    if target_width > max_width {
        target_height = (target_height as f64 * max_width as f64 / target_width as f64).round() as u32;
        target_width = max_width;
    }
    if target_height > max_height {
        target_width = (target_width as f64 * max_height as f64 / target_height as f64).round() as u32;
        target_height = max_height;
    }
    (target_width.max(1), target_height.max(1))
}

fn swaps_axes(orientation: u8) -> bool {
    matches!(orientation, 5..=8)
}

fn oriented_dims(width: u32, height: u32, orientation: u8) -> (u32, u32) {
    if swaps_axes(orientation) {
        (height, width)
    } else {
        (width, height)
    }
}

fn quality_steps(jpeg_quality: u8) -> Vec<u8> {
    let mut steps = vec![jpeg_quality, 85, 70, 55, 40];
    let mut unique = Vec::new();
    for step in steps.drain(..) {
        if !unique.contains(&step) {
            unique.push(step);
        }
    }
    unique
}

// ---------- dimensions ----------

fn dimensions(bytes: &[u8], format: Format) -> Result<(u32, u32), String> {
    match format {
        Format::Png => {
            let decoder = png::Decoder::new(Cursor::new(bytes));
            let reader = decoder.read_info().map_err(|error| error.to_string())?;
            let info = reader.info();
            Ok((info.width, info.height))
        }
        Format::Jpeg => {
            let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
            decoder.read_info().map_err(|error| error.to_string())?;
            let info = decoder.info().ok_or("jpeg header missing")?;
            Ok((info.width as u32, info.height as u32))
        }
        Format::WebP => image_dimensions(bytes, ImageFormat::WebP),
        Format::Gif => image_dimensions(bytes, ImageFormat::Gif),
        Format::Bmp => image_dimensions(bytes, ImageFormat::Bmp),
    }
}

fn image_dimensions(bytes: &[u8], format: ImageFormat) -> Result<(u32, u32), String> {
    let reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.into_dimensions().map_err(|error| error.to_string())
}

// ---------- EXIF orientation ----------

fn read_u16(bytes: &[u8], position: usize, little_endian: bool) -> Option<u16> {
    let first = *bytes.get(position)? as u16;
    let second = *bytes.get(position + 1)? as u16;
    Some(if little_endian {
        first | (second << 8)
    } else {
        (first << 8) | second
    })
}

fn read_u32(bytes: &[u8], position: usize, little_endian: bool) -> Option<u32> {
    let first = *bytes.get(position)? as u32;
    let second = *bytes.get(position + 1)? as u32;
    let third = *bytes.get(position + 2)? as u32;
    let fourth = *bytes.get(position + 3)? as u32;
    Some(if little_endian {
        first | (second << 8) | (third << 16) | (fourth << 24)
    } else {
        (first << 24) | (second << 16) | (third << 8) | fourth
    })
}

fn has_exif_header(bytes: &[u8], offset: usize) -> bool {
    matches!(bytes.get(offset..offset + 6), Some(b"Exif\0\0"))
}

fn read_orientation_from_tiff(bytes: &[u8], tiff_start: usize) -> u8 {
    if tiff_start + 8 > bytes.len() {
        return 1;
    }
    let little_endian = bytes[tiff_start] == 0x49 && bytes[tiff_start + 1] == 0x49;
    let ifd_offset = read_u32(bytes, tiff_start + 4, little_endian).unwrap_or(0) as usize;
    let ifd_start = match tiff_start.checked_add(ifd_offset) {
        Some(value) => value,
        None => return 1,
    };
    if ifd_start + 2 > bytes.len() {
        return 1;
    }
    let entry_count = read_u16(bytes, ifd_start, little_endian).unwrap_or(0) as usize;
    for index in 0..entry_count {
        let entry = ifd_start + 2 + index * 12;
        if entry + 12 > bytes.len() {
            return 1;
        }
        if read_u16(bytes, entry, little_endian) == Some(0x0112) {
            let value = read_u16(bytes, entry + 8, little_endian).unwrap_or(1);
            return if (1..=8).contains(&value) { value as u8 } else { 1 };
        }
    }
    1
}

fn jpeg_tiff_offset(bytes: &[u8]) -> Option<usize> {
    let mut offset = 2usize;
    while offset + 1 < bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        let marker = bytes[offset + 1];
        if marker == 0xff {
            offset += 1;
            continue;
        }
        if marker == 0xe1 {
            let segment_start = offset + 4;
            if segment_start + 6 > bytes.len() {
                return None;
            }
            if has_exif_header(bytes, segment_start) {
                return Some(segment_start + 6);
            }
        }
        if offset + 4 > bytes.len() {
            return None;
        }
        let length = ((bytes[offset + 2] as usize) << 8) | bytes[offset + 3] as usize;
        offset += 2 + length;
    }
    None
}

fn webp_tiff_offset(bytes: &[u8]) -> Option<usize> {
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let chunk = &bytes[offset..offset + 4];
        let size = (bytes[offset + 4] as usize)
            | ((bytes[offset + 5] as usize) << 8)
            | ((bytes[offset + 6] as usize) << 16)
            | ((bytes[offset + 7] as usize) << 24);
        let data_start = offset + 8;
        if chunk == b"EXIF" {
            if data_start + size > bytes.len() {
                return None;
            }
            return Some(if size >= 6 && has_exif_header(bytes, data_start) {
                data_start + 6
            } else {
                data_start
            });
        }
        offset = data_start + size + (size % 2);
    }
    None
}

fn exif_orientation(bytes: &[u8], format: Format) -> u8 {
    let tiff_start = match format {
        Format::Jpeg => jpeg_tiff_offset(bytes),
        Format::WebP => webp_tiff_offset(bytes),
        _ => None,
    };
    match tiff_start {
        Some(start) => read_orientation_from_tiff(bytes, start),
        None => 1,
    }
}

// ---------- decode ----------

fn channels_of(color: png::ColorType) -> usize {
    match color {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => 1,
    }
}

fn to_rgba(data: &[u8], channels: usize) -> Vec<u8> {
    let pixels = data.len() / channels.max(1);
    let mut out = Vec::with_capacity(pixels * 4);
    for index in 0..pixels {
        let base = index * channels;
        let value = |offset: usize| data.get(base + offset).copied().unwrap_or(0);
        let (red, green, blue, alpha) = match channels {
            1 => (value(0), value(0), value(0), 255),
            2 => (value(0), value(0), value(0), value(1)),
            3 => (value(0), value(1), value(2), 255),
            _ => (value(0), value(1), value(2), value(3)),
        };
        out.extend_from_slice(&[red, green, blue, alpha]);
    }
    out
}

fn decode_small(bytes: &[u8], format: Format, width: u32, height: u32) -> Result<Image, String> {
    match format {
        Format::Png => decode_png_small(bytes, width, height),
        Format::Jpeg => decode_jpeg_small(bytes, width, height),
        Format::WebP => decode_full(bytes, ImageFormat::WebP, width, height),
        Format::Gif => decode_full(bytes, ImageFormat::Gif, width, height),
        Format::Bmp => decode_full(bytes, ImageFormat::Bmp, width, height),
    }
}

fn decode_png_small(bytes: &[u8], width: u32, height: u32) -> Result<Image, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let (color, depth) = reader.output_color_type();
    if depth != png::BitDepth::Eight {
        return Err("unsupported png bit depth".to_string());
    }
    let channels = channels_of(color);
    let source_width = reader.info().width;
    let source_height = reader.info().height;
    let interlaced = reader.info().interlaced;

    if interlaced {
        let mut buffer = vec![0u8; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buffer).map_err(|error| error.to_string())?;
        let pixels = to_rgba(&buffer[..frame.buffer_size()], channels);
        let image = Image {
            width: frame.width,
            height: frame.height,
            rgba: pixels,
        };
        return Ok(resize_to(&image, width, height));
    }

    let mut sums = vec![0u32; width as usize * 4];
    let mut counts = vec![0u32; width as usize];
    let mut out = vec![0u8; width as usize * height as usize * 4];
    let mut current_target_row: i64 = -1;

    let mut flush = |row: u32, sums: &mut [u32], counts: &mut [u32], out: &mut [u8]| {
        let base = row as usize * width as usize * 4;
        for column in 0..width as usize {
            let count = counts[column].max(1);
            for channel in 0..4 {
                out[base + column * 4 + channel] = (sums[column * 4 + channel] / count) as u8;
            }
            sums[column * 4..column * 4 + 4].fill(0);
            counts[column] = 0;
        }
    };

    let mut source_row = 0u32;
    while let Some(row) = reader.next_row().map_err(|error| error.to_string())? {
        let data = row.data();
        let target_row = (source_row as u64 * height as u64 / source_height as u64) as u32;
        if current_target_row >= 0 && target_row as i64 != current_target_row {
            flush(current_target_row as u32, &mut sums, &mut counts, &mut out);
        }
        current_target_row = target_row as i64;
        for column in 0..source_width {
            let target_column = (column as u64 * width as u64 / source_width as u64) as usize;
            let base = column as usize * channels;
            let value = |offset: usize| data.get(base + offset).copied().unwrap_or(0);
            let (red, green, blue, alpha) = match channels {
                1 => (value(0), value(0), value(0), 255),
                2 => (value(0), value(0), value(0), value(1)),
                3 => (value(0), value(1), value(2), 255),
                _ => (value(0), value(1), value(2), value(3)),
            };
            sums[target_column * 4] += red as u32;
            sums[target_column * 4 + 1] += green as u32;
            sums[target_column * 4 + 2] += blue as u32;
            sums[target_column * 4 + 3] += alpha as u32;
            counts[target_column] += 1;
        }
        source_row += 1;
    }
    if current_target_row >= 0 {
        flush(current_target_row as u32, &mut sums, &mut counts, &mut out);
    }
    Ok(Image {
        width,
        height,
        rgba: out,
    })
}

fn decode_jpeg_small(bytes: &[u8], width: u32, height: u32) -> Result<Image, String> {
    let mut probe = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    probe.read_info().map_err(|error| error.to_string())?;
    let info = probe.info().ok_or("jpeg header missing")?;
    let source_width = info.width as u32;

    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    let factor = (source_width / width.max(1)).clamp(1, 8);
    let scale_width = (source_width / factor).max(1).min(u16::MAX as u32) as u16;
    let scale_height = ((info.height as u32 / factor).max(1).min(u16::MAX as u32)) as u16;
    decoder
        .scale(scale_width, scale_height)
        .map_err(|error| error.to_string())?;
    let pixels = decoder.decode().map_err(|error| error.to_string())?;
    let decoded = decoder.info().ok_or("jpeg info missing")?;
    let decoded_width = decoded.width as u32;
    let decoded_height = decoded.height as u32;
    let rgba = to_rgba(&pixels, 3);
    let image = Image {
        width: decoded_width,
        height: decoded_height,
        rgba,
    };
    if decoded_width <= width && decoded_height <= height {
        return Ok(image);
    }
    Ok(resize_to(&image, width, height))
}

fn decode_full(bytes: &[u8], format: ImageFormat, width: u32, height: u32) -> Result<Image, String> {
    let decoded = image::load_from_memory_with_format(bytes, format).map_err(|error| error.to_string())?;
    let image = Image::from_buffer(match decoded {
        DynamicImage::ImageRgba8(buffer) => buffer,
        other => other.to_rgba8(),
    });
    Ok(resize_to(&image, width, height))
}

fn resize_to(image: &Image, width: u32, height: u32) -> Image {
    if image.width == width && image.height == height {
        return Image {
            width,
            height,
            rgba: image.rgba.clone(),
        };
    }
    let buffer = RgbaImage::from_raw(image.width, image.height, image.rgba.clone()).expect("rgba buffer");
    Image::from_buffer(imageops::resize(
        &buffer,
        width,
        height,
        imageops::FilterType::Lanczos3,
    ))
}

fn apply_orientation(image: Image, orientation: u8) -> Image {
    let buffer = image.into_buffer();
    let oriented = match orientation {
        2 => imageops::flip_horizontal(&buffer),
        3 => imageops::rotate180(&buffer),
        4 => imageops::flip_vertical(&buffer),
        5 => imageops::flip_horizontal(&imageops::rotate90(&buffer)),
        6 => imageops::rotate90(&buffer),
        7 => imageops::flip_vertical(&imageops::rotate90(&buffer)),
        8 => imageops::rotate270(&buffer),
        _ => buffer,
    };
    Image::from_buffer(oriented)
}

// ---------- encode ----------

fn encode_png(image: &Image) -> Vec<u8> {
    encode_png_with(image, png::Compression::Default)
}

fn encode_png_with(image: &Image, compression: png::Compression) -> Vec<u8> {
    let mut out = Vec::with_capacity(image.rgba.len() / 8);
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(compression);
        if let Ok(mut writer) = encoder.write_header() {
            let _ = writer.write_image_data(&image.rgba);
        }
    }
    out
}

fn encode_jpeg(image: &Image, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    let rgb = RgbaImage::from_raw(image.width, image.height, image.rgba.clone())
        .map(|buffer| DynamicImage::ImageRgba8(buffer).to_rgb8());
    if let Some(rgb) = rgb {
        let _ = encoder.write_image(rgb.as_raw(), image.width, image.height, image::ExtendedColorType::Rgb8);
    }
    out
}

fn encode_fitting(image: &Image, qualities: &[u8], max_bytes: usize) -> Option<(Vec<u8>, &'static str)> {
    let png = encode_png(image);
    let jpeg = encode_jpeg(image, qualities[0]);
    let (first, first_mime, second, second_mime) = if jpeg.len() < png.len() {
        (jpeg, "image/jpeg", png, "image/png")
    } else {
        (png, "image/png", jpeg, "image/jpeg")
    };
    if encoded_base64_len(first.len()) < max_bytes {
        return Some((first, first_mime));
    }
    if encoded_base64_len(second.len()) < max_bytes {
        return Some((second, second_mime));
    }
    drop(second);
    for quality in &qualities[1..] {
        let data = encode_jpeg(image, *quality);
        if encoded_base64_len(data.len()) < max_bytes {
            return Some((data, "image/jpeg"));
        }
    }
    None
}
