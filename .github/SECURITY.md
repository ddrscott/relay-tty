# Security policy

relay-tty gives a browser a live shell on your machine, so a flaw in it can hand someone else that shell. Please report anything that could lead there privately rather than in a public issue.

## Reporting

Use [GitHub's private vulnerability reporting](https://github.com/ddrscott/relay-tty/security/advisories/new). Include the relay-tty version (`relay --version`), how the server was started (localhost, `--tunnel`, or behind your own proxy), and the steps that reproduce the problem. A proof of concept against your own install is welcome, but please do not test against other people's sessions or tunnels.

This is a one-maintainer project. Expect an acknowledgement within a few days and a fix in the next release once the problem is confirmed. You will be credited in the advisory unless you ask not to be.

## Supported versions

Fixes land on the latest release only. The npm package and the pty-host binaries attached to GitHub releases are built from the same tag, so upgrading with `npm i -g relay-tty@latest` picks up both.

## In scope

- Getting terminal input or output without a valid credential: the owner cookie, a JWT, a share link, a pair grant (`relay_grant`), or the relay password
- A share link or pair grant reaching more than it was issued for, such as another session, write access from a read-only link, the `/desktop` VNC bridge, or owner-only routes
- Path traversal or symlink escapes in the file browser, upload, and `exists` endpoints
- Anything that turns a non-localhost request into one the server treats as localhost
- Injection through terminal output into the web UI, such as OSC 8 link schemes, image protocols, or file-path linking
- The postinstall binary download and the release pipeline

## Out of scope

- Local users on the same machine. Localhost requests skip auth by design, because anyone with a local shell can already run the commands relay-tty runs.
- The `relaytty.com` tunnel edge. It lives in [ddrscott/relaytty.com](https://github.com/ddrscott/relaytty.com), so please report issues with it there.
- Programs you run inside a session. relay-tty relays their bytes and does not sandbox them.
