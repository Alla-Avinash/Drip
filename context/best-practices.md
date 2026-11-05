# Best ways to use DRIP

## Principles

1. **Plain English first** — titles and bodies should explain *what* and *why*, not paste whole diffs.  
2. **One home per idea** — prefer linking or nesting over copying the same text into five notes.  
3. **Search before creating** — especially for issues (duplicates waste sync and attention).  
4. **Share the smallest world** — share a project when you need collaborators; keep personal scratch outside that `.p` folder.  
5. **AI is a helper, not the vault** — let Composer/MCP/LLM assist; the source of truth remains files on disk.

## Daily workflow (solo)

1. Capture with Composer or selection shortcut while you work.  
2. File into an existing heading when possible; otherwise create a clear `# .` heading (or `.d.md` equivalent).  
3. If it is buildable work, put it under **project → feature → issue**.  
4. End of day: skim Project View for open issues; close or re-title vague ones.

## Writing good issues

- Title = **problem statement** (“Users can’t reorder sub-issues”), not a vague chore (“Fix UI”).  
- Body = context, constraints, rejected approaches, acceptance in plain words.  
- Use **sub-issues** for nested work; keep the parent readable.  
- Set status / priority / deadline / category when they help you filter — don’t over-tag empty fields.

## Notes vs issues

| Use a **note / concept / decision** when… | Use an **issue** when… |
|-------------------------------------------|-------------------------|
| You are explaining how something works | You are tracking unfinished work |
| You are recording a decision or rationale | Someone (or you later) must *do* something |
| It should stay even after “done” | It should move through status → done/archive |

## Projects and features

- One **project** ≈ one product or major effort.  
- One **feature** ≈ one coherent area users can name.  
- Don’t spawn a new feature for every tiny edit — attach issues to the feature that owns the behavior.  
- Use **Overview** notes for the feature/project “front page.”

## Search habits

- Prefer **Retriever** when you remember meaning but not the title.  
- Prefer Project View search/filter when you know it is an issue in that project.  
- If semantic search feels weak, improve **titles and first lines** — the local embedding model rewards clear language.

## Sharing (when you collaborate)

- Share only after the project structure is stable enough that a teammate won’t drown.  
- Admin: admit carefully; pick **role + team**. Rotate invites if they leak.  
- Keep **sharing on** while collaborating; use **Reconnect** after VPN/network changes.  
- Don’t treat GitHub backup / git merge of the live shared folder + `.drip/` op log as the sync engine — that forks history.

## MCP / external AI

- Turn MCP on when you want Cursor/Claude to list/create/update issues for you.  
- Copy URL + token from **Settings → MCP connection**; keep the token private.  
- Ask the AI to **search existing issues** before creating new ones (same rule as humans).

## Hygiene that pays off

- Reindex from the KB toolbar after large renames/moves if search looks wrong.  
- Keep tags meaningful; prune junk tags in Tags Graph.  
- Archive completed work rather than deleting history you may need later.  
- Export identity (Account) before switching machines if you collaborate as a guest.

## Anti-patterns

- Pasting entire chat transcripts into every issue  
- Creating a new project for every afternoon of work  
- Sharing the whole knowledge base when you only need one project  
- Leaving issue titles as “WIP” / “fix” forever  
- Expecting live Google-Docs co-editing (DRIP syncs discrete operations, not keystrokes)
