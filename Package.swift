// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Reed",
    platforms: [.macOS(.v13)],
    targets: [
        // Platform-agnostic core: ZMTP, Jupyter wire protocol, kernel management, RPC services.
        .target(name: "ReedCore", path: "Sources/ReedCore"),
        // The macOS app shell (AppKit + WKWebView).
        .executableTarget(name: "Reed", dependencies: ["ReedCore"], path: "Sources/Reed"),
        // Headless WebSocket host used while developing the web UI in a browser.
        .executableTarget(name: "reed-dev", dependencies: ["ReedCore"], path: "Sources/reed-dev"),
    ]
)
