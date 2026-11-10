// invizent-overlay-hook.dll — common pieces shared by the D3D11 / D3D12 / OpenGL renderers.
#pragma once
#ifndef UNICODE
#define UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dxgi1_4.h>
#include <atomic>
#include <cstdint>
#include <vector>

#include "../shared.h"

struct ID3D12CommandQueue;

namespace invz {

// One copy of the overlay picture, private to one renderer.
struct Frame {
  uint32_t width = 0, height = 0, corner = 0, opacity = 255, visible = 0, margin = 16;
  std::vector<uint8_t> pixels;  // BGRA, premultiplied alpha, stride = width * 4
};

// Reads the shared mapping written by invizent-overlay-injector.exe --host. Never blocks: the
// lock is only try-locked; when it is busy we simply keep the previous picture for this frame.
class FrameSource {
 public:
  bool Open(const char* suffix);
  void Close();
  // Copies the shared frame into *out when it changed since *seen. Returns true on a new copy.
  bool Poll(uint32_t* seen, bool* have, Frame* out);
  // Tells the host (and so Инвиз) that this process just drew the overlay.
  void MarkDrawn();

 private:
  HANDLE mapping_ = nullptr;
  HANDLE lock_ = nullptr;
  uint8_t* view_ = nullptr;
  std::atomic<DWORD> last_mark_{0};
};
FrameSource& Frames();

// Set by the worker thread before unhooking; renderers free their objects on the next frame.
extern std::atomic<bool> g_teardown;

struct Rect { int x, y, w, h; };
// Where the picture goes on a target of target_w × target_h. False: nothing to draw.
bool Place(const Frame& f, uint32_t target_w, uint32_t target_h, Rect* r);
// Draw only into the window the person is looking at (not a launcher or tool window).
bool IsForeground(HWND w);

// HLSL for both D3D backends; compiled at runtime with d3dcompiler_47 (part of Windows 10/11).
std::vector<uint8_t> CompileShader(const char* entry, const char* target);
// rect (NDC x0,y0,x1,y1) + opacity, as constants for the shader.
struct QuadConstants { float rect[4]; float opacity; float pad[3]; };
QuadConstants MakeConstants(const Rect& r, uint32_t target_w, uint32_t target_h, uint32_t opacity);

DXGI_FORMAT ViewFormat(DXGI_FORMAT f);  // typeless back buffer → a format a view can use
bool IsSrgb(DXGI_FORMAT f);

// Renderers. On*() run on the game's presenting thread inside our hooks; Teardown*() too.
void D3D11Present(IDXGISwapChain* swap_chain);
void D3D11Teardown();
bool D3D12Present(IDXGISwapChain* swap_chain);  // false: not a D3D12 swap chain
void D3D12SawQueue(ID3D12CommandQueue* queue);
void D3D12Teardown();
void GLSwap(HDC dc);
void GLTeardown();

}  // namespace invz
