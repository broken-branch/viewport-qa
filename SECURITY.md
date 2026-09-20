# Security policy

Viewport QA runs entirely on your machine. Its review service binds only to `127.0.0.1` with a per-launch capability and must not be exposed through a proxy or bound beyond the local host. Scanned pages are untrusted: the origin you name is admitted for that scan, and every other origin, redirect, download, and private-address answer fails closed unless you list it with `--allow-origin`. The full boundary is described in [docs/security.md](docs/security.md).

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub's security advisory form](https://github.com/broken-branch/viewport-qa/security/advisories/new) rather than a public issue. Include the affected version or commit, platform, a minimal reproduction, the impact, and whether report or target data may have been exposed.

This is a volunteer-maintained project; there is no guaranteed response time, but reports are read and taken seriously.
