import Darwin
import Foundation

/// Refuses to serve a caller that is not the gateway. Honest limit (DESIGN.md section 4): this
/// stops another program from launching the helper and from sitting between the gateway and the
/// helper. It does not stop a hostile program of the same user, which can patch the gateway.
public struct AllowedCaller: Equatable {
    public var exe: String           // the runtime that runs the gateway, e.g. /opt/homebrew/bin/node
    public var scriptPrefix: String  // directory the gateway's entry script must lie in
    public init(exe: String, scriptPrefix: String) { self.exe = exe; self.scriptPrefix = scriptPrefix }
}

public struct ProcArgs: Equatable {
    public var execPath: String
    public var argv: [String]
    public var env: [String]
}

public enum CallerPolicy {
    /// `allowed-callers.json` next to the helper binary: {"v":1,"callers":[{"exe":"…","scriptPrefix":"…"}]}
    public static func load(from url: URL) throws -> [AllowedCaller] {
        guard let data = try? Data(contentsOf: url),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              o["v"] as? Int == 1, let list = o["callers"] as? [[String: Any]], !list.isEmpty
        else { throw HelperError("caller_refused", "No readable allowed-callers.json next to the helper.") }
        return try list.map {
            guard let e = $0["exe"] as? String, let p = $0["scriptPrefix"] as? String, e.hasPrefix("/"), p.hasPrefix("/") else {
                throw HelperError("caller_refused", "allowed-callers.json entries need absolute exe and scriptPrefix.")
            }
            return AllowedCaller(exe: e, scriptPrefix: p)
        }
    }

    /// Layout of sysctl KERN_PROCARGS2: int32 argc, exec path, NUL padding, argv[0..argc), environment.
    public static func parseProcArgs(_ d: Data) -> ProcArgs? {
        guard d.count > 4 else { return nil }
        let argc = d.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard argc >= 0 else { return nil }
        var parts = d.dropFirst(4).split(separator: 0, omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF8.self) }
        guard !parts.isEmpty else { return nil }
        let exec = parts.removeFirst()
        while let f = parts.first, f.isEmpty { parts.removeFirst() }     // padding
        guard parts.count >= Int(argc) else { return nil }
        let argv = Array(parts.prefix(Int(argc)))
        let env = parts.dropFirst(Int(argc)).filter { !$0.isEmpty }
        return ProcArgs(execPath: exec, argv: argv, env: Array(env))
    }

    public static func procArgs(pid: pid_t) -> ProcArgs? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0 else { return nil }
        return parseProcArgs(Data(buf.prefix(size)))
    }

    static func real(_ p: String) -> String { URL(fileURLWithPath: p).resolvingSymlinksInPath().path }

    /// Pure decision. `nil` = accepted, otherwise the reason (for the log, not for the caller).
    public static func evaluate(parent: ProcArgs, parentExe: String, allowed: [AllowedCaller]) -> String? {
        let exe = real(parentExe)
        guard let rule = allowed.first(where: { real($0.exe) == exe }) else { return "parent program is not allowed" }
        guard parent.argv.count >= 2 else { return "parent has no script" }
        let script = parent.argv[1]
        if script.hasPrefix("-") { return "parent runs the runtime with options before the script" }
        if parent.env.contains(where: { $0.hasPrefix("NODE_OPTIONS=") }) { return "parent has NODE_OPTIONS set" }
        let base = real(rule.scriptPrefix)
        let s = real(script)
        guard s == base || s.hasPrefix(base.hasSuffix("/") ? base : base + "/") else { return "parent script is outside the gateway install" }
        return nil
    }

    /// stdin must be a pipe or a socket made by the parent, never a terminal or a file.
    public static func stdinIsChannel() -> Bool {
        var st = stat()
        guard fstat(0, &st) == 0 else { return false }
        let t = st.st_mode & S_IFMT
        return t == S_IFIFO || t == S_IFSOCK
    }

    public static func parentExePath(pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : nil
    }

    /// The live check, run at start and before every request (the parent must not change).
    public static func checkParent(expectedParent: pid_t, allowed: [AllowedCaller]) -> String? {
        let ppid = getppid()
        if ppid != expectedParent || ppid <= 1 { return "parent changed or is gone" }
        guard stdinIsChannel() else { return "stdin is not a pipe" }
        guard let exe = parentExePath(pid: ppid), let args = procArgs(pid: ppid) else { return "cannot inspect parent" }
        return evaluate(parent: args, parentExe: exe, allowed: allowed)
    }
}
