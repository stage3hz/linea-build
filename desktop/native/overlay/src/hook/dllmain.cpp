// invizent-overlay-hook.dll — loaded into a fullscreen game by invizent-overlay-injector.exe with
// plain LoadLibraryW. Draws Инвиз's voice overlay (who is in the channel, who speaks) on the
// game's frames, the way Discord / Steam / OBS game capture overlays do.
//
// Lifecycle (all from one worker thread; nothing heavy runs under the loader lock in DllMain):
//   1. read Local\InvizentOverlay.Config → session suffix + host pid; open the frame mapping;
//   2. find the addresses of IDXGISwapChain::Present/Present1 (via throwaway D3D11 / D3D12 swap
//      chains on a hidden window), ID3D12CommandQueue::ExecuteCommandLists and wglSwapBuffers,
//      and hook them with MinHook;
//   3. wait until the host process (Инвиз's helper) exits — Инвиз quit or the option was
//      switched off — then free our GPU objects on the game's thread, unhook, wait until no
//      game thread is inside our code, and unload with FreeLibraryAndExitThread.
// The module is an ordinary loaded DLL: visible in module lists, not hidden, not obfuscated.
// We never take input, never block the game's thread (only try-locks), and any fault inside our
// drawing code switches the overlay off for this process instead of crashing the game.
#include "overlay.h"

#include <MinHook.h>
#include <d3d11.h>
#include <d3d12.h>
#include <cstring>

namespace invz {
namespace {

HMODULE g_self = nullptr;
std::atomic<int> g_inside{0};       // game threads currently inside one of our detours
std::atomic<bool> g_broken{false};  // a fault in our code: stop drawing, unload

struct Inside {
  Inside() { ++g_inside; }
  ~Inside() { --g_inside; }
};

using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using Present1Fn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain1*, UINT, UINT, const DXGI_PRESENT_PARAMETERS*);
using ExecuteFn = void(STDMETHODCALLTYPE*)(ID3D12CommandQueue*, UINT, ID3D12CommandList* const*);
using SwapBuffersFn = BOOL(WINAPI*)(HDC);

// Present / Present1 can live at a different address for D3D12 swap chains, so up to two of each.
PresentFn g_present[2] = {};
Present1Fn g_present1[2] = {};
ExecuteFn g_execute = nullptr;
SwapBuffersFn g_swap_buffers = nullptr;

void Teardown() {
  D3D11Teardown();
  D3D12Teardown();
  GLTeardown();
}

void DrawDxgi(IDXGISwapChain* sc, UINT flags) {
  if (flags & DXGI_PRESENT_TEST) return;  // a "can I present?" query, not a frame
  if (g_teardown) { Teardown(); return; }
  DXGI_SWAP_CHAIN_DESC desc{};
  if (FAILED(sc->GetDesc(&desc)) || !IsForeground(desc.OutputWindow)) return;
  if (!D3D12Present(sc)) D3D11Present(sc);
}

void DrawGL(HDC dc) {
  if (g_teardown) { Teardown(); return; }
  GLSwap(dc);
}

// SEH wrappers: no C++ objects with destructors in these frames.
void SafeDrawDxgi(IDXGISwapChain* sc, UINT flags) {
  if (g_broken) return;
  __try { DrawDxgi(sc, flags); } __except (EXCEPTION_EXECUTE_HANDLER) { g_broken = true; }
}
void SafeDrawGL(HDC dc) {
  if (g_broken) return;
  __try { DrawGL(dc); } __except (EXCEPTION_EXECUTE_HANDLER) { g_broken = true; }
}

template <int N>
HRESULT STDMETHODCALLTYPE PresentHook(IDXGISwapChain* sc, UINT sync, UINT flags) {
  Inside in;
  SafeDrawDxgi(sc, flags);
  return g_present[N](sc, sync, flags);
}
template <int N>
HRESULT STDMETHODCALLTYPE Present1Hook(IDXGISwapChain1* sc, UINT sync, UINT flags, const DXGI_PRESENT_PARAMETERS* p) {
  Inside in;
  SafeDrawDxgi(sc, flags);
  return g_present1[N](sc, sync, flags, p);
}
void STDMETHODCALLTYPE ExecuteHook(ID3D12CommandQueue* q, UINT n, ID3D12CommandList* const* lists) {
  Inside in;
  if (!g_teardown && !g_broken) D3D12SawQueue(q);
  g_execute(q, n, lists);
}
BOOL WINAPI SwapBuffersHook(HDC dc) {
  Inside in;
  SafeDrawGL(dc);
  return g_swap_buffers(dc);
}

void* Slot(void* object, int index) { return (*static_cast<void***>(object))[index]; }

// ---- finding the functions to hook ----
struct DummyWindow {
  HWND hwnd = nullptr;
  DummyWindow() {
    WNDCLASSEXW wc{sizeof wc};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = g_self;
    wc.lpszClassName = L"InvizentOverlayProbe";
    RegisterClassExW(&wc);
    hwnd = CreateWindowExW(0, wc.lpszClassName, L"", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, nullptr, nullptr, g_self, nullptr);
  }
  ~DummyWindow() {
    if (hwnd) DestroyWindow(hwnd);
    UnregisterClassW(L"InvizentOverlayProbe", g_self);
  }
};

void ProbeD3D11(HWND hwnd, void** present, void** present1) {
  HMODULE d3d11 = LoadLibraryExW(L"d3d11.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!d3d11) return;
  auto create = reinterpret_cast<PFN_D3D11_CREATE_DEVICE_AND_SWAP_CHAIN>(GetProcAddress(d3d11, "D3D11CreateDeviceAndSwapChain"));
  DXGI_SWAP_CHAIN_DESC sd{};
  sd.BufferCount = 1;
  sd.BufferDesc.Width = sd.BufferDesc.Height = 64;
  sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  sd.OutputWindow = hwnd;
  sd.SampleDesc.Count = 1;
  sd.Windowed = TRUE;
  sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  IDXGISwapChain* sc = nullptr;
  ID3D11Device* dev = nullptr;
  ID3D11DeviceContext* ctx = nullptr;
  for (D3D_DRIVER_TYPE type : {D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP}) {
    if (create && SUCCEEDED(create(nullptr, type, nullptr, 0, levels, 3, D3D11_SDK_VERSION, &sd, &sc, &dev, nullptr, &ctx))) break;
  }
  if (sc) {
    *present = Slot(sc, 8);  // IDXGISwapChain::Present
    IDXGISwapChain1* sc1 = nullptr;
    if (SUCCEEDED(sc->QueryInterface(IID_PPV_ARGS(&sc1)))) { *present1 = Slot(sc1, 22); sc1->Release(); }  // Present1
    sc->Release();
  }
  if (ctx) ctx->Release();
  if (dev) dev->Release();
  FreeLibrary(d3d11);  // the game's own reference (if any) keeps it loaded
}

// Only when the game already uses D3D12: we never pull d3d12.dll into a game that does not.
void ProbeD3D12(HWND hwnd, void** present, void** present1, void** execute) {
  HMODULE d3d12 = GetModuleHandleW(L"d3d12.dll");
  HMODULE dxgi = GetModuleHandleW(L"dxgi.dll");
  if (!d3d12 || !dxgi) return;
  auto create_device = reinterpret_cast<PFN_D3D12_CREATE_DEVICE>(GetProcAddress(d3d12, "D3D12CreateDevice"));
  using CreateFactoryFn = HRESULT(WINAPI*)(REFIID, void**);
  auto create_factory = reinterpret_cast<CreateFactoryFn>(GetProcAddress(dxgi, "CreateDXGIFactory1"));
  ID3D12Device* dev = nullptr;
  ID3D12CommandQueue* queue = nullptr;
  IDXGIFactory2* factory = nullptr;
  IDXGISwapChain1* sc = nullptr;
  D3D12_COMMAND_QUEUE_DESC qd{D3D12_COMMAND_LIST_TYPE_DIRECT};
  if (create_device && create_factory && SUCCEEDED(create_device(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&dev))) &&
      SUCCEEDED(dev->CreateCommandQueue(&qd, IID_PPV_ARGS(&queue)))) {
    *execute = Slot(queue, 10);  // ID3D12CommandQueue::ExecuteCommandLists
    DXGI_SWAP_CHAIN_DESC1 sd{};
    sd.Width = sd.Height = 64;
    sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = 2;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    if (SUCCEEDED(create_factory(IID_PPV_ARGS(&factory))) &&
        SUCCEEDED(factory->CreateSwapChainForHwnd(queue, hwnd, &sd, nullptr, nullptr, &sc))) {
      *present = Slot(sc, 8);
      *present1 = Slot(sc, 22);
    }
  }
  if (sc) sc->Release();
  if (factory) factory->Release();
  if (queue) queue->Release();
  if (dev) dev->Release();
}

bool Hook(void* target, void* detour, void** original) {
  if (!target) return false;
  return MH_CreateHook(target, detour, original) == MH_OK && MH_EnableHook(target) == MH_OK;
}

bool InstallHooks() {
  if (MH_Initialize() != MH_OK) return false;
  bool any = false;
  if (GetModuleHandleW(L"dxgi.dll")) {
    DummyWindow window;
    void* p11 = nullptr; void* q11 = nullptr;
    void* p12 = nullptr; void* q12 = nullptr; void* exec = nullptr;
    if (window.hwnd) {
      ProbeD3D11(window.hwnd, &p11, &q11);
      ProbeD3D12(window.hwnd, &p12, &q12, &exec);
    }
    any |= Hook(p11, reinterpret_cast<void*>(&PresentHook<0>), reinterpret_cast<void**>(&g_present[0]));
    if (p12 != p11) any |= Hook(p12, reinterpret_cast<void*>(&PresentHook<1>), reinterpret_cast<void**>(&g_present[1]));
    Hook(q11, reinterpret_cast<void*>(&Present1Hook<0>), reinterpret_cast<void**>(&g_present1[0]));
    if (q12 != q11) Hook(q12, reinterpret_cast<void*>(&Present1Hook<1>), reinterpret_cast<void**>(&g_present1[1]));
    Hook(exec, reinterpret_cast<void*>(&ExecuteHook), reinterpret_cast<void**>(&g_execute));
  }
  if (HMODULE gl = GetModuleHandleW(L"opengl32.dll"))
    any |= Hook(reinterpret_cast<void*>(GetProcAddress(gl, "wglSwapBuffers")), reinterpret_cast<void*>(&SwapBuffersHook),
                reinterpret_cast<void**>(&g_swap_buffers));
  // Vulkan (vkQueuePresentKHR) is not handled: such games keep Инвиз's window overlay.
  return any;
}

void Uninstall() {
  g_teardown = true;
  // Give the game ~1 s of frames to free our GPU objects on its own render thread.
  Sleep(1000);
  MH_DisableHook(MH_ALL_HOOKS);
  // Never unload while a game thread is still inside a detour (or the original Present it
  // called from there): returning into an unloaded module would crash the game.
  while (g_inside.load() != 0) Sleep(20);
  Sleep(100);  // a thread that just jumped to a detour but has not counted itself yet
  MH_Uninitialize();
}

bool ReadConfig(ConfigBlock* out) {
  HANDLE m = OpenFileMappingW(FILE_MAP_READ, FALSE, ConfigName());
  if (!m) return false;
  const void* view = MapViewOfFile(m, FILE_MAP_READ, 0, 0, sizeof(ConfigBlock));
  bool ok = false;
  if (view) {
    std::memcpy(out, view, sizeof(ConfigBlock));
    UnmapViewOfFile(view);
    ok = out->magic == kConfigMagic && out->version == kVersion && ValidSuffix(out->suffix);
  }
  CloseHandle(m);  // not kept open: a new Инвиз session can create a fresh config
  return ok;
}

DWORD WINAPI Worker(void*) {
  ConfigBlock cfg{};
  HANDLE host = nullptr;
  if (ReadConfig(&cfg) && (host = OpenProcess(SYNCHRONIZE, FALSE, cfg.host_pid)) != nullptr && Frames().Open(cfg.suffix)) {
    const bool hooked = InstallHooks();
    // Stay while the host runs (and nothing went wrong in our code).
    while (hooked && !g_broken && WaitForSingleObject(host, 1000) == WAIT_TIMEOUT) {}
    if (hooked) Uninstall(); else MH_Uninitialize();
    Frames().Close();
  }
  if (host) CloseHandle(host);
  FreeLibraryAndExitThread(g_self, 0);
}

}  // namespace
}  // namespace invz

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    invz::g_self = module;
    DisableThreadLibraryCalls(module);
    if (HANDLE t = CreateThread(nullptr, 0, invz::Worker, nullptr, 0, nullptr)) CloseHandle(t);
  }
  return TRUE;
}
