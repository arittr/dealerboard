# Security policy

## Supported versions

Security fixes are made on the latest `main` source. This project does not
currently publish supported binary releases.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** flow to open a private security
advisory. Do not include credentials, private transcripts, prompt text, real
session identifiers, or sensitive local paths in a public issue.

Include the affected commit, macOS version, provider and provider version,
reproduction steps using synthetic data, and the impact you observed. If a
private advisory is unavailable, open a public issue containing no sensitive
details and ask for a private contact channel.

## Trust model

Dealerboard is a single-user local application. It assumes that processes
running as the same macOS account already share access to that user's provider
configuration and Dealerboard state. It does not treat same-user process
isolation as a security boundary.

The supported install is non-elevated. Do not run the installers with `sudo`.
Provider hooks are untrusted input: the helper bounds stdin, allowlists fields,
and uses parameterized registry writes. The Tauri UI renders snapshot strings
as text and launches fixed executables or allowlisted URL shapes without a
shell.

Evener is restricted to loopback addresses, but AppWire currently sends its
bearer capability in the initial WebSocket Authorization header. A malicious
process running as the same user could bind the configured port and receive
that header. Do not enable the Evener integration in an environment where
same-user processes are outside your trust boundary.

## Release artifacts

No prebuilt app, daemon, or Stream Deck plugin is currently distributed from
this repository. A future binary release must add third-party notices and,
for macOS, Developer ID signing and notarization before it is considered a
supported artifact.
