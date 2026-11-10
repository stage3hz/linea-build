#include "overlay.h"

#include <d3dcompiler.h>
#include <cstdio>
#include <cstring>
#include <iterator>

namespace invz {

std::atomic<bool> g_teardown{false};

FrameSource& Frames() {
  static FrameSource source;
  return source;
}

bool FrameSource::Open(const char* suffix) {
  wchar_t frame_name[96], lock_name[96];
  std::swprintf(frame_name, std::size(frame_name), L"Local\\InvizentOverlay.Frame.%hs", suffix);
  std::swprintf(lock_name, std::size(lock_name), L"Local\\InvizentOverlay.Lock.%hs", suffix);
  mapping_ = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, frame_name);
  lock_ = OpenMutexW(SYNCHRONIZE, FALSE, lock_name);
  if (mapping_) view_ = static_cast<uint8_t*>(MapViewOfFile(mapping_, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, kFrameMappingSize));
  MEMORY_BASIC_INFORMATION mbi{};
  if (!view_ || !lock_ || !VirtualQuery(view_, &mbi, sizeof mbi) || mbi.RegionSize < kFrameMappingSize) {
    Close();
    return false;
  }
  return true;
}

void FrameSource::Close() {
  if (view_) UnmapViewOfFile(view_);
  if (mapping_) CloseHandle(mapping_);
  if (lock_) CloseHandle(lock_);
  view_ = nullptr;
  mapping_ = lock_ = nullptr;
}

bool FrameSource::Poll(uint32_t* seen, bool* have, Frame* out) {
  if (!view_) return false;
  auto* shared = reinterpret_cast<volatile FrameHeader*>(view_);
  if (*have && shared->frame == *seen) return false;  // nothing new: no lock, no copy
  const DWORD w = WaitForSingleObject(lock_, 0);       // try-lock only, never wait
  if (w != WAIT_OBJECT_0 && w != WAIT_ABANDONED) return false;
  FrameHeader h;
  std::memcpy(&h, view_, sizeof h);
  const bool ok = ValidHeader(h);
  if (ok) {
    out->width = h.width;
    out->height = h.height;
    out->corner = h.corner;
    out->opacity = h.opacity;
    out->visible = h.visible;
    out->margin = h.margin;
    const uint8_t* src = view_ + kHeaderSize;
    out->pixels.assign(src, src + static_cast<size_t>(h.stride) * h.height);
  }
  ReleaseMutex(lock_);
  *seen = h.frame;
  *have = true;
  return ok;
}

void FrameSource::MarkDrawn() {
  if (!view_) return;
  const DWORD now = GetTickCount();
  if (now - last_mark_.load() < 250) return;
  last_mark_ = now;
  auto* shared = reinterpret_cast<FrameHeader*>(view_);
  InterlockedExchange(reinterpret_cast<volatile LONG*>(&shared->consumer_tick), static_cast<LONG>(now));
  InterlockedExchange(reinterpret_cast<volatile LONG*>(&shared->consumer_pid), static_cast<LONG>(GetCurrentProcessId()));
}

bool Place(const Frame& f, uint32_t target_w, uint32_t target_h, Rect* r) {
  if (!f.visible || !f.width || !f.height || f.pixels.size() < size_t(f.width) * f.height * 4) return false;
  const int m = static_cast<int>(f.margin), w = static_cast<int>(f.width), h = static_cast<int>(f.height);
  const int tw = static_cast<int>(target_w), th = static_cast<int>(target_h);
  if (w + 2 * m > tw || h + 2 * m > th) return false;  // tiny window: do not cover the game
  r->w = w;
  r->h = h;
  r->x = (f.corner & 1) ? tw - w - m : m;
  r->y = (f.corner & 2) ? th - h - m : m;
  return true;
}

bool IsForeground(HWND w) {
  const HWND fg = GetForegroundWindow();
  return w && fg && (w == fg || GetAncestor(w, GA_ROOT) == fg || GetAncestor(w, GA_ROOTOWNER) == fg);
}

static const char kShader[] = R"(
cbuffer Quad : register(b0) { float4 rect; float opacity; float3 pad; };
Texture2D picture : register(t0);
SamplerState point_clamp : register(s0);
struct V { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
V VSMain(uint id : SV_VertexID) {
  float2 uv = float2(id & 1, id >> 1);
  V o;
  o.pos = float4(lerp(rect.x, rect.z, uv.x), lerp(rect.y, rect.w, uv.y), 0, 1);
  o.uv = uv;
  return o;
}
float4 PSMain(V i) : SV_Target { return picture.Sample(point_clamp, i.uv) * opacity; }
)";

std::vector<uint8_t> CompileShader(const char* entry, const char* target) {
  std::vector<uint8_t> code;
  HMODULE dll = LoadLibraryExW(L"d3dcompiler_47.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!dll) return code;
  auto compile = reinterpret_cast<pD3DCompile>(GetProcAddress(dll, "D3DCompile"));
  ID3DBlob* blob = nullptr;
  ID3DBlob* errors = nullptr;
  if (compile && SUCCEEDED(compile(kShader, sizeof kShader - 1, "invizent-overlay", nullptr, nullptr, entry, target,
                                   D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob, &errors))) {
    const auto* p = static_cast<const uint8_t*>(blob->GetBufferPointer());
    code.assign(p, p + blob->GetBufferSize());
  }
  if (blob) blob->Release();
  if (errors) errors->Release();
  FreeLibrary(dll);  // blobs are released above, before their code goes away
  return code;
}

QuadConstants MakeConstants(const Rect& r, uint32_t target_w, uint32_t target_h, uint32_t opacity) {
  const float W = static_cast<float>(target_w), H = static_cast<float>(target_h);
  QuadConstants c{};
  c.rect[0] = r.x / W * 2.f - 1.f;
  c.rect[1] = 1.f - r.y / H * 2.f;
  c.rect[2] = (r.x + r.w) / W * 2.f - 1.f;
  c.rect[3] = 1.f - (r.y + r.h) / H * 2.f;
  c.opacity = opacity / 255.f;
  return c;
}

DXGI_FORMAT ViewFormat(DXGI_FORMAT f) {
  switch (f) {
    case DXGI_FORMAT_R8G8B8A8_TYPELESS: return DXGI_FORMAT_R8G8B8A8_UNORM;
    case DXGI_FORMAT_B8G8R8A8_TYPELESS: return DXGI_FORMAT_B8G8R8A8_UNORM;
    case DXGI_FORMAT_B8G8R8X8_TYPELESS: return DXGI_FORMAT_B8G8R8X8_UNORM;
    case DXGI_FORMAT_R10G10B10A2_TYPELESS: return DXGI_FORMAT_R10G10B10A2_UNORM;
    case DXGI_FORMAT_R16G16B16A16_TYPELESS: return DXGI_FORMAT_R16G16B16A16_FLOAT;
    default: return f;
  }
}

bool IsSrgb(DXGI_FORMAT f) {
  return f == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB || f == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB || f == DXGI_FORMAT_B8G8R8X8_UNORM_SRGB;
}

}  // namespace invz
