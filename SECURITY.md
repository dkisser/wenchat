# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

WenChat is pre-1.0; only the latest `0.1.x` release receives security fixes.
Please upgrade to the latest commit on `main` before reporting.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Use one of the following private channels:

- **GitHub Security Advisories**:
  https://github.com/dkisser/wenchat/security/advisories/new
- **Email**: 437631891@qq.com

Please include:

- Reproduction steps (ideally a minimal script using `@wenchat/core`).
- Affected commit SHA or version tag.
- Impact assessment — what an attacker on the same LAN can do.

We will acknowledge within **72 hours** and aim to ship a fix within
**30 days**, depending on severity.

## Scope

WenChat is **LAN-only** — there is no public attack surface beyond what is
reachable from the local network.

**Out of scope** (these require LAN access and are the user's environment to
defend):

- Network-level attacks (ARP spoofing, mDNS poisoning, switch flooding).
- DoS via flooding the signaling HTTP endpoint or the DataChannel.
- Physical / on-host compromise of either peer.

**In scope**:

- RCE / memory unsafety in `werift` or `@wenchat/core`.
- Path traversal in `/file <path>` or the file-receiver save logic
  (`~/Downloads/<name> (n)`).
- mDNS TXT-record spoofing that allows impersonation of another peer.
- Information leak via error messages, logs, or clipboard OSC 52 payload.
- WebRTC handshake regressions that bypass signaling authentication.
