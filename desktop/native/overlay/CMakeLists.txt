# In-game overlay for Windows (x64 only): invizent-overlay-hook.dll + invizent-overlay-injector.exe.
# Built by .github/workflows/windows-desktop.yml before electron-builder; see README.md.
#   cmake -S desktop/native/overlay -B desktop/native/overlay/build -A x64
#   cmake --build desktop/native/overlay/build --config Release
# Outputs (plus MinHook's licence) land in desktop/native/overlay/out/, which electron-builder
# packages as resources/overlay/ (package.json → build.extraResources).
cmake_minimum_required(VERSION 3.24)
project(invizent_overlay LANGUAGES C CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "The in-game overlay is built with MSVC for Windows x64 only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the DLL must not depend on whichever VC++ runtime the game ships (or not).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# MinHook 1.3.4 (BSD 2-Clause), pinned to the release tag's commit. Only its sources are used;
# its own CMakeLists (install rules) is not added (SOURCE_SUBDIR points at a missing folder).
include(FetchContent)
FetchContent_Declare(minhook
  GIT_REPOSITORY https://github.com/TsudaKageyu/minhook.git
  GIT_TAG c3fcafdc10146beb5919319d0683e44e3c30d537 # v1.3.4
  SOURCE_SUBDIR do-not-add)
FetchContent_MakeAvailable(minhook)
add_library(minhook STATIC
  ${minhook_SOURCE_DIR}/src/buffer.c
  ${minhook_SOURCE_DIR}/src/hook.c
  ${minhook_SOURCE_DIR}/src/trampoline.c
  ${minhook_SOURCE_DIR}/src/hde/hde64.c)
target_include_directories(minhook PUBLIC ${minhook_SOURCE_DIR}/include PRIVATE ${minhook_SOURCE_DIR}/src)

set(OUT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/out)
add_compile_definitions(UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 WINVER=0x0A00)
add_compile_options(/W4 /permissive- /utf-8 /guard:cf)

# The hook DLL imports only kernel32/user32: d3d11, d3d12, dxgi, opengl32 and d3dcompiler are
# looked up at runtime in the game's already loaded modules, so a D3D11 game never gets d3d12.dll.
add_library(invizent-overlay-hook SHARED
  src/hook/dllmain.cpp
  src/hook/overlay.cpp
  src/hook/d3d11.cpp
  src/hook/d3d12.cpp
  src/hook/opengl.cpp)
target_link_libraries(invizent-overlay-hook PRIVATE minhook user32)
target_link_options(invizent-overlay-hook PRIVATE /guard:cf /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT)

add_executable(invizent-overlay-injector src/injector.cpp)
target_link_libraries(invizent-overlay-injector PRIVATE psapi shell32 user32 advapi32)
target_link_options(invizent-overlay-injector PRIVATE /guard:cf /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT)

foreach(t invizent-overlay-hook invizent-overlay-injector)
  set_target_properties(${t} PROPERTIES OUTPUT_NAME ${t})
  add_custom_command(TARGET ${t} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${OUT_DIR}
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:${t}> ${OUT_DIR}/)
endforeach()
file(MAKE_DIRECTORY ${OUT_DIR})
file(COPY_FILE ${minhook_SOURCE_DIR}/LICENSE.txt ${OUT_DIR}/MinHook-LICENSE.txt ONLY_IF_DIFFERENT)
