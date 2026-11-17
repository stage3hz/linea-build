Pod::Spec.new do |s|
  s.name = 'LineaChatList'
  s.version = '0.1.0'
  s.summary = 'The chat list drawn natively: a UITableView whose rows are drawn in one pass'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'INVIZENT'
  s.homepage = 'https://developer.apple.com/documentation/uikit/uitableview'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'UIKit', 'CoreGraphics'
end
