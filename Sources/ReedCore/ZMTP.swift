import Foundation
import Network

// A minimal client-side implementation of ZMTP 3.0 (the ZeroMQ wire protocol) with the
// NULL security mechanism. It is exactly as much ZeroMQ as a Jupyter front end needs:
// DEALER sockets for shell / control / stdin and a SUB socket for iopub.
//
// Spec: https://rfc.zeromq.org/spec/23/

public enum ZMTPSocketType: String {
    case dealer = "DEALER"
    case sub = "SUB"
    case req = "REQ"
}

public enum ZMTPError: Error, LocalizedError {
    case badGreeting
    case unsupportedMechanism(String)
    case peerError(String)
    case closedByPeer
    case timedOut
    case network(String)

    public var errorDescription: String? {
        switch self {
        case .badGreeting: return "The peer did not send a valid ZMTP greeting."
        case .unsupportedMechanism(let m): return "Unsupported ZMTP security mechanism “\(m)”."
        case .peerError(let reason): return "The peer rejected the connection: \(reason)"
        case .closedByPeer: return "The connection was closed by the kernel."
        case .timedOut: return "Timed out while connecting to the kernel."
        case .network(let m): return m
        }
    }
}

/// A growable FIFO byte buffer that hands out contiguous chunks without quadratic copying.
struct ByteQueue {
    private var storage = Data()
    private var head = 0

    var count: Int { storage.count - head }

    mutating func append(_ data: Data) { storage.append(data) }

    func byte(at offset: Int) -> UInt8 { storage[head + offset] }

    mutating func skip(_ n: Int) {
        head += n
        trim()
    }

    mutating func take(_ n: Int) -> Data {
        let chunk = storage.subdata(in: head ..< head + n)
        head += n
        trim()
        return chunk
    }

    mutating func reset() {
        storage = Data()
        head = 0
    }

    private mutating func trim() {
        if head == storage.count {
            storage.removeAll(keepingCapacity: storage.count < (1 << 20))
            head = 0
        } else if head > (4 << 20) {
            storage.removeSubrange(0 ..< head)
            head = 0
        }
    }
}

public final class ZMTPConnection: @unchecked Sendable {
    public let socketType: ZMTPSocketType

    /// Called once the ZMTP handshake has completed. Invoked on the connection's queue.
    public var onReady: (() -> Void)?
    /// Called for every complete multipart message. Invoked on the connection's queue.
    public var onMessage: (([Data]) -> Void)?
    /// Called once when the connection ends, with `nil` for an orderly local close.
    public var onClose: ((Error?) -> Void)?

    private let host: NWEndpoint.Host
    private let port: NWEndpoint.Port
    private let identity: Data
    private let queue: DispatchQueue

    private enum Phase { case greeting, handshake, traffic }
    private var phase: Phase = .greeting
    private var connection: NWConnection?
    private var inbound = ByteQueue()
    private var partial: [Data] = []
    private var outbox: [Data] = []
    private var deadline: DispatchTime = .now()
    private var finished = false

    public init(host: String, port: UInt16, type: ZMTPSocketType, identity: Data = Data(), queue: DispatchQueue) {
        self.host = NWEndpoint.Host(host)
        self.port = NWEndpoint.Port(rawValue: port) ?? .any
        self.socketType = type
        self.identity = identity
        self.queue = queue
    }

    /// Starts connecting. Until `timeout` elapses, refused connections are retried — a freshly
    /// launched kernel needs a moment before it listens on its ports.
    public func connect(timeout: TimeInterval) {
        queue.async {
            self.deadline = .now() + timeout
            self.startAttempt()
        }
    }

    public func send(_ frames: [Data]) {
        let encoded = Self.encode(frames)
        queue.async {
            guard !self.finished else { return }
            if self.phase == .traffic {
                self.sendRaw(encoded)
            } else {
                self.outbox.append(encoded)
            }
        }
    }

    public func close() {
        queue.async { self.finish(nil, notify: false) }
    }

    // MARK: - Connection lifecycle

    private func startAttempt() {
        guard !finished else { return }
        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.connectionTimeout = 5
        }
        let conn = NWConnection(host: host, port: port, using: params)
        connection = conn
        inbound.reset()
        partial.removeAll()
        phase = .greeting

        conn.stateUpdateHandler = { [weak self, weak conn] state in
            guard let self, let conn, self.connection === conn else { return }
            switch state {
            case .ready:
                self.sendRaw(Self.greeting)
                self.receive(on: conn)
            case .waiting(let error):
                self.retryOrFail(ZMTPError.network(error.localizedDescription))
            case .failed(let error):
                self.retryOrFail(ZMTPError.network(error.localizedDescription))
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func retryOrFail(_ error: Error) {
        guard !finished else { return }
        if phase != .traffic && DispatchTime.now() < deadline {
            connection?.stateUpdateHandler = nil
            connection?.cancel()
            connection = nil
            queue.asyncAfter(deadline: .now() + .milliseconds(60)) { [weak self] in
                self?.startAttempt()
            }
        } else {
            finish(phase == .traffic ? error : ZMTPError.timedOut, notify: true)
        }
    }

    private func finish(_ error: Error?, notify: Bool) {
        guard !finished else { return }
        finished = true
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        outbox.removeAll()
        if notify { onClose?(error) }
        onReady = nil
        onMessage = nil
        onClose = nil
    }

    // MARK: - Receiving

    private func receive(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self, weak conn] data, _, isComplete, error in
            guard let self, let conn, self.connection === conn, !self.finished else { return }
            if let data, !data.isEmpty {
                self.inbound.append(data)
                self.drain()
                guard !self.finished, self.connection === conn else { return }
            }
            if let error {
                self.retryOrFail(ZMTPError.network(error.localizedDescription))
            } else if isComplete {
                self.retryOrFail(ZMTPError.closedByPeer)
            } else {
                self.receive(on: conn)
            }
        }
    }

    private func drain() {
        while !finished {
            switch phase {
            case .greeting:
                guard inbound.count >= 64 else { return }
                let greeting = inbound.take(64)
                guard greeting[0] == 0xFF, greeting[9] == 0x7F, greeting[10] >= 3 else {
                    finish(ZMTPError.badGreeting, notify: true)
                    return
                }
                let mechanism = String(decoding: greeting[12 ..< 32].prefix { $0 != 0 }, as: UTF8.self)
                guard mechanism == "NULL" else {
                    finish(ZMTPError.unsupportedMechanism(mechanism), notify: true)
                    return
                }
                phase = .handshake
                sendRaw(readyCommand())

            case .handshake:
                guard let frame = nextFrame() else { return }
                guard frame.flags & 0x04 != 0 else {
                    finish(ZMTPError.badGreeting, notify: true)
                    return
                }
                let (name, payload) = Self.parseCommand(frame.body)
                if name == "READY" {
                    phase = .traffic
                    if socketType == .sub {
                        // ZMTP 3.0 subscriptions travel as ordinary messages: 0x01 + topic prefix.
                        sendRaw(Self.encode([Data([0x01])]))
                    }
                    let pending = outbox
                    outbox.removeAll()
                    for message in pending { sendRaw(message) }
                    onReady?()
                } else if name == "ERROR" {
                    let reason = payload.count > 1
                        ? String(decoding: payload.dropFirst(), as: UTF8.self)
                        : "unknown"
                    finish(ZMTPError.peerError(reason), notify: true)
                    return
                }

            case .traffic:
                guard let frame = nextFrame() else { return }
                if frame.flags & 0x04 != 0 {
                    let (name, payload) = Self.parseCommand(frame.body)
                    if name == "PING" {
                        // PING = ttl (2 bytes) + context; PONG echoes the context.
                        var body = Data([4])
                        body.append(contentsOf: Array("PONG".utf8))
                        body.append(payload.dropFirst(2))
                        sendRaw(Self.commandFrame(body))
                    }
                    continue
                }
                partial.append(frame.body)
                if frame.flags & 0x01 == 0 {
                    let message = partial
                    partial = []
                    onMessage?(message)
                }
            }
        }
    }

    private func nextFrame() -> (flags: UInt8, body: Data)? {
        guard inbound.count >= 2 else { return nil }
        let flags = inbound.byte(at: 0)
        let isLong = flags & 0x02 != 0
        let headerLength = isLong ? 9 : 2
        guard inbound.count >= headerLength else { return nil }
        var size = 0
        if isLong {
            for i in 1 ... 8 { size = (size << 8) | Int(inbound.byte(at: i)) }
        } else {
            size = Int(inbound.byte(at: 1))
        }
        guard size >= 0, inbound.count >= headerLength + size else { return nil }
        inbound.skip(headerLength)
        return (flags, inbound.take(size))
    }

    // MARK: - Sending

    private func sendRaw(_ data: Data) {
        guard let conn = connection else { return }
        conn.send(content: data, completion: .contentProcessed { [weak self, weak conn] error in
            guard let self, let conn, self.connection === conn, let error else { return }
            self.retryOrFail(ZMTPError.network(error.localizedDescription))
        })
    }

    // MARK: - Encoding

    private static let greeting: Data = {
        var g = Data(count: 64)
        g[0] = 0xFF
        g[8] = 0x01
        g[9] = 0x7F
        g[10] = 3 // version major
        g[11] = 0 // version minor
        for (i, byte) in "NULL".utf8.enumerated() { g[12 + i] = byte }
        return g
    }()

    private func readyCommand() -> Data {
        var body = Data([5])
        body.append(contentsOf: Array("READY".utf8))
        func property(_ name: String, _ value: Data) {
            body.append(UInt8(name.utf8.count))
            body.append(contentsOf: Array(name.utf8))
            var length = UInt32(value.count).bigEndian
            withUnsafeBytes(of: &length) { body.append(contentsOf: $0) }
            body.append(value)
        }
        property("Socket-Type", Data(socketType.rawValue.utf8))
        if socketType != .sub { property("Identity", identity) }
        return Self.commandFrame(body)
    }

    private static func commandFrame(_ body: Data) -> Data {
        var frame = Data()
        if body.count > 255 {
            frame.append(0x06)
            var length = UInt64(body.count).bigEndian
            withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        } else {
            frame.append(0x04)
            frame.append(UInt8(body.count))
        }
        frame.append(body)
        return frame
    }

    private static func parseCommand(_ body: Data) -> (name: String, payload: Data) {
        guard let nameLength = body.first, body.count >= 1 + Int(nameLength) else { return ("", Data()) }
        let bytes = [UInt8](body)
        let name = String(decoding: bytes[1 ..< 1 + Int(nameLength)], as: UTF8.self)
        return (name, Data(bytes[(1 + Int(nameLength))...]))
    }

    static func encode(_ frames: [Data]) -> Data {
        var out = Data()
        out.reserveCapacity(frames.reduce(0) { $0 + $1.count + 9 })
        for (index, frame) in frames.enumerated() {
            var flags: UInt8 = index < frames.count - 1 ? 0x01 : 0x00
            if frame.count > 255 {
                flags |= 0x02
                out.append(flags)
                var length = UInt64(frame.count).bigEndian
                withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
            } else {
                out.append(flags)
                out.append(UInt8(frame.count))
            }
            out.append(frame)
        }
        return out
    }
}
