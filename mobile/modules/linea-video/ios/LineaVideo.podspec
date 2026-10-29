Pod::Spec.new do |s|
  s.name = 'LineaVideo'
  s.version = '0.5.0'
  s.summary = 'Local video metadata preparation for Linea'
  s.description = 'AVFoundation remux, bounded AVC/HEVC filtering and fresh AAC audio.'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Linea contributors'
  s.homepage = 'https://developer.apple.com/documentation/avfoundation'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'AudioToolbox', 'Photos'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
