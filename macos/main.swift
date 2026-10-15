import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private let status = NSMenuItem(title: "Stopped", action: nil, keyEquivalent: "")
    private let dashboard = NSMenuItem(title: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "o")
    private let toggle = NSMenuItem(title: "Start sharing...", action: #selector(toggleSharing), keyEquivalent: "")
    private var configuration: HostConfiguration?
    private var session: HostSession?
    private var dashboardURL: URL?
    private var lastError = ""
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "arrow.up.arrow.down.circle", accessibilityDescription: "p2pfs")
        let menu = NSMenu()
        menu.autoenablesItems = false
        status.isEnabled = false
        dashboard.isEnabled = false
        for entry in [
            status, .separator(), dashboard, toggle,
            NSMenuItem(title: "Open configuration folder", action: #selector(openConfiguration), keyEquivalent: ""),
            NSMenuItem(title: "Show diagnostics", action: #selector(showDiagnostics), keyEquivalent: ""),
            .separator(), NSMenuItem(title: "Quit p2pfs", action: #selector(quit), keyEquivalent: "q")
        ] {
            entry.target = self
            menu.addItem(entry)
        }
        item.menu = menu
        do {
            guard let url = Bundle.main.url(forResource: "host", withExtension: "json") else {
                throw CocoaError(.fileNoSuchFile)
            }
            configuration = try JSONDecoder().decode(HostConfiguration.self, from: Data(contentsOf: url))
            start()
        } catch {
            lastError = "Cannot load the app configuration. Rebuild with npm run app:build.\n\(error.localizedDescription)"
            status.title = "Setup failed"
            showDiagnostics()
        }
    }

    private func start() {
        guard let configuration, session == nil else { return }
        let prompt = NSAlert()
        prompt.messageText = "Start sharing"
        prompt.informativeText = "Enter your host password (at least 12 characters). It stays in memory only. Use the same password as your existing publisher."
        prompt.addButton(withTitle: "Start")
        prompt.addButton(withTitle: "Cancel")
        let password = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        prompt.accessoryView = password
        prompt.window.initialFirstResponder = password
        NSApp.activate(ignoringOtherApps: true)
        guard prompt.runModal() == .alertFirstButtonReturn else { return }
        guard password.stringValue.count >= 12,
              password.stringValue.count <= 1024,
              !password.stringValue.contains("\n"),
              !password.stringValue.contains("\r") else {
            lastError = "Use a host password of 12 to 1,024 characters without line breaks."
            showDiagnostics()
            return
        }
        lastError = ""
        dashboardURL = nil
        dashboard.isEnabled = false
        let host = HostSession(configuration: configuration)
        session = host
        status.title = "Starting..."
        toggle.title = "Stop sharing"
        host.onStatus = { [weak self, weak host] update in
            guard let self, let host, self.session === host, !host.stopping else { return }
            self.status.title = update.status == "Ready" ? "Sharing" : update.status
            self.item.button?.toolTip = "p2pfs: \(self.status.title)"
            if let url = URL(string: update.dashboard), url.scheme == "http", url.host == "127.0.0.1" {
                self.dashboardURL = url
                self.dashboard.isEnabled = true
            }
        }
        host.onExit = { [weak self, weak host] code in
            guard let self, let host, self.session === host else { return }
            self.lastError = host.diagnostics
            self.session = nil
            self.dashboard.isEnabled = false
            self.dashboardURL = nil
            self.status.title = code == 0 ? "Stopped" : "Could not start / host stopped"
            self.toggle.title = "Start sharing..."
            self.toggle.isEnabled = true
            if self.quitting {
                NSApp.reply(toApplicationShouldTerminate: true)
            } else if code != 0 {
                self.showDiagnostics()
            }
        }
        do {
            try host.start(password: password.stringValue)
            password.stringValue = ""
        } catch {
            password.stringValue = ""
            if !host.isRunning { session = nil }
            status.title = "Could not start"
            toggle.title = "Start sharing..."
            toggle.isEnabled = session == nil
            lastError = "Cannot start the publisher. Rebuild the app if Node or the checkout moved.\n\(error.localizedDescription)"
            showDiagnostics()
        }
    }

    @objc private func toggleSharing() {
        if let session {
            status.title = "Stopping..."
            toggle.isEnabled = false
            session.stop()
        } else {
            start()
        }
    }

    @objc private func openDashboard() {
        if let dashboardURL { NSWorkspace.shared.open(dashboardURL) }
    }

    @objc private func openConfiguration() {
        guard let configuration else { return }
        let url = URL(fileURLWithPath: configuration.stateDirectory, isDirectory: true)
        if !NSWorkspace.shared.open(url) {
            lastError = "The configuration folder does not exist yet. Start sharing to create it.\n\(url.path)"
            showDiagnostics()
        }
    }

    @objc private func showDiagnostics() {
        let alert = NSAlert()
        alert.messageText = "p2pfs"
        let details = session?.diagnostics ?? lastError
        alert.informativeText = details.isEmpty ? "No errors reported." : details
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let session else { return .terminateNow }
        quitting = true
        status.title = "Stopping..."
        session.stop()
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
