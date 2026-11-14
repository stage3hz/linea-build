enabled = ENV['INVIZENT_TRANSPORT_B'] == '1'
if enabled
  ['Frameworks/Mobile.xcframework/Info.plist', 'Generated/StageBProofJoiner.swift'].each do |relative|
    raise "Transport B enabled but missing #{relative}; prepare the pinned CI artifacts first" unless File.file?(File.join(__dir__, relative))
  end
end

Pod::Spec.new do |s|
  s.name = 'LineaTransportB'
  s.version = '0.1.0'
  s.summary = 'Experimental INVIZENT iOS transport-session bridge'
  s.description = 'Opt-in gomobile session control. No automatic route or device VPN.'
  s.license = { :type => 'GPL-3.0-only' }
  s.author = 'INVIZENT contributors'
  s.homepage = 'https://github.com/stage3hz/linea-build'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = enabled ? ['TransportBModule.swift', 'Generated/*.swift'] : ['TransportBModule.swift']
  s.frameworks = 'Foundation', 'CFNetwork', 'Security', 'SystemConfiguration'
  # CocoaPods exposes a DSL writer, not a readable Hash on Specification.
  xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  if enabled
    s.vendored_frameworks = 'Frameworks/Mobile.xcframework'
    s.libraries = 'resolv', 'c++'
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) INVIZENT_TRANSPORT_B'
  end
  s.pod_target_xcconfig = xcconfig
end
