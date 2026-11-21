//! The two pieces of the gain-map gate (`mobile/src/photo/jpegHdr.ts`) that a message preview uses: telling
//! whether a JPEG announces a gain map, and taking only its first (SDR) picture. The gate itself — parsing,
//! validating and rewriting the gain map — is not ported here.

use super::jpeg::{check_scan, check_tables, entropy_end, gainmap_marker, is_metadata, is_sof, is_table, read_frame, segment_at, segment_bytes, Refused};

/// One JPEG codestream from the start of the file to its EOI, as a plain stream: only coding data.
/// (`plain(codestream(bytes, 0))` of the reference; the metadata it sets aside there is not needed here.)
fn codestream(bytes: &[u8]) -> Result<Vec<u8>, Refused> {
    if 2 > bytes.len() || bytes[0] != 255 || bytes[1] != 0xd8 { return Err("no starting signature of a picture") }
    let mut parts = bytes[..2].to_vec();
    let (mut offset, mut frame, mut scan, mut count) = (2, false, false, 0);
    loop {
        if offset >= bytes.len() { return Err("the picture is not finished") }
        count += 1;
        if count > 4096 { return Err("too many segments") }
        let segment = segment_at(bytes, offset)?;
        if segment.marker == 0xd9 {
            if !frame || !scan { return Err("no frame or no picture data") }
            segment_bytes(&mut parts, bytes, &segment);
            return Ok(parts);
        }
        if is_metadata(segment.marker) { offset = segment.end; continue }
        if is_sof(segment.marker) { if frame { return Err("a second frame header") } read_frame(&segment)?; frame = true }
        else if is_table(segment.marker) { check_tables(&segment)? }
        else if segment.marker != 0xda { return Err("an unsupported coding marker") }
        segment_bytes(&mut parts, bytes, &segment);
        if segment.marker != 0xda { offset = segment.end; continue }
        if !frame { return Err("a scan before the frame header") }
        check_scan(segment.payload)?;
        scan = true;
        let end = entropy_end(bytes, segment.end)?;
        if end == segment.end { return Err("empty picture data") }
        parts.extend_from_slice(&bytes[segment.end..end]);
        offset = end;
    }
}

/// Only the primary (SDR) picture of a gain-map JPEG, as a plain stream: the small message preview is always
/// SDR. Later pictures (the map, previews) are ignored.
pub fn primary_jpeg(bytes: &[u8]) -> Result<Vec<u8>, Refused> { codestream(bytes) }

/// Does the primary picture announce a gain map? (A cheap scan of the metadata before the first scan.)
pub fn announces_gainmap(bytes: &[u8]) -> bool {
    if bytes.first() != Some(&255) || bytes.get(1) != Some(&0xd8) { return false }
    let mut offset = 2;
    let mut count = 0;
    while count < 4096 && offset < bytes.len() {
        let Ok(item) = segment_at(bytes, offset) else { return false };
        if item.marker == 0xda || item.marker == 0xd9 { return false }
        if is_metadata(item.marker) && gainmap_marker(item.payload) { return true }
        offset = item.end;
        count += 1;
    }
    false
}
