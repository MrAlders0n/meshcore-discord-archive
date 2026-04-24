# MeshCore Discord Archive

**Live site:** https://mralders0n.github.io/meshcore-discord-archive/

## Why this exists

MeshCore is an open mesh-networking project with a community that grew to
around 12,000 members on Discord. In April 2026 the project split: the core
team moved to a new server at **meshcore.io** after a dispute over a
trademark application and control of the original Discord and the
MeshCore UK domain. The core team's account of the split is here:
[blog.meshcore.io/2026/04/23/the-split](https://blog.meshcore.io/2026/04/23/the-split).

This repo preserves what was publicly said on the original server so that
history, months of firmware discussion, hardware builds, troubleshooting
threads isn't lost to community members who have since moved elsewhere.

The archived messages were posted in a Discord that anyone with an invite
link could join; effectively a public forum, not a private space. Anything
here was already readable and copyable by 12k+ strangers at the time it was
posted.

If you posted something here and want it removed, open an issue or email
the repo owner and it will come out.

### What is *not* archived

Private channels, DMs, moderator-only spaces, and anything that was never
publicly visible are excluded by design. Only channels and forum threads
that were readable by any member of the server are included.

## Front-end disclaimer

The front-end site (everything under `site/`) and most of the build pipeline
(`scripts/build.py`) were written almost entirely by
[Claude](https://claude.com/claude-code) in a few sessions — i.e., they were
vibe-coded. The code works and has been eyeballed, but it hasn't had the kind
of review a hand-written project gets. PRs welcome.

The archived HTML itself under `MeshCore/` is untouched output.

## What's in the repo

- `MeshCore/` — raw HTML exports, organised by
  category. Forum categories have one file per thread. Chat-channel
  categories (like `General Chat/`) have a channel HTML plus a same-named
  folder containing that channel's threads.
- `scripts/build.py` — parses the HTML and emits the JSON that the site
  consumes.
- `site/` — the static site (HTML + CSS + vanilla JS + MiniSearch).
  - `site/data/` — generated JSON (committed, but rebuilt by CI on every push).
- `.github/workflows/pages.yml` — builds data and deploys `site/` to GitHub
  Pages.