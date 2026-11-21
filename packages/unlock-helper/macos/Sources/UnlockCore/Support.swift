import Foundation

/// A refusal the gateway can act on. `code` is part of the protocol (DESIGN.md section 3.4).
public struct HelperError: Error, Equatable {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict: only the base64url alphabet, no padding.
    public static func decode(_ s: String) -> Data? {
        guard s.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil, s.count % 4 != 1 else { return nil }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}

public func hexDecode(_ s: String) -> Data? {
    guard s.count % 2 == 0, s.range(of: "^[0-9a-f]*$", options: .regularExpression) != nil else { return nil }
    var out = Data(); var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        out.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return out
}
