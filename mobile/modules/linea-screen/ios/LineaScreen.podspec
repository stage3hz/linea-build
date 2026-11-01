Pod::Spec.new do |s|
  s.name = 'LineaScreen'
  s.version = '0.14.0'
  s.summary = 'ReplayKit broadcast consent and configuration'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'INVIZENT'
  s.homepage = 'https://developer.apple.com/documentation/replaykit'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'ReplayKit', 'UIKit'
end
