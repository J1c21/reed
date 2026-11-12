// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Sumi",
    platforms: [.macOS(.v13)],
    targets: [
        // Platform-agnostic core: ZMTP, Jupyter wire protocol, kernel management, RPC services.
        .target(name: "SumiCore", path: "Sources/SumiCore"),
        // The macOS app shell (AppKit + WKWebView).
        .executableTarget(name: "Sumi", dependencies: ["SumiCore"], path: "Sources/Sumi"),
        // Headless WebSocket host used while developing the web UI in a browser.
        .executableTarget(name: "sumi-dev", dependencies: ["SumiCore"], path: "Sources/sumi-dev"),
    ]
)
