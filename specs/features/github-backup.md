# Feature: GitHub backup

## What it is

DRIP can back up the whole knowledge base to a GitHub repository and restore it, using the user's installed Git.

## How to access it

- All actions are in **Settings → GitHub backup**, or as commands in the Command Palette (init / push / pull / configure remote / open remote).

## Sub-features

### Configure remote

- Set the GitHub remote URL and branch for the KB.

### Initialize

- Initialize a Git repo in the KB (requires Git on PATH) so it can be pushed.

### Push / pull

- Push the KB to GitHub (one-click backup).
- Pull the KB from GitHub and reindex after restoring.

### Credentials

- A GitHub personal access token is stored in VS Code Secret Storage (per KB), never in settings.

### Open remote

- Open the GitHub web page for the configured remote.

### Backup vs project sync

GitHub backup is a whole-knowledge-base snapshot for disaster recovery. It is **not** how people on a shared project stay in sync.

A shared project's source of truth is its files plus the operation log in its `.drip/` sidecar (see Project sharing and Project sync). Mixing a git merge of those files with the operation log forks the project, so a shared project is not merged through git. The backup can still include the folder as a snapshot.

The project's tags and metadata overrides live inside that sidecar, so they travel with the project folder. They are not under `.dripindex/`, which backup skips.

## Flow (plain steps)

1. User configures the remote URL/branch and (optionally) a PAT.
2. User initializes the repo, then pushes to back up.
3. To restore elsewhere, user pulls; DRIP reindexes the restored KB.
