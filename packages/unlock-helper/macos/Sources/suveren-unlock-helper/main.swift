import Darwin
import Foundation
import UnlockCore

// suveren-unlock-helper serve
//   One JSON request per line on stdin, one JSON response per line on stdout. stderr: short log,
//   never a secret. Exits when stdin closes or its parent changes.
// Debug builds only (tests; compiled out of release): --backend software, --allow-any-caller,
//   --allowed-callers <file>. A release build reads allowed-callers.json next to itself, nothing else.
// SUVEREN_HELPER_NO_PROMPT=1 makes every touch fail with interaction_required (it only restricts).

setvbuf(stdout, nil, _IOLBF, 0)

func log(_ s: String) { FileHandle.standardError.write(Data("suveren-unlock-helper: \(s)\n".utf8)) }
func emit(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(d + Data("\n".utf8))
}

var args = Array(CommandLine.arguments.dropFirst())
guard args.first == "serve" else { log("usage: suveren-unlock-helper serve"); exit(64) }
args.removeFirst()

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

var backend: KeyBackend = SecureEnclaveBackend()
var allowAny = false
#if DEBUG
if option("--backend") == "software" { backend = SoftwareBackend() }
allowAny = args.contains("--allow-any-caller")
#endif

let expectedParent = getppid()
var allowed: [AllowedCaller] = []
if !allowAny {
    let me = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    var file = me.deletingLastPathComponent().appendingPathComponent("allowed-callers.json")
    #if DEBUG
    if let f = option("--allowed-callers") { file = URL(fileURLWithPath: f) }   // never in release: it would let a caller name itself
    #endif
    do { allowed = try CallerPolicy.load(from: file) } catch { log("refused: no caller list"); exit(77) }
    if let why = CallerPolicy.checkParent(expectedParent: expectedParent, allowed: allowed) { log("refused: \(why)"); exit(77) }
}

let handler = Handler(backend: backend, interactionAllowed: ProcessInfo.processInfo.environment["SUVEREN_HELPER_NO_PROMPT"] != "1")

while let line = readLine(strippingNewline: true) {
    if !allowAny, let why = CallerPolicy.checkParent(expectedParent: expectedParent, allowed: allowed) {
        emit(["ok": false, "error": ["code": "caller_refused", "message": "The caller is not the gateway."]]); log("refused: \(why)"); exit(77)
    }
    if line.utf8.count > 16_384 { emit(["ok": false, "error": ["code": "bad_request", "message": "Request too large."]]); continue }
    guard let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit(["ok": false, "error": ["code": "bad_request", "message": "Not a JSON object."]]); continue
    }
    emit(handler.handle(obj))
    if obj["op"] as? String == "shutdown" { exit(0) }
}
