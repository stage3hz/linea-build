Pod::Spec.new do |s|
  s.name = 'LineaNearby'
  s.version = '0.1.0'
  s.summary = 'Messages to people nearby without internet for Invizent'
  s.description = 'Core Bluetooth state and permission, NWPathMonitor internet state.'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Linea contributors'
  s.homepage = 'https://developer.apple.com/documentation/corebluetooth'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.frameworks = 'CoreBluetooth', 'Network'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
