// Shared between invizent-overlay-injector.exe (writer, "host") and invizent-overlay-hook.dll
// (reader, inside the game). Must match desktop/game-overlay.cjs (encodeFrame, HEADER_*).
//
// Kernel objects (all in the per-logon-session "Local\" namespace):
//   Local\InvizentOverlay.Config            fixed name, ConfigBlock: which session is live
//   Local\InvizentOverlay.Frame.<suffix>    FrameHeader + BGRA pixels (premultiplied alpha)
//   Local\InvizentOverlay.Lock.<suffix>     mutex guarding the Frame mapping
// <suffix> is random per app session (16 hex chars) and is passed to the DLL only through the
// Config block, so the frame objects cannot be guessed in advance.
#pragma once
#include <cstdint>

namespace invz {

constexpr uint32_t kFrameMagic = 0x4F564E49;   // "INVO" little-endian
constexpr uint32_t kConfigMagic = 0x43564E49;  // "INVC"
constexpr uint32_t kVersion = 1;
constexpr uint32_t kMaxWidth = 400;
constexpr uint32_t kMaxHeight = 600;
constexpr uint32_t kHeaderSize = 64;
constexpr uint32_t kFrameMappingSize = kHeaderSize + kMaxWidth * kMaxHeight * 4;
constexpr uint32_t kSuffixLen = 16;

// 64 bytes, little-endian, every field 32-bit aligned.
struct FrameHeader {
  uint32_t magic;         // 0  kFrameMagic
  uint32_t version;       // 4  kVersion
  uint32_t width;         // 8  0..kMaxWidth
  uint32_t height;        // 12 0..kMaxHeight
  uint32_t stride;        // 16 == width * 4
  uint32_t frame;         // 20 bumps on every change (pixels or settings)
  uint32_t corner;        // 24 0 topLeft, 1 topRight, 2 bottomLeft, 3 bottomRight
  uint32_t opacity;       // 28 0..255
  uint32_t visible;       // 32 0 / 1
  uint32_t margin;        // 36 pixels from the screen edge, 0..200
  // Written by the DLL (not by the host), read by the host: proves the in-game overlay is drawing.
  // Accessed with volatile/Interlocked operations only (other processes change it any time).
  uint32_t consumer_pid;  // 40 process that drew last
  uint32_t consumer_tick; // 44 GetTickCount() of that draw
  uint32_t reserved[4];   // 48..63
};
static_assert(sizeof(FrameHeader) == kHeaderSize, "FrameHeader must be 64 bytes");

struct ConfigBlock {
  uint32_t magic;               // kConfigMagic
  uint32_t version;             // kVersion
  uint32_t host_pid;            // the DLL unloads itself when this process ends
  uint32_t reserved;
  char suffix[kSuffixLen + 1];  // [0-9a-f]{16}, NUL-terminated
};

inline const wchar_t* ConfigName() { return L"Local\\InvizentOverlay.Config"; }

inline bool ValidSuffix(const char* s) {
  for (uint32_t i = 0; i < kSuffixLen; ++i) {
    const char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return s[kSuffixLen] == '\0';
}

// Validates a header copy before any pixel is touched.
inline bool ValidHeader(const FrameHeader& h) {
  return h.magic == kFrameMagic && h.version == kVersion && h.width <= kMaxWidth &&
         h.height <= kMaxHeight && h.stride == h.width * 4 && h.corner <= 3 && h.opacity <= 255 &&
         h.visible <= 1 && h.margin <= 200;
}

}  // namespace invz
