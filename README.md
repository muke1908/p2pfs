# p2pfs

Share selected files, folders, and plain text from your computer through a
private browser link.

![A host shares files and a live whitepad through an HTTPS tunnel; the receiver opens a private browser link.](docs/images/sharing-flow.svg)

**Host:** run the publisher locally and create a tunnel.  
**Receiver:** open the private link in a browser. Nothing to install or run.

There is no registry, peer discovery, receiver application, or central file
store. The host serves the content; the tunnel provider relays the connection.

## A look inside

**One whitepad, live.** Type on the host; receivers see updates automatically.
No titles, publish buttons, or back-and-forth.

![Host dashboard with a single whitepad, automatic save status, and file-sharing navigation.](docs/images/whitepad-host.png)

**A browser is all they need.** Download a file, browse a folder, or copy the
whitepad from a phone or desktop.

<table>
  <tr>
    <th>Files and folders</th>
    <th>Live whitepad</th>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/files-receiver-mobile.png" width="260" alt="Mobile receiver showing direct file downloads and browsable folder shares."></td>
    <td valign="top"><img src="docs/images/whitepad-receiver-mobile.png" width="260" alt="Mobile receiver showing the read-only whitepad with Copy text and Select text controls."></td>
  </tr>
</table>

_Screenshots use demo content. No real files, passwords, or private links are shown._

## Start the host

The host needs **Node.js 24.13 or newer**, npm, and an installed, authenticated
tunnel provider. Receivers only need a modern browser.

Configure one provider using its official setup instructions:

- **ngrok** (default): install the agent and configure your account credentials.
- **Microsoft Dev Tunnels:** install `devtunnel`, then run `devtunnel user login`.
- **zrok:** install `zrok` or `zrok2`, then enable your environment with your
  provider's enable token.

The app does not install provider CLIs or create accounts.

```sh
npm ci
npm run publisher
```

Enter a **host password of at least 12 characters** at the hidden prompt. This
password protects local management; do not send it to recipients.

The command builds the app, starts the local server, and starts the configured
tunnel. Provider selection lives in the host's **`host.json`** configuration
file, not in the dashboard. Open the printed **local dashboard URL** and unlock it with
the host password. Keep the terminal running; **Ctrl+C** shuts down the host and
its app-owned tunnel.

### Configure the host

Install and authenticate your tunnel provider **before starting the publisher**.
The publisher always starts a tunnel (or verifies your externally managed one).
If no `host.json` exists, it creates one using ngrok for a new installation
or the previously selected provider for an existing installation.

To choose a provider before the first run, create `host.json` in your state
directory:

```json
{
  "provider": "ngrok"
}
```

Allowed values are `ngrok`, `devtunnel`, and `zrok`. **Restart the publisher**
after editing. The file is read at startup; dashboard start/stop buttons use
that configuration and cannot change it. Invalid configuration stops startup
with an error rather than silently choosing another provider.

For example, create `./host-state/host.json` with the contents above, then run:

```sh
npm run publisher -- --state-dir ./host-state
```

Without `--state-dir`, the app uses its per-user application-data directory and
prints the configuration path on startup. Keep provider credentials in the
provider's own CLI configuration, not in `host.json`. Do not commit the state
directory, which also holds private runtime data.

If tunnel startup fails, the publisher exits and cleans up its listeners and
app-owned tunnel processes. Fix the reported installation, login, configuration,
or quota issue, then run `npm run publisher` again. There is no local-only
startup mode or automatic failover to a different provider.

## Share content and send a link

1. In **My shares**, choose **Share something**. Select a file, share the current
   folder, or enter an absolute file/folder path in the chooser. Use **Text** to
   write in the single **Whitepad**. It saves and streams automatically as you
   type, with no title or publish button.
2. Open **Guest links**, name the session, and choose **Create session link**.
   You can create a link before sharing any content.
3. Choose **Copy session link** and send the **entire URL**, including its
   `#token=...` fragment, privately to the recipient.

A session link covers **all current and future files, folders, and text you
explicitly share from this host**. Add or remove content without issuing a new
link: recipients see changes live, without refreshing. Unshared local content
is never included.

Do not send the bare tunnel endpoint or the local dashboard URL. Only the
private receiving link grants browser access.

## Receive in a browser

Open the link. There is no account, password prompt, Node installation, tunnel
tool, or local receiver server.

- **Standalone file:** choose **Download** directly, without opening a
  one-item collection.
- **Folder:** choose **Open folder**, then download individual files. A folder
  remains browsable even if it contains only one file.
- **Text:** watch the read-only whitepad update as the host types. Choose
  **Copy text** or **Select text** to copy it.

Files stream to the browser's download manager without buffering the complete
file in JavaScript. The browser controls progress, cancellation, save location,
and filename collisions. Folder downloads are individual files, not ZIP
archives; no local folder tree or automatic synchronization is created.

The host and tunnel must stay online. Some providers display a browser
confirmation page before opening the receiving page. An interrupted download
must be restarted; resumable transfers are not implemented.

## Link access and revocation

Each link has a random 256-bit secret, **expires after 24 hours**, and can be
revoked under **Guest links**. Anyone holding or receiving a forwarded copy can
access its shared content until expiry or revocation. Treat the link like a
password.

Only a hash of the secret is stored. The complete link is shown once: copy it
before closing the dialog, or create another if you lose it. The browser
exchanges the URL fragment for a separate HttpOnly, SameSite cookie (Secure over
HTTPS), then removes the fragment from the address bar.

Revocation prevents new reads and stops active downloads through that link.
Stopping a share also blocks its new reads and cancels its active transfers.
Neither action can recall files already saved or text already copied.

Browser sessions end when the host restarts. Reopen the original link if it is
still valid and the public URL is unchanged. If the tunnel URL changes, create
and send a new link.

## Files, folders, and text

Folder shares include **nested and hidden files**, even if hidden entries were
not displayed in the file chooser. Select folders carefully. Symlinks,
redirected paths, and special files are rejected or reported as skipped.
Recipients see relative names and opaque identifiers, never absolute host paths.

Filesystem watchers update shared catalogs automatically. Deleted or unsafe
shares disappear and produce a local diagnostic. **Re-index share** remains
available if automatic watching is unavailable. A share supports up to 10,000
filesystem entries and 64 levels of nesting; folder catalog pages contain
100 files. The local chooser displays up to 1,000 directory entries; enter a
more specific path for larger directories.

There is **one plain-text whitepad** per host, shared by all session links.
Everything typed into it is automatically shared; receivers cannot edit it.
Text is displayed literally, not rendered as HTML or executed. The pad holds
up to **1,000,000 characters** (UTF-16 code units), persists across restarts, and
can be cleared by deleting its contents. Clearing also updates receivers.
There is no clipboard monitoring, chat, or edit history.

The host sends edits at a short interval while typing and shows save status.
Wait for **Saved** before closing the page. If saving fails or another host
window changes the pad, your unsaved text stays in the editor: choose **Send my
text** to replace the saved pad, or **Use saved text** to discard your edits.

The host dashboard and browser receiver use authenticated Server-Sent Events
for live updates. They reconnect automatically; file-watcher and connection
errors are shown rather than silently ignored.

## Native Mac app

Use the lightweight **menu-bar app** instead of leaving a terminal open.
Opening it starts sharing; **Quit p2pfs** stops its publisher and tunnel.
There is no login item, automatic restart, or background service.

Build on macOS with Xcode Command Line Tools installed:

```sh
npm run app:build
open dist/p2pfs.app
```

Building does **not** open the app or start sharing. Stop any existing terminal
publisher with **Ctrl+C** before opening the app. Enter your existing host
password in the native secure prompt. It is passed through a pipe, not command
arguments or environment variables, and is not saved to disk or Keychain.
The app asks again each time you start sharing.

The menu shows connection status and provides **Open dashboard**, **Stop
sharing / Start sharing**, **Open configuration folder**, **Show diagnostics**,
and **Quit p2pfs**. The dashboard still opens in your browser and requires your
host password. Closing the browser does not stop sharing; use the menu.
Startup errors are shown instead of silently retrying. If the app crashes,
its supervisor stops the publisher and owned tunnel.

For an existing custom state directory, build with the same path:

```sh
npm run app:build -- --state-dir ./host-state
```

You can move `dist/p2pfs.app` into Applications. This is a local launcher, not a
self-contained distribution: keep this checkout (including `node_modules` and
`dist`), Node, and your authenticated tunnel CLI installed. The build records
their local paths and your `PATH` so Finder launches do not depend on shell
profiles. Rebuild and replace the app after moving the checkout, changing Node,
or changing your tunnel CLI's location. Run without sudo.

Quit and reopen after changing `host.json`. Your shares, whitepad, and guest
link settings remain in the state directory. Removing the app does not delete
them. Your Mac must stay awake and connected; the app does not prevent sleep
or bypass provider authentication and quotas. A restarted tunnel may get a new
URL, requiring new guest links.

## Host options

```sh
npm run publisher -- --help
npm run publisher -- --name "My host" --state-dir ./host-state
```

The public-content listener and management dashboard both bind to loopback:

| Option              | Default                                | Purpose                                           |
| ------------------- | -------------------------------------- | ------------------------------------------------- |
| `--transfer-port`   | `7331`                                 | Read-only content behind the tunnel               |
| `--management-port` | `7332`                                 | Local host dashboard; never forward this port     |
| `--state-dir`       | Per-user OS application-data directory | Publisher settings and shared-content definitions |
| `--name`            | Hostname on first start                | Display name shown to recipients                  |

Use separate state directories and ports if running multiple publishers.
For automation, `--password-stdin` reads the host password from standard input.
Connect it to your secret manager rather than writing real passwords into shell
history or command-line arguments.

### Externally managed tunnel

```sh
npm run publisher -- --public-url https://YOUR-HTTPS-ENDPOINT
```

Forward the transfer port, **not the management port**. The app verifies the
endpoint belongs to this host; your provider controls the external tunnel's
lifecycle. The dashboard labels it **Externally managed** and does not offer
start/stop controls.

Use `--allow-host custom.example.org` for additional trusted tunnel hostnames.
Public endpoint probes require HTTPS, reject private-network DNS results, pin
the validated address, and do not follow redirects.

### Provider behavior

| Provider     | Integration                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| devtunnel    | Uses `host -p PORT --allow-anonymous`, checks login, parses the hosting URL, and probes the public endpoint.                                                      |
| ngrok        | Uses the existing agent configuration with a temporary app-owned inspection-port override; matches `/api/endpoints` to this host. Request inspection is disabled. |
| zrok / zrok2 | Uses a public headless, force-local share and checks the required CLI flags before starting.                                                                      |

Provider-level open access does **not** bypass private-link authentication.
Only app-owned processes are stopped. Provider switching requires editing `host.json` and restarting, not
automatic failover. Bandwidth, quotas, provider availability, and account limits
still apply.

## Persistence and upgrading

Settings, selected paths, text, and link hashes live in the host's state
directory. File contents remain at their original locations. State files use
restrictive POSIX permissions; on Windows use a protected per-user directory.
Text is stored as plaintext, not in a separate encrypted vault.

Existing publisher state is migrated on startup. Old snippets are combined
into the whitepad with their titles and text preserved. Shares, password
verifier, identity, provider settings, and valid links are preserved.
Older item-specific links keep their file restrictions but **cannot access the
combined whitepad**; issue a new session link for text access. Their access is
never silently expanded.

The former installed receiver, registry/discovery, and CLI share/download
commands have been removed. Obsolete settings are dropped from the migrated
state, but old downloaded files and registry databases are **not deleted**.
Use the host dashboard for management and browser links for receiving.
Back up the state directory before upgrading; the new state format is not
readable by older app versions. Restart the publisher manually after updating.

## Security and availability

The public listener exposes only read-only guest access, its page/assets, and a
minimal health probe. Local management remains on its separate loopback port
with password authentication, Host/Origin checks, and CSRF protection. A guest
cookie cannot manage the host.

This is **not relay-free or end-to-end encrypted against the tunnel provider**.
Providers relay traffic and may terminate TLS. Trust the provider with content
and traffic it can observe. Links are bearer access, not individual-user
permissions.

Source metadata is checked before/during streaming; cryptographic file-content
verification is not implemented. Local filesystem mutation by a privileged
local process is outside the remote threat model. Do not place share or state
roots in directories controlled by untrusted local users.

Capacity limits and throttling reduce abuse but cannot guarantee availability
against denial of service. There is no remote upload, synchronization, or
production high-availability guarantee.

## Development and verification

```sh
npm run check
```

This runs strict type checking, ESLint, formatting checks, compilation, and
automated tests. Coverage includes host startup/shutdown, state migration,
management isolation, file safety and streaming, browser-link permissions,
expiry/revocation, live updates, text persistence, and tunnel process handling.
Test-only loopback access is injected in fixtures and is not a production CLI
option. GitHub Actions is configured for macOS, Linux, and Windows; a local
passing run is not proof that all platforms have passed.

Optional credential-gated public-provider smoke tests:

```sh
npm run build
node dist/test/live-provider.js ngrok
node dist/test/live-provider.js devtunnel
node dist/test/live-provider.js zrok
```

These publish only synthetic content, exercise the guest session/download APIs
through a real tunnel, check revocation and management isolation, and clean up
their own host and tunnel. They need an available provider account and tunnel
capacity. They do not prove browser interstitial handling or cross-platform
success. Desktop/mobile browser checks are separate from these API smoke tests.
