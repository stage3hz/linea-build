//! A QR code for the backup key: version 3 (29×29), error correction level M, alphanumeric mode, one data block.
//!
//! Reference: `mobile/src/e2ee/qr.ts` (written from ISO/IEC 18004), ported exactly — the same modules, the same mask
//! — and pinned by `tests/history_vectors.rs` with matrices made by the reference; the reference's own test reads
//! its codes back with a real QR reader.

const VERSION: usize = 3;
const SIZE: usize = 17 + 4 * VERSION;
const DATA_CODEWORDS: usize = 44;
const EC_CODEWORDS: usize = 26;
const ALNUM: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
/// At most this many characters fit.
pub const MAX_TEXT: usize = 61;

fn tables() -> ([u8; 512], [u8; 256]) {
    let (mut exp, mut log) = ([0u8; 512], [0u8; 256]);
    let mut x: u32 = 1;
    for i in 0..255 { exp[i] = x as u8; log[x as usize] = i as u8; x <<= 1; if x & 0x100 != 0 { x ^= 0x11d } }
    for i in 255..512 { exp[i] = exp[i - 255] }
    (exp, log)
}

fn error_correction(data: &[u8]) -> Vec<u8> {
    let (exp, log) = tables();
    let mul = |a: u8, b: u8| if a == 0 || b == 0 { 0 } else { exp[log[a as usize] as usize + log[b as usize] as usize] };
    let mut generator = vec![1u8];
    for i in 0..EC_CODEWORDS {
        let mut next = vec![0u8; generator.len() + 1];
        for (j, coefficient) in generator.iter().enumerate() { next[j] ^= coefficient; next[j + 1] ^= mul(*coefficient, exp[i]) }
        generator = next;
    }
    let mut rest = data.to_vec();
    rest.extend(std::iter::repeat_n(0u8, EC_CODEWORDS));
    for i in 0..data.len() {
        let factor = rest[i];
        if factor != 0 { for (j, coefficient) in generator.iter().enumerate() { rest[i + j] ^= mul(*coefficient, factor) } }
    }
    rest[data.len()..].to_vec()
}

fn codewords(text: &[u8]) -> Vec<u8> {
    let mut bits: Vec<u8> = Vec::new();
    let mut put = |value: usize, length: usize| for i in (0..length).rev() { bits.push(((value >> i) & 1) as u8) };
    let index = |byte: u8| ALNUM.iter().position(|item| *item == byte).unwrap_or(0);
    put(0b0010, 4);
    put(text.len(), 9);
    for pair in text.chunks(2) {
        if pair.len() == 2 { put(index(pair[0]) * 45 + index(pair[1]), 11) } else { put(index(pair[0]), 6) }
    }
    let capacity = DATA_CODEWORDS * 8;
    let terminator = 4.min(capacity - bits.len());
    bits.extend(std::iter::repeat_n(0u8, terminator));
    while bits.len() % 8 != 0 { bits.push(0) }
    let mut data: Vec<u8> = bits.chunks(8).map(|byte| byte.iter().fold(0u8, |acc, bit| (acc << 1) | bit)).collect();
    let mut pad = 0;
    while data.len() < DATA_CODEWORDS { data.push(if pad % 2 == 1 { 0x11 } else { 0xec }); pad += 1 }
    let ec = error_correction(&data);
    data.extend(ec);
    data
}

type Grid = Vec<Vec<bool>>;
fn set(dark: &mut Grid, fixed: &mut Grid, row: usize, col: usize, value: bool) { dark[row][col] = value; fixed[row][col] = true }
fn function_patterns() -> (Grid, Grid) {
    let mut dark = vec![vec![false; SIZE]; SIZE];
    let mut fixed = vec![vec![false; SIZE]; SIZE];
    for (r, c) in [(0i32, 0i32), (0, SIZE as i32 - 7), (SIZE as i32 - 7, 0)] {
        for dr in -1..=7i32 { for dc in -1..=7i32 {
            let (row, col) = (r + dr, c + dc);
            if row < 0 || col < 0 || row >= SIZE as i32 || col >= SIZE as i32 { continue }
            let ring = (dr - 3).abs().max((dc - 3).abs());
            set(&mut dark, &mut fixed, row as usize, col as usize, ring != 2 && ring != 4);
        } }
    }
    for i in 8..SIZE - 8 { set(&mut dark, &mut fixed, 6, i, i % 2 == 0); set(&mut dark, &mut fixed, i, 6, i % 2 == 0) }
    // The one alignment pattern of version 3, centred at (22, 22).
    for dr in -2..=2i32 { for dc in -2..=2i32 { set(&mut dark, &mut fixed, (22 + dr) as usize, (22 + dc) as usize, dr.abs().max(dc.abs()) != 1) } }
    // Format areas (filled per mask) and the dark module.
    for i in 0..9 {
        if !fixed[8][i] { set(&mut dark, &mut fixed, 8, i, false) }
        if !fixed[i][8] { set(&mut dark, &mut fixed, i, 8, false) }
    }
    for i in 0..8 { set(&mut dark, &mut fixed, 8, SIZE - 1 - i, false); set(&mut dark, &mut fixed, SIZE - 1 - i, 8, false) }
    set(&mut dark, &mut fixed, SIZE - 8, 8, true);
    (dark, fixed)
}

fn mask_bit(mask: usize, r: usize, c: usize) -> bool {
    match mask {
        0 => (r + c) % 2 == 0, 1 => r % 2 == 0, 2 => c % 3 == 0, 3 => (r + c) % 3 == 0,
        4 => (r / 2 + c / 3) % 2 == 0, 5 => (r * c) % 2 + (r * c) % 3 == 0,
        6 => ((r * c) % 2 + (r * c) % 3) % 2 == 0, _ => ((r + c) % 2 + (r * c) % 3) % 2 == 0,
    }
}
fn format_bits(mask: usize) -> u32 {
    let data = mask as u32; // level M = 00
    let mut rem = data << 10;
    for i in (10..=14).rev() { if (rem >> i) & 1 == 1 { rem ^= 0x537 << (i - 10) } }
    ((data << 10) | rem) ^ 0x5412
}
fn draw_format(dark: &mut Grid, mask: usize) {
    let bits = format_bits(mask);
    let bit = |i: usize| (bits >> i) & 1 == 1;
    for i in 0..=5 { dark[i][8] = bit(i) }
    dark[7][8] = bit(6); dark[8][8] = bit(7); dark[8][7] = bit(8);
    for i in 9..15 { dark[8][14 - i] = bit(i) }
    for i in 0..8 { dark[8][SIZE - 1 - i] = bit(i) }
    for i in 8..15 { dark[SIZE - 15 + i][8] = bit(i) }
}
fn penalty(dark: &Grid) -> usize {
    let mut score = 0;
    let finder_a = [true, false, true, true, true, false, true, false, false, false, false];
    let finder_b = [false, false, false, false, true, false, true, true, true, false, true];
    for transposed in [false, true] {
        let get = |i: usize, j: usize| if transposed { dark[j][i] } else { dark[i][j] };
        for i in 0..SIZE {
            let mut run = 1;
            for j in 1..=SIZE {
                if j < SIZE && get(i, j) == get(i, j - 1) { run += 1; continue }
                if run >= 5 { score += 3 + run - 5 }
                run = 1;
            }
            for j in 0..SIZE.saturating_sub(10) {
                if (0..11).all(|k| get(i, j + k) == finder_a[k]) { score += 40 }
                if (0..11).all(|k| get(i, j + k) == finder_b[k]) { score += 40 }
            }
        }
    }
    for r in 0..SIZE - 1 { for c in 0..SIZE - 1 {
        let v = dark[r][c];
        if v == dark[r][c + 1] && v == dark[r + 1][c] && v == dark[r + 1][c + 1] { score += 3 }
    } }
    let count = dark.iter().flatten().filter(|v| **v).count() as i64;
    let total = (SIZE * SIZE) as i64;
    score + ((count * 20 - total * 10).abs() / total) as usize * 10
}

/// The modules of the QR code of `text` (row by row, `true` = dark), or `None` if it does not fit this one version.
pub fn matrix(text: &str) -> Option<Vec<Vec<bool>>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_TEXT || !bytes.iter().all(|byte| ALNUM.contains(byte)) { return None }
    let words = codewords(bytes);
    let (base, fixed) = function_patterns();
    let mut placed = base;
    let mut index = 0usize;
    let mut right = SIZE as i32 - 1;
    while right >= 1 {
        if right == 6 { right = 5 }
        for vert in 0..SIZE {
            for j in 0..2 {
                let col = (right - j) as usize;
                let upward = ((right + 1) & 2) == 0;
                let row = if upward { SIZE - 1 - vert } else { vert };
                if fixed[row][col] { continue }
                placed[row][col] = index < words.len() * 8 && (words[index >> 3] >> (7 - (index & 7))) & 1 == 1;
                index += 1;
            }
        }
        right -= 2;
    }
    let mut best: Option<(usize, Grid)> = None;
    for mask in 0..8 {
        let mut candidate: Grid = placed.iter().enumerate().map(|(r, row)| row.iter().enumerate().map(|(c, value)| if fixed[r][c] { *value } else { *value != mask_bit(mask, r, c) }).collect()).collect();
        draw_format(&mut candidate, mask);
        let score = penalty(&candidate);
        if best.as_ref().is_none_or(|(held, _)| score < *held) { best = Some((score, candidate)) }
    }
    best.map(|(_, grid)| grid)
}
