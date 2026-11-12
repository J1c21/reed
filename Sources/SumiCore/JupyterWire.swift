import CryptoKit
import Foundation

// The Jupyter wire protocol: how a kernel message is laid out across ZeroMQ frames.
// https://jupyter-client.readthedocs.io/en/stable/messaging.html#the-wire-protocol
//
//   [routing identities…] <IDS|MSG> signature header parent_header metadata content [buffers…]
//
// The four JSON documents are passed through as raw bytes. Sumi's native side never parses
// them, which keeps the bridge fast and means the bytes we sign are the bytes we send.

public struct WireMessage {
    public var identities: [Data]
    public var header: Data
    public var parentHeader: Data
    public var metadata: Data
    public var content: Data
    public var buffers: [Data]

    public init(
        identities: [Data] = [],
        header: Data,
        parentHeader: Data,
        metadata: Data,
        content: Data,
        buffers: [Data] = []
    ) {
        self.identities = identities
        self.header = header
        self.parentHeader = parentHeader
        self.metadata = metadata
        self.content = content
        self.buffers = buffers
    }
}

public enum WireError: Error, LocalizedError {
    case malformed
    case badSignature

    public var errorDescription: String? {
        switch self {
        case .malformed: return "Received a malformed Jupyter message."
        case .badSignature: return "Received a Jupyter message with an invalid signature."
        }
    }
}

public struct WireCodec {
    private static let delimiter = Data("<IDS|MSG>".utf8)
    private static let hexDigits = Array("0123456789abcdef".utf8)

    private let key: SymmetricKey?

    public init(key: String) {
        self.key = key.isEmpty ? nil : SymmetricKey(data: Data(key.utf8))
    }

    private func signature(_ parts: [Data]) -> Data {
        guard let key else { return Data() }
        var hmac = HMAC<SHA256>(key: key)
        for part in parts { hmac.update(data: part) }
        var hex = Data(capacity: 64)
        for byte in hmac.finalize() {
            hex.append(Self.hexDigits[Int(byte >> 4)])
            hex.append(Self.hexDigits[Int(byte & 0x0F)])
        }
        return hex
    }

    public func encode(_ message: WireMessage) -> [Data] {
        let parts = [message.header, message.parentHeader, message.metadata, message.content]
        return message.identities + [Self.delimiter, signature(parts)] + parts + message.buffers
    }

    public func decode(_ frames: [Data]) throws -> WireMessage {
        guard let split = frames.firstIndex(of: Self.delimiter), frames.count >= split + 6 else {
            throw WireError.malformed
        }
        let parts = Array(frames[(split + 2) ... (split + 5)])
        if key != nil, signature(parts) != frames[split + 1] {
            throw WireError.badSignature
        }
        return WireMessage(
            identities: Array(frames[..<split]),
            header: parts[0],
            parentHeader: parts[1],
            metadata: parts[2],
            content: parts[3],
            buffers: Array(frames[(split + 6)...])
        )
    }
}
