//! The metadata gate for a freshly encoded SDR JPEG: only the compressed picture (tables, frame, scans) is kept.
//! Not an HDR decoder and not a steganography detector.
//!
//! Reference: `mobile/src/photo/jpeg.ts`, function by function. Where the reference reads past the end of the
//! bytes it gets `undefined`; here that is `None` from `get`, and every comparison is written so that `None`
//! takes the same branch `undefined` takes there.

/// Why a file was refused. The reference throws an `Error`; `validPreview` only ever asks whether it threw.
pub type Refused = &'static str;

pub struct Frame { pub width: u32, pub height: u32 }
pub struct Segment<'a> { pub marker: u8, pub start: usize, pub end: usize, pub payload: &'a [u8] }
pub struct Clean { pub bytes: Vec<u8>, pub width: u32, pub height: u32 }

const MAX_BYTES: usize = 20 * 1024 * 1024;
pub fn is_sof(marker: u8) -> bool { matches!(marker, 0xc0 | 0xc1 | 0xc2) }
pub fn is_table(marker: u8) -> bool { matches!(marker, 0xc4 | 0xdb | 0xdd) }
fn u16_at(bytes: &[u8], offset: usize) -> usize { usize::from(bytes[offset]) << 8 | usize::from(bytes[offset + 1]) }

pub fn segment_at(bytes: &[u8], mut offset: usize) -> Result<Segment<'_>, Refused> {
    let start = offset;
    if bytes.get(offset) != Some(&255) { return Err("no segment marker") }
    while bytes.get(offset) == Some(&255) { offset += 1 }
    let marker = bytes.get(offset).copied();
    offset += 1;
    if marker == Some(0xd9) { return Ok(Segment { marker: 0xd9, start, end: offset, payload: &[] }) }
    if offset + 2 > bytes.len() { return Err("the header is cut short") }
    // Two more bytes follow the marker, so the marker itself was inside the file.
    let Some(marker) = marker else { return Err("the header is cut short") };
    let length = u16_at(bytes, offset);
    let end = offset + length;
    if length < 2 || end > bytes.len() { return Err("a wrong segment length") }
    Ok(Segment { marker, start, end, payload: &bytes[offset + 2..end] })
}

pub fn read_frame(segment: &Segment) -> Result<Frame, Refused> {
    let data = segment.payload;
    let components = data.get(5).copied();
    if data.first() != Some(&8) || !matches!(components, Some(1 | 3)) || data.len() != 6 + usize::from(components.unwrap_or(0)) * 3 { return Err("an unsupported coding header") }
    let (height, width) = (u16_at(data, 1), u16_at(data, 3));
    validate_frame_size(width, height)?;
    Ok(Frame { width: width as u32, height: height as u32 })
}

fn validate_frame_size(width: usize, height: usize) -> Result<(), Refused> {
    if width == 0 || height == 0 || width > 20000 || height > 20000 || width * height > 16_000_000 { return Err("the size is over the pixel limit") }
    Ok(())
}

/// Markers of a gain map (Ultra HDR, ISO 21496-1, Apple): `/hdrgm:|HDRGainMap|HDRCapacity|urn:iso:std:iso:ts:21496/i`
/// over the payload read as UTF-8.
///
/// The reference decodes the bytes with `TextDecoder` and tests the text. Searching the bytes gives the same
/// answer: every word is ASCII; without the `u` flag a letter outside ASCII never matches an ASCII one
/// (so `ſ` is not `s`); and the decoder turns each run of other bytes into at least one character outside
/// ASCII (a valid sequence, or U+FFFD), never joining the ASCII letters around it. A leading byte-order mark is
/// dropped by the decoder, but only at the very start, where nothing stands before it.
pub fn gainmap_marker(data: &[u8]) -> bool {
    const WORDS: [&[u8]; 4] = [b"hdrgm:", b"hdrgainmap", b"hdrcapacity", b"urn:iso:std:iso:ts:21496"];
    WORDS.iter().any(|word| data.windows(word.len()).any(|window| window.eq_ignore_ascii_case(word)))
}

fn check_metadata(data: &[u8]) -> Result<(), Refused> {
    if gainmap_marker(data) { return Err("an HDR gain map cannot be dropped and silently turned into SDR") }
    Ok(())
}

pub fn entropy_end(bytes: &[u8], start: usize) -> Result<usize, Refused> {
    let mut offset = start;
    while offset < bytes.len() {
        let byte = bytes[offset];
        offset += 1;
        if byte != 255 { continue }
        let marker_start = offset - 1;
        while bytes.get(offset) == Some(&255) { offset += 1 }
        let marker = bytes.get(offset).copied();
        if matches!(marker, Some(0 | 0xd0..=0xd7)) { offset += 1; continue }
        return Ok(marker_start);
    }
    Err("the end of the picture data was not found")
}

/// The segment's bytes with fill bytes (repeated 0xFF before the marker) removed: nothing hidden in padding is copied.
pub fn segment_bytes(out: &mut Vec<u8>, bytes: &[u8], segment: &Segment) {
    let mut at = segment.start;
    while bytes.get(at + 1) == Some(&255) { at += 1 }
    if at == segment.start { out.extend_from_slice(&bytes[segment.start..segment.end]); return }
    out.push(255);
    out.extend_from_slice(&bytes[at + 1..segment.end]);
}

/// DQT, DHT and DRI must be exactly their tables: no trailing bytes travel inside them.
pub fn check_tables(segment: &Segment) -> Result<(), Refused> {
    let data = segment.payload;
    if segment.marker == 0xdd { return if data.len() != 2 { Err("a wrong DRI length") } else { Ok(()) } }
    let mut at = 0;
    if data.is_empty() { return Err("an empty table") }
    while at < data.len() {
        if segment.marker == 0xdb {
            let (precision, id) = (data[at] >> 4, data[at] & 15);
            if precision > 1 || id > 3 { return Err("a wrong quantisation table") }
            at += 1 + 64 * if precision != 0 { 2 } else { 1 };
        } else {
            let (kind, id) = (data[at] >> 4, data[at] & 15);
            if kind > 1 || id > 3 || at + 17 > data.len() { return Err("a wrong Huffman table") }
            let count: usize = data[at + 1..=at + 16].iter().map(|n| usize::from(*n)).sum();
            if count > 256 { return Err("a wrong Huffman table") }
            at += 17 + count;
        }
    }
    if at != data.len() { return Err("extra bytes in a table") }
    Ok(())
}

pub fn check_scan(data: &[u8]) -> Result<(), Refused> {
    match data.first() {
        Some(components @ 1..=3) if data.len() == 1 + usize::from(*components) * 2 + 3 => Ok(()),
        _ => Err("a wrong scan header"),
    }
}

struct State { frame: Option<Frame>, scan: bool, end: bool, parts: Vec<u8> }
pub fn is_metadata(marker: u8) -> bool { (0xe0..=0xef).contains(&marker) || marker == 0xfe }

fn collect_segment(state: &mut State, segment: &Segment, bytes: &[u8]) -> Result<usize, Refused> {
    let marker = segment.marker;
    if marker == 0xd9 { state.end = true; segment_bytes(&mut state.parts, bytes, segment); return Ok(segment.end) }
    if is_metadata(marker) { check_metadata(segment.payload)?; return Ok(segment.end) }
    if is_sof(marker) {
        if state.frame.is_some() { return Err("a second frame header") }
        state.frame = Some(read_frame(segment)?);
    } else if is_table(marker) { check_tables(segment)? }
    else if marker != 0xda { return Err("an unsupported coding marker") }
    segment_bytes(&mut state.parts, bytes, segment);
    if marker != 0xda { return Ok(segment.end) }
    collect_scan(state, segment, bytes)
}

fn collect_scan(state: &mut State, segment: &Segment, bytes: &[u8]) -> Result<usize, Refused> {
    if state.frame.is_none() { return Err("a scan before the frame header") }
    check_scan(segment.payload)?;
    state.scan = true;
    let end = entropy_end(bytes, segment.end)?;
    if end == segment.end { return Err("empty picture data") }
    state.parts.extend_from_slice(&bytes[segment.end..end]);
    Ok(end)
}

fn complete_frame(state: State, offset: usize, length: usize) -> Result<Clean, Refused> {
    match state.frame {
        Some(frame) if state.scan && state.end && offset == length => Ok(Clean { bytes: state.parts, width: frame.width, height: frame.height }),
        _ => Err("the file is not finished or has data after its end"),
    }
}

pub fn sanitize_jpeg(bytes: &[u8]) -> Result<Clean, Refused> {
    if bytes.len() > MAX_BYTES { return Err("the file is over 20 MiB") }
    if bytes.first() != Some(&255) || bytes.get(1) != Some(&0xd8) { return Err("no starting signature") }
    let mut state = State { frame: None, scan: false, end: false, parts: bytes[..2].to_vec() };
    let (mut offset, mut count) = (2, 0);
    while offset < bytes.len() && !state.end {
        count += 1;
        if count > 4096 { return Err("too many segments") }
        offset = collect_segment(&mut state, &segment_at(bytes, offset)?, bytes)?;
    }
    complete_frame(state, offset, bytes.len())
}
