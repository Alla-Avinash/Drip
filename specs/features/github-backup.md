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

## Flow (plain steps)

1. User configures the remote URL/branch and (optionally) a PAT.
2. User initializes the repo, then pushes to back up.
3. To restore elsewhere, user pulls; DRIP reindexes the restored KB.
