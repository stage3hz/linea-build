// invizent-overlay-injector.exe — small helper that Инвиз (Electron) starts. Two modes:
//
//   --host <suffix>   Long-lived while the in-game overlay option is on. Owns the shared memory the
//                     DLL reads (see shared.h): reads frames from stdin (64-byte header + BGRA
//                     pixels, as encoded by desktop/game-overlay.cjs) and copies them into the
//                     mapping. Once a second prints one JSON line about the foreground window:
//                     {"type":"fg","pid":..,"path":"..","fullscreen":..,"exclusive":..,
//                      "wow64":..,"elevated":..,"drawing":..}
//                     Exits when stdin closes (Инвиз quit or switched the option off).
//
//   --inject <pid>    One-shot: loads invizent-overlay-hook.dll (always the copy next to this
//                     exe; no other path is accepted) into process <pid> with the plain,
//                     documented method: VirtualAllocEx + WriteProcessMemory + CreateRemoteThread
//                     (LoadLibraryW). Prints {"type":"inject",...} and exits with a status code
//                     (InjectCode below). No retries, no evasion: if Windows or the game refuses,
//                     we report it and Инвиз keeps its normal window overlay.
//
//   --version         Prints {"type":"version","version":1}.
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
#include <psapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <algorithm>
#include <atomic>
#include <iterator>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#include "shared.h"

namespace {

enum InjectCode : int {
  kOk = 0,
  kUsage = 1,
  kBadPid = 2,
  kDllMissing = 3,
  kArchMismatch = 4,   // 32-bit game: this x64 helper does not inject into it
  kElevated = 5,       // game runs elevated (or higher integrity) and we do not
  kAccessDenied = 6,   // OpenProcess refused (protected process, anti-cheat, other user)
  kOpenFailed = 7,
  kWriteFailed = 8,    // VirtualAllocEx / WriteProcessMemory refused
  kThreadFailed = 9,   // CreateRemoteThread refused
  kTimeout = 10,       // LoadLibraryW did not return within 10 s
  kLoadFailed = 11,    // LoadLibraryW ran but the DLL is not loaded (blocked / failed)
  kAlreadyLoaded = 12,
};

// ---------- small output helpers (UTF-8 JSON lines on stdout) ----------
void WriteLine(const std::string& line) {
  static HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  std::string s = line + "\n";
  DWORD written = 0;
  WriteFile(out, s.data(), static_cast<DWORD>(s.size()), &written, nullptr);
}

std::string Utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

std::string JsonString(const std::string& s) {
  std::string r = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { r += '\\'; r += static_cast<char>(c); }
    else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); r += b; }
    else r += static_cast<char>(c);
  }
  return r + "\"";
}

const char* Tri(int v) { return v < 0 ? "null" : (v ? "true" : "false"); }

// ---------- process facts ----------
// 1 elevated, 0 not, -1 unknown (token not readable: treat as "not ours to touch").
int IsElevated(HANDLE process) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return -1;
  TOKEN_ELEVATION e{};
  DWORD len = 0;
  const BOOL ok = GetTokenInformation(token, TokenElevation, &e, sizeof e, &len);
  CloseHandle(token);
  return ok ? (e.TokenIsElevated ? 1 : 0) : -1;
}

bool SelfElevated() {
  static const int v = IsElevated(GetCurrentProcess());
  return v == 1;
}

struct ProcFacts {
  std::wstring path;
  int wow64 = -1;
  int elevated = -1;
};

ProcFacts QueryProcess(DWORD pid) {
  ProcFacts f;
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return f;
  wchar_t buf[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(std::size(buf));
  if (QueryFullProcessImageNameW(p, 0, buf, &size)) f.path.assign(buf, size);
  BOOL wow = FALSE;
  if (IsWow64Process(p, &wow)) f.wow64 = wow ? 1 : 0;
  f.elevated = IsElevated(p);
  CloseHandle(p);
  return f;
}

std::wstring HookDllPath() {
  wchar_t self[MAX_PATH * 2];
  const DWORD n = GetModuleFileNameW(nullptr, self, static_cast<DWORD>(std::size(self)));
  if (n == 0 || n >= std::size(self)) return {};
  std::wstring path(self, n);
  const size_t slash = path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return {};
  return path.substr(0, slash + 1) + L"invizent-overlay-hook.dll";
}

bool ModuleLoaded(HANDLE process, const std::wstring& dll) {
  HMODULE mods[1024];
  DWORD needed = 0;
  if (!EnumProcessModulesEx(process, mods, sizeof mods, &needed, LIST_MODULES_64BIT)) return false;
  const DWORD count = std::min<DWORD>(needed / sizeof(HMODULE), static_cast<DWORD>(std::size(mods)));
  wchar_t name[MAX_PATH * 2];
  for (DWORD i = 0; i < count; ++i) {
    const DWORD len = GetModuleFileNameExW(process, mods[i], name, static_cast<DWORD>(std::size(name)));
    if (len && _wcsicmp(name, dll.c_str()) == 0) return true;
  }
  return false;
}

// ---------- --inject ----------
int Inject(DWORD pid, DWORD* win32) {
  *win32 = 0;
  if (pid == 0 || pid == 4 || pid == GetCurrentProcessId()) return kBadPid;
  const std::wstring dll = HookDllPath();
  if (dll.empty() || GetFileAttributesW(dll.c_str()) == INVALID_FILE_ATTRIBUTES) return kDllMissing;

  const ProcFacts facts = QueryProcess(pid);
  if (facts.wow64 != 0) return facts.wow64 == 1 ? kArchMismatch : kAccessDenied;
  if (!SelfElevated() && facts.elevated != 0) return kElevated;

  // Exactly the rights CreateRemoteThread documents, plus SYNCHRONIZE. Nothing more.
  const DWORD rights = PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
                       PROCESS_VM_WRITE | PROCESS_VM_READ | SYNCHRONIZE;
  HANDLE process = OpenProcess(rights, FALSE, pid);
  if (!process) {
    *win32 = GetLastError();
    return *win32 == ERROR_ACCESS_DENIED ? kAccessDenied : kOpenFailed;
  }
  if (ModuleLoaded(process, dll)) { CloseHandle(process); return kAlreadyLoaded; }

  const SIZE_T bytes = (dll.size() + 1) * sizeof(wchar_t);
  void* remote = VirtualAllocEx(process, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!remote) { *win32 = GetLastError(); CloseHandle(process); return kWriteFailed; }
  SIZE_T written = 0;
  if (!WriteProcessMemory(process, remote, dll.c_str(), bytes, &written) || written != bytes) {
    *win32 = GetLastError();
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    CloseHandle(process);
    return kWriteFailed;
  }
  // kernel32 is mapped at the same address in every process of the same architecture for the
  // current boot, so our LoadLibraryW address is valid in the target too (documented behaviour
  // CreateRemoteThread+LoadLibrary relies on).
  auto* load = reinterpret_cast<LPTHREAD_START_ROUTINE>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW"));
  HANDLE thread = load ? CreateRemoteThread(process, nullptr, 0, load, remote, 0, nullptr) : nullptr;
  if (!thread) {
    *win32 = GetLastError();
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    CloseHandle(process);
    return kThreadFailed;
  }
  const DWORD wait = WaitForSingleObject(thread, 10000);
  CloseHandle(thread);
  if (wait != WAIT_OBJECT_0) {
    // The thread may still read the path: leave those few bytes allocated.
    CloseHandle(process);
    return kTimeout;
  }
  VirtualFreeEx(process, remote, 0, MEM_RELEASE);
  const bool loaded = ModuleLoaded(process, dll);
  CloseHandle(process);
  return loaded ? kOk : kLoadFailed;
}

// ---------- --host ----------
HANDLE g_lock = nullptr;
invz::FrameHeader* g_header = nullptr;
std::atomic<bool> g_quit{false};
std::atomic<bool> g_protocol_error{false};

bool ReadExact(HANDLE in, void* dst, DWORD n) {
  auto* p = static_cast<uint8_t*>(dst);
  while (n) {
    DWORD got = 0;
    if (!ReadFile(in, p, n, &got, nullptr) || got == 0) return false;
    p += got;
    n -= got;
  }
  return true;
}

DWORD WINAPI StdinThread(void*) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<uint8_t> pixels;
  pixels.reserve(invz::kMaxWidth * invz::kMaxHeight * 4);
  for (;;) {
    invz::FrameHeader h{};
    if (!ReadExact(in, &h, sizeof h)) break;
    if (!invz::ValidHeader(h)) { g_protocol_error = true; break; }
    const DWORD bytes = h.stride * h.height;
    pixels.resize(bytes);
    if (bytes && !ReadExact(in, pixels.data(), bytes)) break;
    // The DLL only ever try-locks, so this wait is short; it is bounded anyway so a hung game
    // holding the lock cannot stop us from noticing that stdin closed.
    DWORD w = WAIT_TIMEOUT;
    while (!g_quit && (w = WaitForSingleObject(g_lock, 500)) == WAIT_TIMEOUT) {}
    if (w != WAIT_OBJECT_0 && w != WAIT_ABANDONED) break;
    uint8_t* dst = reinterpret_cast<uint8_t*>(g_header) + invz::kHeaderSize;
    if (bytes) std::memcpy(dst, pixels.data(), bytes);
    g_header->width = h.width;
    g_header->height = h.height;
    g_header->stride = h.stride;
    g_header->corner = h.corner;
    g_header->opacity = h.opacity;
    g_header->visible = h.visible;
    g_header->margin = h.margin;
    g_header->frame = g_header->frame + 1;  // ours, not the sender's: always moves forward
    ReleaseMutex(g_lock);
  }
  g_quit = true;
  return 0;
}

bool IsShellWindow(HWND w) {
  if (w == GetShellWindow() || w == GetDesktopWindow()) return true;
  wchar_t cls[64] = {};
  GetClassNameW(w, cls, static_cast<int>(std::size(cls)));
  return wcscmp(cls, L"Progman") == 0 || wcscmp(cls, L"WorkerW") == 0 || wcscmp(cls, L"Shell_TrayWnd") == 0;
}

void ReportForeground() {
  HWND w = GetForegroundWindow();
  DWORD pid = 0;
  if (w) GetWindowThreadProcessId(w, &pid);
  bool covers = false;
  if (w && pid && IsWindowVisible(w) && !IsIconic(w) && !IsShellWindow(w)) {
    RECT r{};
    MONITORINFO mi{sizeof mi};
    HMONITOR m = MonitorFromWindow(w, MONITOR_DEFAULTTONEAREST);
    if (GetWindowRect(w, &r) && m && GetMonitorInfoW(m, &mi)) {
      const RECT& s = mi.rcMonitor;
      // Exclusive and borderless fullscreen alike: the window covers the whole monitor.
      covers = r.left <= s.left && r.top <= s.top && r.right >= s.right && r.bottom >= s.bottom;
    }
  }
  QUERY_USER_NOTIFICATION_STATE q{};
  const bool exclusive = pid && SUCCEEDED(SHQueryUserNotificationState(&q)) && q == QUNS_RUNNING_D3D_FULL_SCREEN;
  const ProcFacts f = pid ? QueryProcess(pid) : ProcFacts{};
  const uint32_t drawer = *reinterpret_cast<volatile uint32_t*>(&g_header->consumer_pid);
  const uint32_t age = GetTickCount() - *reinterpret_cast<volatile uint32_t*>(&g_header->consumer_tick);
  const bool drawing = pid && drawer == pid && age < 2000;
  char head[160];
  std::snprintf(head, sizeof head, "{\"type\":\"fg\",\"pid\":%lu,\"fullscreen\":%s,\"exclusive\":%s,\"wow64\":%s,\"elevated\":%s,\"drawing\":%s,\"path\":",
                static_cast<unsigned long>(pid), (covers || exclusive) ? "true" : "false", exclusive ? "true" : "false",
                Tri(f.wow64), Tri(f.elevated), drawing ? "true" : "false");
  WriteLine(std::string(head) + JsonString(Utf8(f.path)) + "}");
}

void SetDpiAware() {
  // Physical pixels, so window and monitor rectangles compare correctly at any scaling.
  using Fn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  auto fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
  if (!fn || !fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) SetProcessDPIAware();
}

int Host(const char* suffix) {
  if (std::strlen(suffix) != invz::kSuffixLen || !invz::ValidSuffix(suffix)) return kUsage;
  SetDpiAware();
  wchar_t frame_name[96], lock_name[96];
  std::swprintf(frame_name, std::size(frame_name), L"Local\\InvizentOverlay.Frame.%hs", suffix);
  std::swprintf(lock_name, std::size(lock_name), L"Local\\InvizentOverlay.Lock.%hs", suffix);

  HANDLE config = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(invz::ConfigBlock), invz::ConfigName());
  if (!config || GetLastError() == ERROR_ALREADY_EXISTS) {
    WriteLine("{\"type\":\"error\",\"code\":\"config-exists\"}");
    return 20;
  }
  HANDLE frame = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, invz::kFrameMappingSize, frame_name);
  if (!frame || GetLastError() == ERROR_ALREADY_EXISTS) { WriteLine("{\"type\":\"error\",\"code\":\"frame-exists\"}"); return 21; }
  g_lock = CreateMutexW(nullptr, FALSE, lock_name);
  if (!g_lock || GetLastError() == ERROR_ALREADY_EXISTS) { WriteLine("{\"type\":\"error\",\"code\":\"lock-exists\"}"); return 22; }
  auto* cfg = static_cast<invz::ConfigBlock*>(MapViewOfFile(config, FILE_MAP_WRITE, 0, 0, sizeof(invz::ConfigBlock)));
  g_header = static_cast<invz::FrameHeader*>(MapViewOfFile(frame, FILE_MAP_WRITE, 0, 0, invz::kFrameMappingSize));
  if (!cfg || !g_header) { WriteLine("{\"type\":\"error\",\"code\":\"map-failed\"}"); return 23; }

  g_header->magic = invz::kFrameMagic;
  g_header->version = invz::kVersion;
  std::memcpy(cfg->suffix, suffix, invz::kSuffixLen + 1);
  cfg->host_pid = GetCurrentProcessId();
  cfg->version = invz::kVersion;
  MemoryBarrier();
  cfg->magic = invz::kConfigMagic;

  HANDLE reader = CreateThread(nullptr, 0, StdinThread, nullptr, 0, nullptr);
  if (!reader) return 24;
  WriteLine("{\"type\":\"ready\",\"version\":1}");
  while (!g_quit) {
    ReportForeground();
    WaitForSingleObject(reader, 1000);
  }
  if (g_protocol_error) WriteLine("{\"type\":\"error\",\"code\":\"protocol\"}");
  cfg->magic = 0;  // DLLs also watch our process handle and unload when we exit
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--version") == 0) {
    WriteLine("{\"type\":\"version\",\"version\":1}");
    return 0;
  }
  if (argc == 3 && wcscmp(argv[1], L"--host") == 0) {
    char suffix[invz::kSuffixLen + 2] = {};
    if (wcslen(argv[2]) != invz::kSuffixLen) return kUsage;
    for (size_t i = 0; i < invz::kSuffixLen; ++i) suffix[i] = argv[2][i] < 128 ? static_cast<char>(argv[2][i]) : '?';
    return Host(suffix);
  }
  if (argc == 3 && wcscmp(argv[1], L"--inject") == 0) {
    wchar_t* end = nullptr;
    const unsigned long pid = wcstoul(argv[2], &end, 10);
    if (!end || *end != L'\0') return kUsage;
    DWORD win32 = 0;
    const int code = Inject(static_cast<DWORD>(pid), &win32);
    char line[128];
    std::snprintf(line, sizeof line, "{\"type\":\"inject\",\"pid\":%lu,\"code\":%d,\"win32\":%lu}", pid, code, static_cast<unsigned long>(win32));
    WriteLine(line);
    return code;
  }
  WriteLine("{\"type\":\"error\",\"code\":\"usage\"}");
  return kUsage;
}
