// Stand-in for the real agent in tests: connects, sends one JSON line, prints the first reply line.
// usage: agent-stub <socket> '<json>'
import Foundation
let a = CommandLine.arguments
guard a.count == 3 else { exit(2) }
let s = socket(AF_UNIX, SOCK_STREAM, 0)
var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
let b = Array(a[1].utf8) + [0]
withUnsafeMutableBytes(of: &addr.sun_path) { p in for i in 0..<min(b.count, p.count) { p[i] = b[i] } }
let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
if r != 0 { print("connect failed"); exit(3) }
let msg = a[2] + "\n"; _ = write(s, msg, msg.utf8.count)
var buf = [UInt8](repeating: 0, count: 4096); let n = read(s, &buf, 4095)
print(String(decoding: buf[0..<max(n, 0)], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
