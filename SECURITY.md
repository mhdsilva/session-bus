# Security policy

Session Bus is designed for one local user. The hub binds to a loopback address;
the MCP bridge rejects non-loopback hub URLs. Remote access, multi-user
authentication, and cloud synchronization are outside the current MVP.

The operator interface uses an HttpOnly same-site cookie and same-origin checks.
Each MCP bridge keeps its agent bearer token in process memory. Do not log or
share bridge tokens, private transcripts, credentials, or secrets through room
messages and artifacts.

## Reporting a vulnerability

Please do not post an exploitable vulnerability in a public issue. Once this
repository is published, use GitHub's **Report a vulnerability** action in the
repository Security tab. Repository maintainers must enable private vulnerability
reporting before release. Until that reporting channel is available, contact the
maintainer privately using the contact listed on the repository profile.

Include affected versions, a concise impact description, and reproduction steps.
Do not include real credentials or private agent transcripts.
