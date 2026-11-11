Pod::Spec.new do |s|
  s.name = 'LineaCall'
  s.version = '0.1.0'
  s.summary = 'CallKit reporting of a call that runs in the app'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'INVIZENT'
  s.homepage = 'https://developer.apple.com/documentation/callkit'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'CallKit', 'AVFoundation'
end
