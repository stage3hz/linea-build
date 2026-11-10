// D3D11: draws the overlay quad on the game's own device, just before the game's Present.
// The game's pipeline state is preserved with ID3D11DeviceContext1::SwapDeviceContextState: we
// switch to our own state object, draw, and switch back — every binding the game had (shaders,
// targets, viewports, blend, …) comes back exactly as it was.
#include "overlay.h"

#include <d3d11_1.h>
#include <climits>
#include <cstring>

namespace invz {
namespace {

template <class T> void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

struct D3D11Renderer {
  ID3D11Device* device = nullptr;            // AddRef'd: identifies "same device as last frame"
  ID3D11DeviceContext1* context = nullptr;   // immediate context
  ID3DDeviceContextState* state = nullptr;   // our private pipeline state
  ID3D11VertexShader* vs = nullptr;
  ID3D11PixelShader* ps = nullptr;
  ID3D11Buffer* constants = nullptr;
  ID3D11SamplerState* sampler = nullptr;
  ID3D11BlendState* blend = nullptr;
  ID3D11RasterizerState* raster = nullptr;
  ID3D11DepthStencilState* depth = nullptr;
  ID3D11Texture2D* texture = nullptr;
  ID3D11ShaderResourceView* srv = nullptr;
  uint32_t tex_w = 0, tex_h = 0;
  bool tex_srgb = false, tex_dirty = true;
  Frame frame;
  uint32_t seen = 0;
  bool have = false;

  ~D3D11Renderer() {
    SafeRelease(srv); SafeRelease(texture); SafeRelease(depth); SafeRelease(raster); SafeRelease(blend);
    SafeRelease(sampler); SafeRelease(constants); SafeRelease(ps); SafeRelease(vs); SafeRelease(state);
    SafeRelease(context); SafeRelease(device);
  }

  bool Init(ID3D11Device* dev) {
    device = dev;
    device->AddRef();
    if (device->GetFeatureLevel() < D3D_FEATURE_LEVEL_10_0) return false;
    ID3D11Device1* dev1 = nullptr;
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&dev1)))) return false;  // needs D3D 11.1 (Windows 8+)
    ID3D11DeviceContext* ctx = nullptr;
    device->GetImmediateContext(&ctx);
    const HRESULT qi = ctx->QueryInterface(IID_PPV_ARGS(&context));
    ctx->Release();
    const D3D_FEATURE_LEVEL level = device->GetFeatureLevel();
    const UINT flags = (device->GetCreationFlags() & D3D11_CREATE_DEVICE_SINGLETHREADED) ? D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED : 0;
    const HRESULT st = SUCCEEDED(qi) ? dev1->CreateDeviceContextState(flags, &level, 1, D3D11_SDK_VERSION, __uuidof(ID3D11Device1), nullptr, &state) : E_FAIL;
    dev1->Release();
    if (FAILED(st)) return false;

    const std::vector<uint8_t> vs_code = CompileShader("VSMain", "vs_4_0");
    const std::vector<uint8_t> ps_code = CompileShader("PSMain", "ps_4_0");
    if (vs_code.empty() || ps_code.empty()) return false;
    if (FAILED(device->CreateVertexShader(vs_code.data(), vs_code.size(), nullptr, &vs))) return false;
    if (FAILED(device->CreatePixelShader(ps_code.data(), ps_code.size(), nullptr, &ps))) return false;

    D3D11_BUFFER_DESC cb{};
    cb.ByteWidth = sizeof(QuadConstants);
    cb.Usage = D3D11_USAGE_DEFAULT;
    cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    if (FAILED(device->CreateBuffer(&cb, nullptr, &constants))) return false;

    D3D11_SAMPLER_DESC sd{};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;  // 1:1 pixels
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MaxLOD = D3D11_FLOAT32_MAX;
    if (FAILED(device->CreateSamplerState(&sd, &sampler))) return false;

    D3D11_BLEND_DESC bd{};
    auto& rt = bd.RenderTarget[0];
    rt.BlendEnable = TRUE;  // premultiplied alpha
    rt.SrcBlend = rt.SrcBlendAlpha = D3D11_BLEND_ONE;
    rt.DestBlend = rt.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    rt.BlendOp = rt.BlendOpAlpha = D3D11_BLEND_OP_ADD;
    rt.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    if (FAILED(device->CreateBlendState(&bd, &blend))) return false;

    D3D11_RASTERIZER_DESC rd{};
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;
    rd.DepthClipEnable = TRUE;
    if (FAILED(device->CreateRasterizerState(&rd, &raster))) return false;

    D3D11_DEPTH_STENCIL_DESC dd{};
    dd.DepthEnable = FALSE;
    dd.StencilEnable = FALSE;
    return SUCCEEDED(device->CreateDepthStencilState(&dd, &depth));
  }

  bool UpdateTexture(bool srgb) {
    if (!tex_dirty && texture && tex_srgb == srgb) return true;
    if (!texture || tex_w != frame.width || tex_h != frame.height || tex_srgb != srgb) {
      SafeRelease(srv);
      SafeRelease(texture);
      D3D11_TEXTURE2D_DESC td{};
      td.Width = frame.width;
      td.Height = frame.height;
      td.MipLevels = td.ArraySize = 1;
      td.Format = srgb ? DXGI_FORMAT_B8G8R8A8_UNORM_SRGB : DXGI_FORMAT_B8G8R8A8_UNORM;
      td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_DYNAMIC;
      td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      td.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
      if (FAILED(device->CreateTexture2D(&td, nullptr, &texture))) return false;
      if (FAILED(device->CreateShaderResourceView(texture, nullptr, &srv))) { SafeRelease(texture); return false; }
      tex_w = frame.width;
      tex_h = frame.height;
      tex_srgb = srgb;
    }
    D3D11_MAPPED_SUBRESOURCE m{};
    if (FAILED(context->Map(texture, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) return false;
    const size_t row = size_t(frame.width) * 4;
    for (uint32_t y = 0; y < frame.height; ++y)
      memcpy(static_cast<uint8_t*>(m.pData) + size_t(y) * m.RowPitch, frame.pixels.data() + y * row, row);
    context->Unmap(texture, 0);
    tex_dirty = false;
    return true;
  }

  void Draw(IDXGISwapChain* sc) {
    if (Frames().Poll(&seen, &have, &frame)) tex_dirty = true;
    ID3D11Texture2D* back = nullptr;
    if (FAILED(sc->GetBuffer(0, IID_PPV_ARGS(&back)))) return;
    D3D11_TEXTURE2D_DESC bd{};
    back->GetDesc(&bd);
    Rect r{};
    if (bd.SampleDesc.Count != 1 || !Place(frame, bd.Width, bd.Height, &r)) { back->Release(); return; }
    // A view created per frame and released right away: we never keep a reference to the back
    // buffer, so the game's ResizeBuffers is never blocked by us.
    D3D11_RENDER_TARGET_VIEW_DESC vd{};
    vd.Format = ViewFormat(bd.Format);
    vd.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
    ID3D11RenderTargetView* rtv = nullptr;
    const HRESULT hr = device->CreateRenderTargetView(back, &vd, &rtv);
    back->Release();
    if (FAILED(hr) || !UpdateTexture(IsSrgb(vd.Format))) { SafeRelease(rtv); return; }

    ID3DDeviceContextState* game_state = nullptr;
    context->SwapDeviceContextState(state, &game_state);
    const QuadConstants c = MakeConstants(r, bd.Width, bd.Height, frame.opacity);
    context->UpdateSubresource(constants, 0, nullptr, &c, 0, 0);
    D3D11_VIEWPORT vp{0.f, 0.f, float(bd.Width), float(bd.Height), 0.f, 1.f};
    const float factor[4] = {0, 0, 0, 0};
    context->IASetInputLayout(nullptr);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
    context->VSSetShader(vs, nullptr, 0);
    context->VSSetConstantBuffers(0, 1, &constants);
    context->PSSetShader(ps, nullptr, 0);
    context->PSSetConstantBuffers(0, 1, &constants);
    context->PSSetShaderResources(0, 1, &srv);
    context->PSSetSamplers(0, 1, &sampler);
    context->RSSetState(raster);
    context->RSSetViewports(1, &vp);
    context->OMSetBlendState(blend, factor, 0xFFFFFFFF);
    context->OMSetDepthStencilState(depth, 0);
    context->OMSetRenderTargets(1, &rtv, nullptr);
    context->Draw(4, 0);
    // Unbind the back buffer and texture from our state object before leaving it, so it holds
    // no reference to the swap chain's buffers between frames.
    ID3D11RenderTargetView* no_rtv = nullptr;
    ID3D11ShaderResourceView* no_srv = nullptr;
    context->OMSetRenderTargets(1, &no_rtv, nullptr);
    context->PSSetShaderResources(0, 1, &no_srv);
    context->SwapDeviceContextState(game_state, nullptr);
    if (game_state) game_state->Release();
    rtv->Release();
    Frames().MarkDrawn();
  }
};

D3D11Renderer* g_renderer = nullptr;
bool g_unsupported = false;       // init failed once for this device: do not retry every frame
ID3D11Device* g_failed_device = nullptr;  // compared by address only, never dereferenced
SRWLOCK g_lock = SRWLOCK_INIT;

}  // namespace

void D3D11Present(IDXGISwapChain* sc) {
  if (!TryAcquireSRWLockExclusive(&g_lock)) return;  // another thread is drawing: skip, never wait
  ID3D11Device* device = nullptr;
  if (SUCCEEDED(sc->GetDevice(IID_PPV_ARGS(&device)))) {
    if (device->GetDeviceRemovedReason() != S_OK) {
      delete g_renderer;  // device lost: start over once the game recreates its device
      g_renderer = nullptr;
    } else {
      if (g_renderer && g_renderer->device != device) { delete g_renderer; g_renderer = nullptr; }
      if (!g_renderer && !(g_unsupported && g_failed_device == device)) {
        g_renderer = new D3D11Renderer();
        if (!g_renderer->Init(device)) {
          delete g_renderer;
          g_renderer = nullptr;
          g_unsupported = true;
          g_failed_device = device;
        }
      }
      if (g_renderer) g_renderer->Draw(sc);
    }
    device->Release();
  }
  ReleaseSRWLockExclusive(&g_lock);
}

void D3D11Teardown() {
  if (!TryAcquireSRWLockExclusive(&g_lock)) return;
  delete g_renderer;
  g_renderer = nullptr;
  ReleaseSRWLockExclusive(&g_lock);
}

}  // namespace invz
