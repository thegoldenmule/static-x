// swift-tools-version:6.0
// This line above is a directive, not prose: it is load-bearing to
// SwiftPM, it must never be flagged, and it must not merge downward
// into whatever comment follows it.
import PackageDescription

let package = Package(
    name: "Basic",
    targets: [
        .target(name: "Basic"),
        .testTarget(name: "BasicTests", dependencies: ["Basic"]),
    ]
)
