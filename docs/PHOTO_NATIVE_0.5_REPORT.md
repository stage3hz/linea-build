# Native photo processing, iteration 0.5

## Delivered behavior

The local `LineaPhoto` Expo module now implements an optional normalized crop,
100% or 50% dimensions, bicubic ×2/×4 enlargement, and fresh PNG/JPEG encoding on
Android and iOS. PNG remains the default. The former options object remains valid.
No cloud photo service or new neural model was added. This report covers this
module only; the application photo pipeline performs its own metadata parsing and
may provide a separate, unchanged-pixels HDR PNG path.

The exact order is EXIF orientation/reflection → crop original oriented pixels →
requested resolution → effects → enlargement → fresh encoding. `resolution:0.5`
means half of each dimension, therefore approximately one quarter of the pixel
count. It is an explicit user selection and is not reported as an additional
downsample. Brush coordinates refer to the cropped view.

JPEG uses encoder quality 100 on Android and 1.0 on iOS. JPEG is still lossy at
that setting. Existing alpha is composited onto white for JPEG; selecting
`background:'transparent'` with JPEG is an error. PNG retains alpha where present.
Source EXIF/XMP/IPTC dictionaries are never copied into the new image. The JS
boundary separately strips/validates optional output metadata before encryption.

## Bridge contract

`index.ts` exports types only and never eagerly loads the native bridge.

```ts
type PhotoCrop = {x:number;y:number;width:number;height:number};
type PhotoOptions = {
  background:'keep'|'transparent'|'white';
  document:'none'|'bw'|'color';
  scale:1|2|4;
  strokes:PhotoStroke[];
  allowDownsample?:boolean;
  format?:'png'|'jpeg'; // default png
  resolution?:1|0.5;   // default 1
  crop?:PhotoCrop;      // absent means full image
};
```

All crop components are finite numbers. Width and height must be positive and the
rectangle must be within the unit square, allowing only a 1e-9 floating point
rounding tolerance at the far edge. Pixel bounds use floor for left/top and ceil
for right/bottom, clamped to the oriented image. The requested resolution then
uses `max(1,floor(cropDimension*resolution))`. Unknown keys, explicit nulls,
booleans in numeric fields, unsupported scales and incompatible effects fail.

The existing asynchronous methods remain `capabilities`, `prepareBackground`,
`inspect`, `render`, `dispose`, and `clearCache`.

`inspect` additionally returns `dynamicRange:'sdr'|'hdr'|'unknown'` and an optional
`dynamicRangeReason`. `capabilities` includes `hdrPreservation:false` and a human
readable `hdrReason`. `render` additionally returns `format:'png'|'jpeg'` and
`mimeType:'image/png'|'image/jpeg'`, along with its existing URI, actual dimensions
and `downsampled` flag.

## Limits and consent

| Case | Limit |
| --- | --- |
| Source file | 100 MiB |
| Source dimensions | 100 MP, at most 20,000 pixels per side |
| No effects, scale 1 | 16 MP |
| Effect processing base | 4 MP |
| Scale 2 base | 2 MP, then ×2 on both axes |
| Scale 4 base | 500,000 pixels, then ×4 on both axes |
| Enlarged output | 8 MP |
| Encoded PNG or JPEG | 20 MiB |
| Inspected metadata / inflated ICC profile | 4 MiB each, bounded |
| Container nesting | 12 levels; 100,000 boxes/chunks maximum |

Additional reduction for the pixel or encoded-file limit requires
`allowDownsample:true`; otherwise the module fails with `DOWNSAMPLE_REQUIRED` or
`OUTPUT_TOO_LARGE`. The encoded-size fallback makes at most four attempts, deletes
the oversized attempt before another attempt and returns the actual dimensions.

True crop requires the full oriented source to fit the 16 MP decode budget. If it
does not, `CROP_SOURCE_TOO_LARGE` explains that the user must first save a smaller
copy without cropping. This conservative limit is shared by both platforms.
ImageIO does not expose a guaranteed bounded region decode for this pipeline;
decoding a smaller whole image before crop would also change the promised order
and allow interpolation to sample outside the selected frame. A full-frame crop
uses the usual uncropped decode path.

Object removal retains the existing bounded diffusion method and 20% mask-area
cap. Enlargement is premultiplied-alpha bicubic interpolation, not AI detail
reconstruction. Document and background effects remain mutually exclusive.

## HDR and format policy

The effect pipeline is explicitly an 8-bit SDR pipeline. It refuses known HDR and
unknown dynamic range/precision with `HDR_UNSUPPORTED` before an sRGB bitmap is
created. It never marks an SDR output as HDR. A 16-bit file is not automatically
HDR; it is conservatively `unknown` here because an 8-bit result would also lose
precision. This is not universal support for every photo or video format.

The bounded source inspector examines JPEG segments, PNG chunks, WebP chunks and
the relevant ISO BMFF/HEIF/AVIF metadata boxes. It identifies JPEG gain-map/ISO
21496 markers, unresolved MPF multi-picture content, PNG PQ/HLG cICP, mastering
metadata, HEIF/AVIF `colr`, pixel depth, `auxC`, and `tmap` items. Animation is still
rejected rather than silently converted to its first frame.

JPEG/PNG/WebP embedded ICC profiles are accepted only when their numeric RGB
matrix and transfer curves establish a known SDR form. This recognizes standard
sRGB curves used by Display P3 without trusting the profile's display name.
Complex LUTs, unrecognized transfer functions, incomplete ICC sequences and
unknown HDR metadata remain blocked. The real LittleCMS-generated sRGB fixture
includes its `chrm` tag, which is chromaticity data rather than an HDR transfer.
The official Display P3 registry describes the same sRGB transfer curve; its ZIP
download returned HTTP 403 in this environment, so an actual Apple P3 profile was
not independently executed as a fixture.

HEIF/AVIF is admitted only when recognized color information and 8-bit pixel
properties are associated with the primary image through `pitm`/`ipma`, codec
configuration depth is 8-bit, and no unsupported/HDR property is encountered; decode
still depends on the device's codec. Auxiliary depth/high-bit-depth properties,
unknown derived items, alternative groups, unspecified transfer functions, and
unknown metadata can conservatively reject otherwise valid SDR files. TIFF/RAW,
floating point and unrecognized containers are not assumed SDR. Non-Exif JPEG
APP1/XMP content without a recognized safe interpretation is also conservative.

Android adds a numeric native colorspace-range check and, on API 34+, checks for
a decoded gain map before pixel processing. iOS checks the Apple HDR auxiliary
data and the ISO gain-map auxiliary data on iOS 18+. These checks complement
container inspection: a normal-looking SDR default decode does not prove that a
source lacks an HDR alternate.

The platform APIs can support future HDR work, but do not make these current
effects HDR safe. Android 14+ can preserve a gain map during crop, rotation and
scale; arbitrary filters require corresponding gain-map edits. Apple provides
HDR expansion, content headroom, ISO HDR and adaptive gain-map export paths.
Preserving those through the existing SDR pixel algorithms requires a separate
pipeline plus verified output metadata handling. It was not enabled here.

## Files and cleanup

Native outputs stay in the private cache directory `linea-photo` and are named
`linea-native-photo-<uuid>.png` or `.jpg`. `dispose` accepts only those names in the
canonical native cache directory. The input image is never removed. Oversized
encode attempts and failed output writes are removed; a failed removal is an
explicit error. `clearCache` recognizes both output extensions. iOS uses complete
file protection and excludes the output directory from backup. Filesystem failure
can prevent physical cleanup; no guaranteed secure-erasure claim is made.

## Verification and work log

1. Fixed the type contract with the parent pipeline/UI before implementation.
2. Added geometry/format/scale tests against the former behavior and minimal new
   entry-point stubs: 18 tests ran, seven failed for the expected unsupported crop,
   half-size, JPEG and fourfold behavior. Implemented the geometry/options and
   scale algorithm; all 18 then passed.
3. Added source HDR tests before the inspector: 23 tests ran, four failed for
   missing HDR/unknown detection. Implemented the bounded inspector and ICC
   numeric checks. A local extra closing brace was caught by Kotlin compilation
   and removed; the following behavioral run passed 24 tests.
4. Tested a real generated sRGB ICC profile. Its `chrm` tag produced one expected
   compatibility failure. Accepted chromaticity metadata while retaining numeric
   matrix/TRC checks; the 25-test run passed. Added a crop decode-budget regression
   to pin the full-source memory rule.
5. Added Android/iOS crop/JPEG processing and both cache extensions. Reused the
   existing algorithms and replaced duplicate animation scanning with the new
   source inspector. Added native colorspace/auxiliary HDR safeguards.
6. Shared a read-only Swift review with the video-module agent. This is static
   review, not an iOS build. The review identified a concrete HEIF issue: an
   auxiliary image's SDR properties could otherwise bless an unverified primary
   image. Added a failing regression, then bound color/depth properties to the
   primary item and checked HEVC/AV1 codec configuration depth on both platforms.
7. Final clean JVM run: **27 tests passed, zero failures/errors/skips** (11 options
   and geometry, 8 pixel behavior, 8 source/ICC/HDR). `clean test` completed in 14
   seconds, with all six Gradle tasks executed. This also removed ambiguity from
   incremental compile/test caching during the preceding edits.

JVM evidence is in `docs/evidence-v05/native-*.txt`, with final JUnit XML copied
there after the final run. The initial sandbox Gradle attempt could not create a
local socket; the authorized run outside that restriction was used for the actual
RED/GREEN evidence. No TLS verification was disabled.

At the initial handoff, Android prebuild/full APK build was deliberately deferred until
the parent announces the combined production-source freeze. No iOS SDK, Xcode
build, iPhone runtime, physical Android device or real ML Kit inference was
validated in this iteration. JVM tests validate shared geometry/pixel/header
logic, not native image decoder/encoder execution or visual quality on phones.

Post-handoff update: the parent completed Android release Kotlin compilation for
both `linea-photo` and `linea-video` successfully in 1 minute 35 seconds (54 tasks,
26 executed and 28 up to date). The observed log is copied to
`docs/evidence-v05/native-android-v05-compile.txt`. This is native compilation,
not an APK installation or device test. The photo module package and Expo plugin
metadata were then aligned to version 0.5.0; the prior 23-file source snapshot
confirmed that only `package.json` changed. The plugin was added to the refreshed
24-file manifest. No Kotlin/Swift production code changed during that metadata
update. Full APK verification remains the parent's final release step.

The user-requested ub-mode principles were applied through bounded pure parsing,
small contract-first changes, meaningful RED/GREEN regressions and this log.
Crapper/Dryer/Mutator gates for Kotlin/Swift were not run or claimed. There is no
repository commit/push claim.

## Primary references

- Android bitmap HDR edits: https://developer.android.com/media/grow/ultra-hdr/edit
- Android gain-map detection: https://developer.android.com/media/grow/ultra-hdr/display
- Android bitmap encoder/API: https://developer.android.com/reference/android/graphics/Bitmap
- Apple HDR architecture and API overview: https://developer.apple.com/videos/play/wwdc2024/10177/
- Apple HDR auxiliary data: https://developer.apple.com/documentation/appkit/applying-apple-hdr-effect-to-your-photos
- Apple image destination options: https://developer.apple.com/documentation/imageio/cgimagedestination
- PNG third edition, cICP/mDCV/cLLI: https://www.w3.org/TR/png-3/
- AVIF container and auxiliary/derived image items: https://aomediacodec.github.io/av1-avif/
- AV1 ISO media color signaling: https://aomediacodec.github.io/av1-isobmff/
- ICC matrix/TRC specification: https://www.color.org/specifications/ICC.1-2022-05.pdf
- Display P3 definition supplied by Apple: https://registry.color.org/rgb-registry/displayp3

