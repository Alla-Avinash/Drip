# Feature: Projects and features

## What it is

Work is organized into **projects**, and each project is broken into **features**. This mirrors Linear's project structure and is the backbone for planning and tracking.

## How to access it

- Create projects/features from the KB tree **New** menu.
- Browse them in the **Project View** panel (via the **Open Project View** command).

## Structure

- A **project** is a folder with a project index note (`.project` file-level type). It carries status, priority, and deadline.
- A **feature** is a folder (or file) with a feature index note (`.feature` file-level type). It carries an "implemented" flag.
- Both projects and features get stable entity IDs (`f-N` for features; the folder acts as the project container).

## The Project View panel

A Linear-style panel (`drip.openProjectView`) that:

- lists projects from the index,
- lists each project's children (features, and issues not assigned to a feature),
- is backed by the index query so it reflects the current state.

## Sub-features

- **Project/feature folders** — creating and watching project and feature folders.
- **Project index** — indexing projects and their structure into the database.
- **Project view query** — the queries that power the Project View panel.
- **Convert folder to feature** — a folder can be promoted to a feature folder.

## Flow (plain steps)

1. User creates a project folder, then feature folders inside it.
2. The index records the project/feature structure with entity IDs.
3. User opens the Project View to browse projects → features → issues in a Linear-style layout.
