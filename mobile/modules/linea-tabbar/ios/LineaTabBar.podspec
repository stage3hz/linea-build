Pod::Spec.new do |s|
  s.name = 'LineaTabBar'
  s.version = '0.1.0'
  s.summary = 'Native tab bar: system Liquid Glass, capsule with a trail, hold list of sections'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'INVIZENT'
  s.homepage = 'https://developer.apple.com/documentation/uikit/uiglasseffect'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'UIKit', 'QuartzCore'
end
