// swift-tools-version:5.9
// Command-line tools only: `swift build`, `swift test`. No Xcode needed.
import PackageDescription

let package = Package(
    name: "suveren-unlock-helper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "suveren-unlock-helper", targets: ["suveren-unlock-helper"]),
        .library(name: "UnlockCore", targets: ["UnlockCore"]),
    ],
    targets: [
        .target(name: "UnlockCore", path: "Sources/UnlockCore"),
        .executableTarget(
            name: "suveren-unlock-helper",
            dependencies: ["UnlockCore"],
            path: "Sources/suveren-unlock-helper"
        ),
        .testTarget(
            name: "UnlockCoreTests",
            dependencies: ["UnlockCore"],
            path: "Tests/UnlockCoreTests"
        ),
    ]
)
