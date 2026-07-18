# Security Policy

## Supported Versions

Lunery Lab Studio is currently pre-1.0 and distributed from the latest GitHub
Release. Security fixes are only shipped on the newest release line.

## Reporting a Vulnerability

Report suspected vulnerabilities to support@lunerylab.com.

Please include:

- Affected version, platform, and whether the issue is in the web download site
  or the Tauri desktop Studio.
- Reproduction steps or a proof of concept.
- Expected impact and any files, routes, or dependencies involved.

Do not include real user secrets, provider API keys, private prompts, or private
creative assets in the report.

## Security Fix Release Process

Lunery Lab Studio does not currently have automatic updates. Security fixes must
be released through all distribution surfaces:

- Publish a new GitHub Release with replacement macOS and Windows assets.
- Keep `/download` pointing at the stable `releases/latest/download/*` assets.
- Add a clear release note or announcement when users need to update manually.

For local development, never commit `.env.local`, `.vercel/`, generated
workspaces, downloaded engines, or desktop build output. If a local secret may
have been exposed outside the machine, rotate it before release.
