import Foundation

public enum Log {
    public static var verbose = ProcessInfo.processInfo.environment["SUMI_VERBOSE"] != nil

    public static func info(_ message: @autoclosure () -> String) {
        FileHandle.standardError.write(Data("[sumi] \(message())\n".utf8))
    }

    public static func debug(_ message: @autoclosure () -> String) {
        guard verbose else { return }
        FileHandle.standardError.write(Data("[sumi:debug] \(message())\n".utf8))
    }
}

public enum JSON {
    /// Encodes any JSON-compatible Foundation value (including top-level fragments) to text.
    public static func string(_ value: Any?) -> String {
        guard let value else { return "null" }
        if value is NSNull { return "null" }
        if let text = value as? String { return quote(text) }
        if value is [Any] || value is [String: Any] {
            guard JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
            else { return "null" }
            return String(decoding: data, as: UTF8.self)
        }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            let double = number.doubleValue
            return double.isFinite ? number.stringValue : "null"
        }
        return "null"
    }

    public static func quote(_ text: String) -> String {
        var out = "\""
        out.reserveCapacity(text.utf8.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    public static func parse(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }

    public static func parse(_ data: Data) -> Any? {
        try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}

extension String {
    var expandingTilde: String { (self as NSString).expandingTildeInPath }
}

func isoTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}
