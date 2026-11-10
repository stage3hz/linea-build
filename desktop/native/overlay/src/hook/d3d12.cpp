// D3D12: records one small command list (texture upload when the picture changed + one quad) and
// submits it on the game's own presenting queue right before Present. D3D12 has no global
// pipeline state to disturb: our list sets everything it uses, and the game's lists are untouched.
// Never waits on the GPU while the game runs: if our previous work is not finished yet, this frame
// is simply drawn without the overlay update (or skipped).
#include "overlay.h"

#include <d3d12.h>
#include <climits>
#include <cstring>

namespace invz {
namespace {

template <class T> void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }
using SerializeRootSignatureFn = HRESULT(WINAPI*)(const D3D12_ROOT_SIGNATURE_DESC*, D3D_ROOT_SIGNATURE_VERSION, ID3DBlob**, ID3DBlob**);
constexpr UINT kSlots = 4;  // command allocators in flight

D3D12_RESOURCE_BARRIER Transition(ID3D12Resource* r, D3D12_RESOURCE_STATES from, D3D12_RESOURCE_STATES to) {
  D3D12_RESOURCE_BARRIER b{};
  b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  b.Transition.pResource = r;
  b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
  b.Transition.StateBefore = from;
  b.Transition.StateAfter = to;
  return b;
}

struct D3D12Renderer {
  ID3D12Device* device = nullptr;
  ID3D12CommandQueue* queue = nullptr;
  ID3D12RootSignature* root = nullptr;
  ID3D12PipelineState* pso = nullptr;
  DXGI_FORMAT pso_format = DXGI_FORMAT_UNKNOWN;
  std::vector<uint8_t> vs_code, ps_code;
  ID3D12DescriptorHeap* rtv_heap = nullptr;
  ID3D12DescriptorHeap* srv_heap = nullptr;
  UINT rtv_step = 0;
  ID3D12CommandAllocator* allocators[kSlots] = {};
  UINT64 slot_fence[kSlots] = {};
  UINT slot = 0;
  ID3D12GraphicsCommandList* list = nullptr;
  ID3D12Fence* fence = nullptr;
  UINT64 fence_value = 0;
  ID3D12Resource* texture = nullptr;
  ID3D12Resource* upload = nullptr;
  uint8_t* upload_ptr = nullptr;
  UINT tex_w = 0, tex_h = 0, upload_pitch = 0;
  bool tex_srgb = false, tex_ready = false, tex_dirty = true;
  Frame frame;
  uint32_t seen = 0;
  bool have = false;

  ~D3D12Renderer() {
    // Our work must be finished before anything is freed. Bounded wait, once, at teardown only.
    if (fence && fence->GetCompletedValue() < fence_value && device->GetDeviceRemovedReason() == S_OK) {
      HANDLE e = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (e && SUCCEEDED(fence->SetEventOnCompletion(fence_value, e))) WaitForSingleObject(e, 500);
      if (e) CloseHandle(e);
    }
    SafeRelease(upload); SafeRelease(texture); SafeRelease(fence); SafeRelease(list);
    for (auto*& a : allocators) SafeRelease(a);
    SafeRelease(srv_heap); SafeRelease(rtv_heap); SafeRelease(pso); SafeRelease(root);
    SafeRelease(queue); SafeRelease(device);
  }

  bool Init(ID3D12Device* dev, ID3D12CommandQueue* q) {
    device = dev; device->AddRef();
    queue = q; queue->AddRef();
    vs_code = CompileShader("VSMain", "vs_5_0");
    ps_code = CompileShader("PSMain", "ps_5_0");
    if (vs_code.empty() || ps_code.empty()) return false;

    // Root signature: t0 table, 8 root constants at b0, static point sampler at s0.
    auto* serialize = reinterpret_cast<SerializeRootSignatureFn>(GetProcAddress(GetModuleHandleW(L"d3d12.dll"), "D3D12SerializeRootSignature"));
    if (!serialize) return false;
    D3D12_DESCRIPTOR_RANGE range{D3D12_DESCRIPTOR_RANGE_TYPE_SRV, 1, 0, 0, 0};
    D3D12_ROOT_PARAMETER params[2]{};
    params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    params[0].DescriptorTable = {1, &range};
    params[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    params[1].Constants = {0, 0, sizeof(QuadConstants) / 4};
    params[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
    D3D12_STATIC_SAMPLER_DESC sampler{};
    sampler.Filter = D3D12_FILTER_MIN_MAG_MIP_POINT;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    sampler.ComparisonFunc = D3D12_COMPARISON_FUNC_NEVER;
    sampler.MaxLOD = D3D12_FLOAT32_MAX;
    sampler.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    D3D12_ROOT_SIGNATURE_DESC rs{2, params, 1, &sampler, D3D12_ROOT_SIGNATURE_FLAG_NONE};
    ID3DBlob* blob = nullptr;
    ID3DBlob* err = nullptr;
    const HRESULT hr = serialize(&rs, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &err);
    if (err) err->Release();
    if (FAILED(hr)) return false;
    const HRESULT hr2 = device->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&root));
    blob->Release();
    if (FAILED(hr2)) return false;

    D3D12_DESCRIPTOR_HEAP_DESC rh{D3D12_DESCRIPTOR_HEAP_TYPE_RTV, kSlots, D3D12_DESCRIPTOR_HEAP_FLAG_NONE, 0};
    D3D12_DESCRIPTOR_HEAP_DESC sh{D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV, 1, D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE, 0};
    if (FAILED(device->CreateDescriptorHeap(&rh, IID_PPV_ARGS(&rtv_heap)))) return false;
    if (FAILED(device->CreateDescriptorHeap(&sh, IID_PPV_ARGS(&srv_heap)))) return false;
    rtv_step = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    for (auto*& a : allocators)
      if (FAILED(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&a)))) return false;
    if (FAILED(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocators[0], nullptr, IID_PPV_ARGS(&list)))) return false;
    list->Close();
    return SUCCEEDED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)));
  }

  bool EnsurePipeline(DXGI_FORMAT format) {
    if (pso && pso_format == format) return true;
    SafeRelease(pso);
    D3D12_GRAPHICS_PIPELINE_STATE_DESC d{};
    d.pRootSignature = root;
    d.VS = {vs_code.data(), vs_code.size()};
    d.PS = {ps_code.data(), ps_code.size()};
    auto& rt = d.BlendState.RenderTarget[0];
    rt.BlendEnable = TRUE;  // premultiplied alpha
    rt.SrcBlend = rt.SrcBlendAlpha = D3D12_BLEND_ONE;
    rt.DestBlend = rt.DestBlendAlpha = D3D12_BLEND_INV_SRC_ALPHA;
    rt.BlendOp = rt.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    rt.LogicOp = D3D12_LOGIC_OP_NOOP;
    rt.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    d.SampleMask = UINT_MAX;
    d.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    d.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    d.RasterizerState.DepthClipEnable = TRUE;
    d.DepthStencilState.DepthEnable = FALSE;
    d.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    d.NumRenderTargets = 1;
    d.RTVFormats[0] = format;
    d.SampleDesc.Count = 1;
    if (FAILED(device->CreateGraphicsPipelineState(&d, IID_PPV_ARGS(&pso)))) return false;
    pso_format = format;
    return true;
  }

  // Recreates the texture/upload buffer for a new size or colour space. Only when none of our
  // earlier work is still on the GPU (otherwise: try again next frame).
  bool EnsureTexture(bool srgb) {
    if (texture && tex_w == frame.width && tex_h == frame.height && tex_srgb == srgb) return true;
    if (fence->GetCompletedValue() < fence_value) return false;
    SafeRelease(texture);
    SafeRelease(upload);
    upload_ptr = nullptr;
    tex_ready = false;
    D3D12_HEAP_PROPERTIES def{D3D12_HEAP_TYPE_DEFAULT}, up{D3D12_HEAP_TYPE_UPLOAD};
    D3D12_RESOURCE_DESC td{};
    td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    td.Width = frame.width;
    td.Height = frame.height;
    td.DepthOrArraySize = 1;
    td.MipLevels = 1;
    td.Format = srgb ? DXGI_FORMAT_B8G8R8A8_UNORM_SRGB : DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    if (FAILED(device->CreateCommittedResource(&def, D3D12_HEAP_FLAG_NONE, &td, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&texture)))) return false;
    upload_pitch = (frame.width * 4 + D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1) & ~(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1);
    D3D12_RESOURCE_DESC bd{};
    bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bd.Width = UINT64(upload_pitch) * frame.height;
    bd.Height = bd.DepthOrArraySize = bd.MipLevels = 1;
    bd.SampleDesc.Count = 1;
    bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    if (FAILED(device->CreateCommittedResource(&up, D3D12_HEAP_FLAG_NONE, &bd, D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&upload)))) { SafeRelease(texture); return false; }
    D3D12_RANGE none{0, 0};
    if (FAILED(upload->Map(0, &none, reinterpret_cast<void**>(&upload_ptr)))) { SafeRelease(upload); SafeRelease(texture); return false; }
    D3D12_SHADER_RESOURCE_VIEW_DESC sv{};
    sv.Format = td.Format;
    sv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    sv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    sv.Texture2D.MipLevels = 1;
    device->CreateShaderResourceView(texture, &sv, srv_heap->GetCPUDescriptorHandleForHeapStart());
    tex_w = frame.width;
    tex_h = frame.height;
    tex_srgb = srgb;
    tex_dirty = true;
    return true;
  }

  void RecordUpload() {
    // The upload buffer is reused: only overwrite it once the previous copy finished on the GPU.
    if (!tex_dirty || fence->GetCompletedValue() < fence_value) return;
    const size_t row = size_t(frame.width) * 4;
    for (uint32_t y = 0; y < frame.height; ++y) memcpy(upload_ptr + size_t(y) * upload_pitch, frame.pixels.data() + y * row, row);
    if (tex_ready) {
      auto b = Transition(texture, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_COPY_DEST);
      list->ResourceBarrier(1, &b);
    }
    D3D12_TEXTURE_COPY_LOCATION dst{texture, D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
    dst.SubresourceIndex = 0;
    D3D12_TEXTURE_COPY_LOCATION src{upload, D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
    src.PlacedFootprint.Offset = 0;
    src.PlacedFootprint.Footprint = {tex_srgb ? DXGI_FORMAT_B8G8R8A8_UNORM_SRGB : DXGI_FORMAT_B8G8R8A8_UNORM, tex_w, tex_h, 1, upload_pitch};
    list->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    auto b = Transition(texture, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
    list->ResourceBarrier(1, &b);
    tex_ready = true;
    tex_dirty = false;
  }

  void Draw(IDXGISwapChain3* sc) {
    if (Frames().Poll(&seen, &have, &frame)) tex_dirty = true;
    const UINT index = sc->GetCurrentBackBufferIndex();
    ID3D12Resource* back = nullptr;
    if (FAILED(sc->GetBuffer(index, IID_PPV_ARGS(&back)))) return;
    const D3D12_RESOURCE_DESC bd = back->GetDesc();
    const DXGI_FORMAT format = ViewFormat(bd.Format);
    Rect r{};
    const bool ok = bd.SampleDesc.Count == 1 && Place(frame, UINT(bd.Width), bd.Height, &r) &&
                    fence->GetCompletedValue() >= slot_fence[slot] &&  // allocator free? else skip
                    EnsurePipeline(format) && EnsureTexture(IsSrgb(format));
    if (!ok) { back->Release(); return; }

    ID3D12CommandAllocator* alloc = allocators[slot];
    if (FAILED(alloc->Reset()) || FAILED(list->Reset(alloc, pso))) { back->Release(); return; }
    RecordUpload();
    if (!tex_ready) { list->Close(); back->Release(); return; }

    D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtv_heap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += SIZE_T(slot) * rtv_step;
    D3D12_RENDER_TARGET_VIEW_DESC vd{};
    vd.Format = format;
    vd.ViewDimension = D3D12_RTV_DIMENSION_TEXTURE2D;
    device->CreateRenderTargetView(back, &vd, rtv);

    auto to_rt = Transition(back, D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_RENDER_TARGET);
    list->ResourceBarrier(1, &to_rt);
    const QuadConstants c = MakeConstants(r, UINT(bd.Width), bd.Height, frame.opacity);
    D3D12_VIEWPORT vp{0.f, 0.f, float(bd.Width), float(bd.Height), 0.f, 1.f};
    D3D12_RECT scissor{0, 0, LONG(bd.Width), LONG(bd.Height)};
    list->SetGraphicsRootSignature(root);
    list->SetDescriptorHeaps(1, &srv_heap);
    list->SetGraphicsRootDescriptorTable(0, srv_heap->GetGPUDescriptorHandleForHeapStart());
    list->SetGraphicsRoot32BitConstants(1, sizeof c / 4, &c, 0);
    list->RSSetViewports(1, &vp);
    list->RSSetScissorRects(1, &scissor);
    list->OMSetRenderTargets(1, &rtv, FALSE, nullptr);
    list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
    list->DrawInstanced(4, 1, 0, 0);
    auto to_present = Transition(back, D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_PRESENT);
    list->ResourceBarrier(1, &to_present);
    back->Release();  // no reference kept: ResizeBuffers is never blocked by us
    if (FAILED(list->Close())) return;
    ID3D12CommandList* lists[] = {list};
    queue->ExecuteCommandLists(1, lists);
    queue->Signal(fence, ++fence_value);
    slot_fence[slot] = fence_value;
    slot = (slot + 1) % kSlots;
    Frames().MarkDrawn();
  }
};

D3D12Renderer* g_renderer = nullptr;
ID3D12CommandQueue* g_seen_queue = nullptr;  // first DIRECT queue seen submitting work (AddRef'd)
bool g_failed = false;
SRWLOCK g_lock = SRWLOCK_INIT;

// The queue this swap chain presents on. DXGI keeps it as the swap chain's "device"; when that
// is not available we fall back to the first direct queue the game submitted work on.
bool QueueFor(IDXGISwapChain* sc, ID3D12Device** device, ID3D12CommandQueue** queue) {
  if (SUCCEEDED(sc->GetDevice(IID_PPV_ARGS(queue)))) {
    if (SUCCEEDED((*queue)->GetDevice(IID_PPV_ARGS(device)))) return true;
    SafeRelease(*queue);
    return false;
  }
  if (FAILED(sc->GetDevice(IID_PPV_ARGS(device)))) return false;  // not a D3D12 swap chain
  ID3D12Device* queue_device = nullptr;
  if (g_seen_queue && SUCCEEDED(g_seen_queue->GetDevice(IID_PPV_ARGS(&queue_device)))) {
    const bool same = queue_device == *device;
    queue_device->Release();
    if (same) { *queue = g_seen_queue; (*queue)->AddRef(); return true; }
  }
  SafeRelease(*device);
  return false;
}

}  // namespace

void D3D12SawQueue(ID3D12CommandQueue* queue) {
  if (g_seen_queue || !queue || queue->GetDesc().Type != D3D12_COMMAND_LIST_TYPE_DIRECT) return;
  if (!TryAcquireSRWLockExclusive(&g_lock)) return;
  if (!g_seen_queue) { g_seen_queue = queue; queue->AddRef(); }
  ReleaseSRWLockExclusive(&g_lock);
}

bool D3D12Present(IDXGISwapChain* sc) {
  if (!GetModuleHandleW(L"d3d12.dll")) return false;
  if (!TryAcquireSRWLockExclusive(&g_lock)) return true;
  ID3D12Device* device = nullptr;
  ID3D12CommandQueue* queue = nullptr;
  IDXGISwapChain3* sc3 = nullptr;
  const bool d3d12 = QueueFor(sc, &device, &queue);
  if (d3d12) {
    if (device->GetDeviceRemovedReason() != S_OK) {
      delete g_renderer;
      g_renderer = nullptr;
    } else {
      if (g_renderer && (g_renderer->device != device || g_renderer->queue != queue)) { delete g_renderer; g_renderer = nullptr; }
      if (!g_renderer && !g_failed) {
        g_renderer = new D3D12Renderer();
        if (!g_renderer->Init(device, queue)) { delete g_renderer; g_renderer = nullptr; g_failed = true; }
      }
      if (g_renderer && SUCCEEDED(sc->QueryInterface(IID_PPV_ARGS(&sc3)))) { g_renderer->Draw(sc3); sc3->Release(); }
    }
    device->Release();
    queue->Release();
  }
  ReleaseSRWLockExclusive(&g_lock);
  return d3d12;
}

void D3D12Teardown() {
  if (!TryAcquireSRWLockExclusive(&g_lock)) return;
  delete g_renderer;
  g_renderer = nullptr;
  SafeRelease(g_seen_queue);
  ReleaseSRWLockExclusive(&g_lock);
}

}  // namespace invz
