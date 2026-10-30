Pod::Spec.new do |s|
  s.name = 'LineaPhoto'
  s.version = '0.4.0'
  s.summary = 'Local photo preparation for Linea'
  s.description = 'ImageIO decoding, Vision foreground masks and bounded local pixel processing.'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Linea contributors'
  s.homepage = 'https://developer.apple.com/documentation/vision'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.frameworks = 'Vision', 'CoreImage', 'CoreGraphics', 'ImageIO', 'UniformTypeIdentifiers', 'QuickLook', 'AVFoundation', 'MediaToolbox'
  s.libraries = 'z'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
