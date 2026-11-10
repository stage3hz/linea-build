# In-game overlay for fullscreen games (Windows x64)

Option: **Настройки → Оверлей → «Показывать в полноэкранных играх (внедрение в игру)»** — on
together with the overlay, can be switched off. Like Discord, Steam or OBS game capture, the
voice overlay is drawn by the game itself, so it is also visible in exclusive fullscreen.
Exclusive and borderless fullscreen are handled the same way.

## Pieces

| File | What it does |
| --- | --- |
| `src/shared.h` | Shared-memory layout (64-byte header + BGRA pixels, max 400×600) and object names. Mirrored by `desktop/game-overlay.cjs` (`encodeFrame`) and checked by `desktop/test/game-overlay.test.mjs`. |
| `src/injector.cpp` → `invizent-overlay-injector.exe` | `--host <suffix>`: owns the shared memory, takes frames from Инвиз on stdin, reports the foreground window once a second as a JSON line (`pid`, `path`, `fullscreen`, `exclusive`, `wow64`, `elevated`, `drawing`). `--inject <pid>`: loads the hook DLL into that process with `VirtualAllocEx` + `WriteProcessMemory` + `CreateRemoteThread(LoadLibraryW)` and exits with a status code. `--version`. |
| `src/hook/*` → `invizent-overlay-hook.dll` | Hooks `IDXGISwapChain::Present`/`Present1` (D3D11 and D3D12), `ID3D12CommandQueue::ExecuteCommandLists` (to know the D3D12 queue when DXGI does not tell) and `wglSwapBuffers` with MinHook, and draws one textured quad with the game's own device. |

Flow (`desktop/game-overlay.cjs`, driven by `main.cjs`, Windows only):

1. While the overlay and the sub-option are on, Инвиз runs `injector --host <random suffix>`.
   The fixed-name mapping `Local\InvizentOverlay.Config` tells the DLL the suffix and the host
   pid; frames live in `Local\InvizentOverlay.Frame.<suffix>` guarded by the mutex
   `Local\InvizentOverlay.Lock.<suffix>`.
2. While you are in a voice channel, `overlay.html` is rendered offscreen
   (`webPreferences.offscreen`, ≤15 fps, Chromium paints only on change, identical pictures are
   dropped) and each new picture goes to the host.
3. When the foreground window covers its whole monitor for 2 s, belongs to a 64-bit, non-elevated
   process that is not Windows/shell/Инвиз/a browser or player, Инвиз runs
   `injector --inject <pid>` **once** for that process. Any refusal (access denied, protected
   process, anti-cheat, 32-bit, elevated) is logged and never retried.
4. The DLL writes its pid and a timestamp into the header each time it draws. The host reports
   that as `"drawing": true`; while it is true the transparent window overlay hides, so the two
   never show at once. Injection refused, Vulkan game, or no frame drawn within ~2 s → the window
   overlay stays (it works over borderless games).
5. Switching the option off or quitting Инвиз ends the host; every loaded DLL sees the host
   process exit, frees its GPU objects on the game's render thread, unhooks, waits until no game
   thread is inside its code and unloads itself (`FreeLibraryAndExitThread`).

## What it does not do

No anti-cheat or antivirus evasion of any kind: no manual mapping, the module is not hidden or
unlinked from module lists, nothing is obfuscated, no kernel components, protections and integrity
checks are left alone. Only the documented `LoadLibraryW` path, with exactly the access rights
`CreateRemoteThread` documents. No input is taken; the game's thread is never blocked (the frame
lock is only try-locked; the D3D12 path skips a frame rather than wait for the GPU). A fault inside
our drawing code disables the overlay in that process instead of crashing the game.

## Build (MSVC, x64)

Needs Visual Studio 2022 (C++ workload, Windows 10/11 SDK) and CMake ≥ 3.24. MinHook 1.3.4 is
fetched by CMake at a pinned commit (`c3fcafdc…`, tag v1.3.4) — network needed once.

```powershell
cmake -S desktop/native/overlay -B desktop/native/overlay/build -G "Visual Studio 17 2022" -A x64
cmake --build desktop/native/overlay/build --config Release
desktop\native\overlay\out\invizent-overlay-injector.exe --version
```

Outputs go to `desktop/native/overlay/out/` (`invizent-overlay-hook.dll`,
`invizent-overlay-injector.exe`, `MinHook-LICENSE.txt`). `electron-builder` copies them to
`resources/overlay/` (`package.json` → `build.extraResources`). In development (`npm start`)
`main.cjs` looks in `native/overlay/out/`; without the files the feature quietly stays off and the
window overlay is used. CI: `.github/workflows/windows-desktop.yml`, step «Build in-game overlay».

## Known limits

- Vulkan (`vkQueuePresentKHR`) is not hooked: such games keep the window overlay (borderless only).
- D3D12: the presenting queue is taken from the swap chain when DXGI exposes it, otherwise the
  first direct queue the game submits on; engines with several direct queues may not get the
  overlay (no harm, the window overlay stays).
- D3D9/D3D10, 32-bit games, UWP/AppContainer games and games run as administrator: not supported.
- HDR (FP16 scRGB) back buffers show the overlay at SDR brightness.
- Not code-signed: Windows Defender / SmartScreen may look harder at an unsigned
  `CreateRemoteThread` helper; anti-cheats (EAC, BattlEye, Vanguard, …) may refuse the handle or
  flag the module, as they do for other overlays.
