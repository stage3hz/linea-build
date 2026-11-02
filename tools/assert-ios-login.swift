import Foundation
import Vision
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ru-RU", "en-US"]
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
print(text)
let failed = text.contains("не получилось") || text.contains("keychainexception") || text.contains("required entitlement")
let login = text.contains("твой ник") || text.contains("сначала") || text.contains("nickname") || text.contains("your username")
guard login && !failed else { fputs("Expected the login screen, not a startup error\n", stderr); exit(1) }
