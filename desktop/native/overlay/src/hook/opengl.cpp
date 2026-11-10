// OpenGL: before the game's wglSwapBuffers we switch, on the same window DC, to a small GL
// context of our own, draw one textured quad into the back buffer, and switch back to the game's
// context. Our context has its own state, so none of the game's GL state is touched.
// All GL entry points come from the opengl32.dll the game already loaded (no import of our own).
#include "overlay.h"

#include <GL/gl.h>

#ifndef GL_BGRA_EXT
#define GL_BGRA_EXT 0x80E1
#endif
#ifndef GL_CLAMP_TO_EDGE
#define GL_CLAMP_TO_EDGE 0x812F
#endif

namespace invz {
namespace {

struct GL {
  HGLRC(WINAPI* CreateContext)(HDC);
  BOOL(WINAPI* DeleteContext)(HGLRC);
  BOOL(WINAPI* MakeCurrent)(HDC, HGLRC);
  HGLRC(WINAPI* GetCurrentContext)();
  HDC(WINAPI* GetCurrentDC)();
  void(APIENTRY* Viewport)(GLint, GLint, GLsizei, GLsizei);
  void(APIENTRY* MatrixMode)(GLenum);
  void(APIENTRY* LoadIdentity)();
  void(APIENTRY* Ortho)(GLdouble, GLdouble, GLdouble, GLdouble, GLdouble, GLdouble);
  void(APIENTRY* GenTextures)(GLsizei, GLuint*);
  void(APIENTRY* BindTexture)(GLenum, GLuint);
  void(APIENTRY* TexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
  void(APIENTRY* TexSubImage2D)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void*);
  void(APIENTRY* TexParameteri)(GLenum, GLenum, GLint);
  void(APIENTRY* PixelStorei)(GLenum, GLint);
  void(APIENTRY* Enable)(GLenum);
  void(APIENTRY* Disable)(GLenum);
  void(APIENTRY* BlendFunc)(GLenum, GLenum);
  void(APIENTRY* Color4f)(GLfloat, GLfloat, GLfloat, GLfloat);
  void(APIENTRY* Begin)(GLenum);
  void(APIENTRY* End)();
  void(APIENTRY* TexCoord2f)(GLfloat, GLfloat);
  void(APIENTRY* Vertex2f)(GLfloat, GLfloat);
};

template <class F> bool Load(HMODULE m, F& f, const char* name) {
  f = reinterpret_cast<F>(GetProcAddress(m, name));
  return f != nullptr;
}

bool LoadGL(GL* g) {
  HMODULE m = GetModuleHandleW(L"opengl32.dll");
  return m && Load(m, g->CreateContext, "wglCreateContext") && Load(m, g->DeleteContext, "wglDeleteContext") &&
         Load(m, g->MakeCurrent, "wglMakeCurrent") && Load(m, g->GetCurrentContext, "wglGetCurrentContext") &&
         Load(m, g->GetCurrentDC, "wglGetCurrentDC") && Load(m, g->Viewport, "glViewport") &&
         Load(m, g->MatrixMode, "glMatrixMode") && Load(m, g->LoadIdentity, "glLoadIdentity") &&
         Load(m, g->Ortho, "glOrtho") && Load(m, g->GenTextures, "glGenTextures") &&
         Load(m, g->BindTexture, "glBindTexture") && Load(m, g->TexImage2D, "glTexImage2D") &&
         Load(m, g->TexSubImage2D, "glTexSubImage2D") && Load(m, g->TexParameteri, "glTexParameteri") &&
         Load(m, g->PixelStorei, "glPixelStorei") && Load(m, g->Enable, "glEnable") && Load(m, g->Disable, "glDisable") &&
         Load(m, g->BlendFunc, "glBlendFunc") && Load(m, g->Color4f, "glColor4f") && Load(m, g->Begin, "glBegin") &&
         Load(m, g->End, "glEnd") && Load(m, g->TexCoord2f, "glTexCoord2f") && Load(m, g->Vertex2f, "glVertex2f");
}

// Power-of-two texture big enough for the largest picture (GL 1.1 compatible).
constexpr GLsizei kTexW = 512, kTexH = 1024;
static_assert(kTexW >= GLsizei(kMaxWidth) && kTexH >= GLsizei(kMaxHeight), "texture too small");

struct GLRenderer {
  GL gl{};
  bool loaded = false, failed = false;
  HDC dc = nullptr;
  HGLRC context = nullptr;
  GLuint texture = 0;
  bool tex_dirty = true;
  Frame frame;
  uint32_t seen = 0;
  bool have = false;

  void Release() {
    if (context) gl.DeleteContext(context);  // also frees the texture
    context = nullptr;
    dc = nullptr;
    texture = 0;
    tex_dirty = true;
  }

  void Swap(HDC target) {
    if (failed) return;
    if (!loaded && !(loaded = LoadGL(&gl))) { failed = true; return; }
    if (Frames().Poll(&seen, &have, &frame)) tex_dirty = true;
    HWND window = WindowFromDC(target);
    RECT rc{};
    if (!window || !IsForeground(window) || !GetClientRect(window, &rc)) return;
    const uint32_t W = uint32_t(rc.right - rc.left), H = uint32_t(rc.bottom - rc.top);
    Rect r{};
    if (!Place(frame, W, H, &r)) return;

    const HGLRC game_context = gl.GetCurrentContext();
    const HDC game_dc = gl.GetCurrentDC();
    if (dc != target) {
      Release();
      context = gl.CreateContext(target);  // same pixel format as the game's window
      if (!context) { failed = true; return; }
      dc = target;
    }
    if (!gl.MakeCurrent(target, context)) { gl.MakeCurrent(game_dc, game_context); return; }
    if (!texture) {
      gl.GenTextures(1, &texture);
      gl.BindTexture(GL_TEXTURE_2D, texture);
      gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
      gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
      gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
      gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, kTexW, kTexH, 0, GL_BGRA_EXT, GL_UNSIGNED_BYTE, nullptr);
      tex_dirty = true;
    }
    gl.BindTexture(GL_TEXTURE_2D, texture);
    if (tex_dirty) {
      gl.PixelStorei(GL_UNPACK_ALIGNMENT, 4);
      gl.TexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, frame.width, frame.height, GL_BGRA_EXT, GL_UNSIGNED_BYTE, frame.pixels.data());
      tex_dirty = false;
    }
    gl.Viewport(0, 0, GLsizei(W), GLsizei(H));
    gl.MatrixMode(GL_PROJECTION);
    gl.LoadIdentity();
    gl.Ortho(0, W, H, 0, -1, 1);  // pixels, origin top-left
    gl.MatrixMode(GL_MODELVIEW);
    gl.LoadIdentity();
    gl.Disable(GL_DEPTH_TEST);
    gl.Disable(GL_CULL_FACE);
    gl.Enable(GL_TEXTURE_2D);
    gl.Enable(GL_BLEND);
    gl.BlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);  // premultiplied alpha
    const float a = frame.opacity / 255.f;
    gl.Color4f(a, a, a, a);
    const float u = float(frame.width) / kTexW, v = float(frame.height) / kTexH;
    const float x0 = float(r.x), y0 = float(r.y), x1 = float(r.x + r.w), y1 = float(r.y + r.h);
    gl.Begin(GL_QUADS);
    gl.TexCoord2f(0, 0); gl.Vertex2f(x0, y0);
    gl.TexCoord2f(u, 0); gl.Vertex2f(x1, y0);
    gl.TexCoord2f(u, v); gl.Vertex2f(x1, y1);
    gl.TexCoord2f(0, v); gl.Vertex2f(x0, y1);
    gl.End();
    gl.MakeCurrent(game_dc, game_context);  // back to exactly what the game had (may be none)
    Frames().MarkDrawn();
  }
};

GLRenderer* g_renderer = nullptr;
SRWLOCK g_lock = SRWLOCK_INIT;

}  // namespace

void GLSwap(HDC dc) {
  if (!TryAcquireSRWLockExclusive(&g_lock)) return;
  if (!g_renderer) g_renderer = new GLRenderer();
  g_renderer->Swap(dc);
  ReleaseSRWLockExclusive(&g_lock);
}

void GLTeardown() {
  if (!TryAcquireSRWLockExclusive(&g_lock)) return;
  if (g_renderer) {
    if (g_renderer->context && g_renderer->gl.GetCurrentContext() == g_renderer->context)
      g_renderer->gl.MakeCurrent(nullptr, nullptr);
    g_renderer->Release();
    delete g_renderer;
    g_renderer = nullptr;
  }
  ReleaseSRWLockExclusive(&g_lock);
}

}  // namespace invz
