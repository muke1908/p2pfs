import Foundation

struct HostConfiguration: Decodable {
    let node: String
    let root: String
    let path: String
    let stateDirectory: String
}

struct HostStatus: Decodable {
    let status: String
    let dashboard: String
}

final class HostSession {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var pending = Data()
    private(set) var diagnostics = ""
    private(set) var stopping = false
    var onStatus: ((HostStatus) -> Void)?
    var onExit: ((Int32) -> Void)?
    var isRunning: Bool { process.isRunning }

    init(configuration: HostConfiguration) {
        process.executableURL = URL(fileURLWithPath: configuration.node)
        process.arguments = [
            URL(fileURLWithPath: configuration.root).appendingPathComponent("dist/src/cli/mac-host.js").path,
            "--state-dir", configuration.stateDirectory
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: configuration.root)
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = configuration.path
        // Finder should not inject debugging/preload options into the publisher.
        environment.removeValue(forKey: "NODE_OPTIONS")
        process.environment = environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
    }

    func start(password: String) throws {
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receive(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.record(data) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                self.output.fileHandleForReading.readabilityHandler = nil
                self.errors.fileHandleForReading.readabilityHandler = nil
                self.record(self.errors.fileHandleForReading.readDataToEndOfFile())
                self.onExit?(process.terminationStatus)
            }
        }
        do {
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: Data((password + "\n").utf8))
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        guard !stopping else { return }
        stopping = true
        // Closing the channel asks the supervisor to stop and reap its children.
        input.fileHandleForWriting.closeFile()
    }

    private func record(_ data: Data) {
        diagnostics = String((diagnostics + String(decoding: data, as: UTF8.self)).suffix(16_384))
    }

    private func receive(_ data: Data) {
        pending.append(data)
        while let newline = pending.firstIndex(of: 10) {
            let line = pending[..<newline]
            do {
                onStatus?(try JSONDecoder().decode(HostStatus.self, from: line))
            } catch {
                record(Data("Invalid host status: \(error.localizedDescription)\n".utf8))
                stop()
            }
            pending.removeSubrange(...newline)
        }
    }
}
