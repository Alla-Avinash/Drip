
all we need to know about cursor and how to structure our project files/ folders when using cursor 



0. .cursor/ Folder → Your AI Control Center

    This is where you store:
        rules,
        reusable prompts,
        architectural guidance,
        coding conventions.

1. .cursor/rules/*.mdc

    .mdc --> .mdc files (which stand for Multi-Document Context or Markdown Cursor)  are specialized configuration files used by the Cursor IDE to give  its AI models project-specific instructions and context.

    These files:
        persist across chats,
        automatically influence behavior,
        act like long-term engineering rules.
    
    these .mdc files can be scoped and can be applied globally or folder/ domain specific... 

    Example:
        backend.mdc 
        frontend.mdc 
        security.mdc 

    # Frontend Rules
        - Prefer reusable components
        - Avoid prop drilling
        - Use hooks for shared logic
        - Keep components under 300 lines
        - Avoid inline business logic in JSX
        - Follow existing design patterns
    
    These files become:
        long-term AI memory,
        architecture stabilizers,
        consistency enforcers.


2. .cursor/prompts/ .md or .txt files  --> Reusable High-Level Prompt Templates

    to store the different reusable prompt templates
    These are not automatic system prompts.
    They are reusable prompts you manually paste/use.

    Advanced users keep reusable prompts:

    Examples:
        planning prompts,
        debugging prompts,
        review prompts,
        optimization prompts.

    This creates workflow consistency.

    feature-planning.md
    debugging.md
    refactoring.md
    code-review.md

    feature-planning.md
        Analyze the existing implementation first.

        Do not write code yet.

        Explain:
        - relevant architecture
        - affected files
        - dependencies
        - risks
        - implementation strategy
        - edge cases
    
    debugging   
        Identify the root cause first.

        Do not patch symptoms blindly.

        Explain:
        - why the issue occurs
        - where the issue originates
        - safest minimal fix
        - possible side effects


3. .cursorignore

    this is outside the .cursor folder
    directly in the normal project folder structure

    This controls:
        what Cursor indexes,
        what enters AI context,
        what the agent can “see.”

    Without this:
        context becomes polluted,
        AI gets slower,
        hallucinations increase.



3. Chat-Level Prompting

    Even with rules, the CURRENT chat prompt heavily affects behavior.

    Example:
        Analyze first.
        Do not code yet.
        Explain architecture and risks.

    Cursor strongly weights:
        recent instructions,
        current task context,
        open files.

    So professional workflows use:
        persistent rules + scoped prompts.



4. Open Tabs = Implicit Context

    Open files strongly influence AI reasoning.

    If you open:
        unrelated modules,
        experimental files,
        dead code,

    Cursor may start:
        copying bad patterns,
        suggesting wrong architecture,
        mixing abstractions.



5. Codebase Indexing (Special Cursor Behavior)

    Cursor builds embeddings/indexes of your project.

    That means it semantically searches:
        components,
        functions,
        APIs,
        patterns.

    This is why:
        consistent naming matters,
        good folder structure matters,
        documentation matters.


6. @Codebase Context Retrieval

    Cursor can retrieve:
        semantically related files,
        implementations,
        utilities,
        similar patterns.

    This is effectively:
        retrieval-augmented generation for your codebase.

    This is why:
        naming consistency,
        modular design,
        clear separation
        matter A LOT.

7. Keep a “Current Architecture Decisions” File

    Example:
        docs/architecture-decisions.md

    Store decisions like:
        why Zustand was chosen,
        why Redis caching exists,
        why polling is used,
        why GraphQL was rejected.

    This prevents Cursor from constantly suggesting conflicting patterns.


8. cursor is not the owner of the code base... you are..

    YOU own architecture,
    Cursor accelerates implementation.\

    AI performs best when your codebase has:
        strong conventions,
        clear separation,
        modular structure,
        predictable patterns.

    Messy codebases degrade Cursor quality FAST.

    you have to take control of all the things (architectural and implementational practices) in the codebase


9. context or docs ---> .cursor/docs/ .md or readme files
    
    Permanent Project Memory
    VERY important for large projects.

    These files teach Cursor:
        how your app works,
        architectural decisions,
        stack conventions,
        folder purpose.

    Cursor performs MUCH better if you maintain: docs/

    Especially:
        architecture docs,
        API contracts,
        auth flows,
        state diagrams,
        conventions.
    
    context/
        project-overview.md
        coding-standards.md
        folder-structure.md
        tech-stack.md

    project-overview.md
        `
            # Project Overview

                This is a multi-tenant SaaS platform.

                Frontend:
                - Next.js
                - TypeScript
                - Tailwind

                Backend:
                - Node.js
                - Express
                - PostgreSQL

                Architecture:
                - service-repository pattern
                - JWT authentication
                - REST APIs

                Primary domains:
                - auth
                - billing
                - analytics
                - notifications
        `

10. Advanced Setup Used by Strong AI-Assisted Developers

    A mature setup often includes:

    .cursor/
    ├── rules/
    ├── prompts/
    ├── context/
    ├── workflows/
    ├── architecture/
    └── checklists/

    Example:
        coding standards
        review checklist
        security checklist
        API conventions
        deployment process
        testing strategy


11. slash commands -> skills

    /edit
        edits selected code,
        applies requested modifications.
        optimize this for readability

    /explain    
        to explain the architecture or feature implementations
        Very useful when onboarding into unfamiliar code.

    /fix
        Attempts:
            bug fixing,
            lint fixes,
            error resolution.
        You should still inspect carefully because it may: over-edit, introduce side effects.

    /review
        Acts like: code review mode, architecture critique mode.

    /docs


    /test
        Generates:
            unit tests,
            integration tests,
            mocks.
        Usually works best when scoped tightly.

    /terminal


    /commit



fix for out of memory/ out of context errors:
    - create different chats for different implementation/ features
    - keep only relavant files open and then only keep them open when you want to ask any new prompt
    - 
    - 

