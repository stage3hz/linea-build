//! How good the connection is, and the time limits and automatic loading that follow from it.
//!
//! Reference: `mobile/src/network/quality.ts`. The app must work on any connection: a 3 KB message on EDGE must
//! not time out, and on a slow link only text loads by itself.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tier { Slow, Medium, Fast }

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Quality { pub rtt_ms: Option<f64>, pub kbps: Option<f64>, pub tier: Tier }

impl Default for Quality {
    fn default() -> Self { Quality { rtt_ms: None, kbps: None, tier: Tier::Fast } }
}

/// Weight of a new sample: one odd request does not change the tier.
const ALPHA: f64 = 0.2;
fn ewma(old: Option<f64>, sample: f64) -> f64 { match old { None => sample, Some(old) => old + ALPHA * (sample - old) } }

pub fn classify(rtt_ms: Option<f64>, kbps: Option<f64>) -> Tier {
    if kbps.is_some_and(|k| k < 200.0) || rtt_ms.is_some_and(|r| r > 900.0) { return Tier::Slow }
    if kbps.is_some_and(|k| k < 2000.0) || rtt_ms.is_some_and(|r| r > 350.0) { return Tier::Medium }
    Tier::Fast
}

/// One finished request. Small answers measure delay; answers of 16 KB and more measure speed.
/// `ms` is the whole request time as the app saw it.
pub fn add_sample(state: Quality, ms: f64, bytes: f64) -> Quality {
    if !(ms > 0.0) || !(bytes >= 0.0) { return state }
    let (mut rtt_ms, mut kbps) = (state.rtt_ms, state.kbps);
    if bytes < 4096.0 {
        rtt_ms = Some(ewma(rtt_ms, ms));
    } else if bytes >= 16384.0 {
        // One round trip is subtracted so a big answer from a fast but distant server is not called slow.
        let transfer_ms = (ms - rtt_ms.unwrap_or(0.0)).max(20.0);
        kbps = Some(ewma(kbps, (bytes * 8.0) / transfer_ms));
    }
    Quality { rtt_ms, kbps, tier: classify(rtt_ms, kbps) }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RequestKind { Send, Read, Upload }

/// Time limits that fit the measured speed, milliseconds.
pub fn timeout_for(kind: RequestKind, tier: Tier) -> u32 {
    let base: f64 = match kind { RequestKind::Upload => 120_000.0, RequestKind::Send => 20_000.0, RequestKind::Read => 18_000.0 };
    match tier { Tier::Slow => (base * 3.0) as u32, Tier::Medium => (base * 1.5).round() as u32, Tier::Fast => base as u32 }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Media { Photo, Video, AnimatedAvatar, Cover }

/// What loads by itself. On slow links only text; media waits for a tap.
pub fn autoload(kind: Media, tier: Tier) -> bool {
    match tier { Tier::Fast => true, Tier::Medium => matches!(kind, Media::Photo | Media::Cover), Tier::Slow => false }
}
