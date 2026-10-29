Pod::Spec.new do |s|
  s.name = 'LineaSignal'
  s.version = '0.3.0'
  s.summary = 'Native Linea bridge to official libsignal 0.106.0'
  s.description = 'Signal protocol stores and authenticated file encryption. No plaintext fallback.'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Linea contributors'
  s.homepage = 'https://github.com/signalapp/libsignal'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/signalapp/libsignal.git', :tag => 'v0.106.0' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'LibSignalClient', '= 0.106.0'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule', 'SWIFT_ENABLE_EXPLICIT_MODULES' => 'NO' }
  # LibSignalClient extracts the official prebuilt libsignal_ffi.a into the Pods
  # project temp dir and only links it into its own pod target. With static
  # frameworks the app executable performs the final link, so it needs the same
  # directory to resolve the Swift module's auto-linked 'signal_ffi' library.
  ffi_dir = '$(OBJROOT)/Pods.build/libsignal_ffi/target'
  # Unconditional LIBRARY_SEARCH_PATHS so CocoaPods merges it with the other
  # pods' search paths; the per-SDK part lives in LINEA_SIGNAL_FFI_TARGET.
  s.user_target_xcconfig = {
    'SWIFT_ENABLE_EXPLICIT_MODULES' => 'NO',
    'LINEA_SIGNAL_FFI_TARGET[sdk=iphoneos*]' => 'aarch64-apple-ios',
    'LINEA_SIGNAL_FFI_TARGET[sdk=iphonesimulator*][arch=arm64]' => 'aarch64-apple-ios-sim',
    'LINEA_SIGNAL_FFI_TARGET[sdk=iphonesimulator*][arch=x86_64]' => 'x86_64-apple-ios',
    'LIBRARY_SEARCH_PATHS' => "\"#{ffi_dir}/$(LINEA_SIGNAL_FFI_TARGET)/release\"",
  }
end
