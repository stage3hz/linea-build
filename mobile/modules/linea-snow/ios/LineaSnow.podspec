Pod::Spec.new do |s|
  s.name = 'LineaSnow'
  s.version = '0.1.0'
  s.summary = 'Snow on the phone: falling snow, caps on ledges and rime on glass, drawn on a passthrough overlay'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'INVIZENT'
  s.homepage = 'https://developer.apple.com/documentation/foundation/processinfo/thermalstate'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'UIKit', 'QuartzCore', 'CoreGraphics'
end
