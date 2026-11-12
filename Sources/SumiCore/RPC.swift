import Foundation

// A tiny transport-agnostic RPC layer. The same router serves the app (WKWebView script
// messages) and the development host (WebSocket), so the web UI cannot tell them apart.

public struct RPCError: Error, LocalizedError {
    public let code: String
    public let message: String

    public init(_ message: String, code: String = "error") {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public struct RPCParams {
    public let raw: [String: Any]

    public init(_ raw: Any?) {
        self.raw = raw as? [String: Any] ?? [:]
    }

    public subscript(key: String) -> Any? {
        let value = raw[key]
        return value is NSNull ? nil : value
    }

    public func string(_ key: String) throws -> String {
        guard let value = self[key] as? String else {
            throw RPCError("Missing parameter “\(key)”.", code: "bad_params")
        }
        return value
    }

    public func optString(_ key: String) -> String? { self[key] as? String }
    public func int(_ key: String) -> Int? { (self[key] as? NSNumber)?.intValue }
    public func double(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue }
    public func bool(_ key: String) -> Bool? { (self[key] as? NSNumber)?.boolValue }
}

public protocol EventSink: AnyObject {
    /// Delivers an event whose payload is already-encoded JSON text.
    func emit(event: String, json: String)
}

/// One connected front end: a notebook window in the app, or a browser tab in development.
public final class RPCClient: @unchecked Sendable {
    public let id: String
    public weak var sink: EventSink?

    public init(id: String = UUID().uuidString, sink: EventSink? = nil) {
        self.id = id
        self.sink = sink
    }

    public func emit(_ event: String, _ payload: Any?) {
        sink?.emit(event: event, json: JSON.string(payload))
    }

    public func emit(_ event: String, json: String) {
        sink?.emit(event: event, json: json)
    }
}

public final class RPCRouter: @unchecked Sendable {
    public typealias Handler = (RPCParams, RPCClient) async throws -> Any?

    private var handlers: [String: Handler] = [:]
    private let lock = NSLock()

    public init() {}

    public func register(_ method: String, _ handler: @escaping Handler) {
        lock.lock()
        handlers[method] = handler
        lock.unlock()
    }

    public func handle(method: String, params: Any?, client: RPCClient) async throws -> Any? {
        let handler = lock.withLock { handlers[method] }
        guard let handler else {
            throw RPCError("Unknown method “\(method)”.", code: "unknown_method")
        }
        return try await handler(RPCParams(params), client)
    }
}

/// Owns the router and the set of connected clients.
public final class Hub: @unchecked Sendable {
    public let router = RPCRouter()

    private var clients: [String: RPCClient] = [:]
    private let lock = NSLock()

    public init() {}

    public func add(_ client: RPCClient) {
        lock.lock()
        clients[client.id] = client
        lock.unlock()
    }

    public func remove(_ client: RPCClient) {
        lock.lock()
        clients.removeValue(forKey: client.id)
        lock.unlock()
    }

    public func broadcast(_ event: String, _ payload: Any?, except: RPCClient? = nil) {
        lock.lock()
        let targets = Array(clients.values)
        lock.unlock()
        let json = JSON.string(payload)
        for client in targets where client !== except {
            client.emit(event, json: json)
        }
    }
}
