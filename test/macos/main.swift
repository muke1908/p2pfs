import Foundation

let configuration = try JSONDecoder().decode(
    HostConfiguration.self,
    from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
)
let password = readLine()!
let host = HostSession(configuration: configuration)
host.onStatus = { update in
    print(update.status)
    fflush(stdout)
}
host.onExit = { code in
    FileHandle.standardError.write(Data(host.diagnostics.utf8))
    exit(code)
}
try host.start(password: password)
FileHandle.standardInput.readabilityHandler = { handle in
    _ = handle.availableData
    DispatchQueue.main.async { host.stop() }
}
RunLoop.main.run()
