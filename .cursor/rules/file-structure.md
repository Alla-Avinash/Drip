

.cursor/
├── README.md                          ← layout guide
├── cursor_readme.txt                  ← your general Cursor notes (kept)
│
├── rules/                             ← auto-loaded .mdc
│   ├── core/
│   │   ├── workflow.mdc               always — feature / debug / plan formats
│   │   └── developer-ergonomics.mdc   always — navigable codebase priority
│   ├── context/
│   │   ├── drip-overview.mdc          always — what DRIP is + doc pointers
│   │   ├── drip-spec.mdc              agent — spec-driven implementation
│   │   └── drip-architecture.mdc        agent — structural / DB / identity
│   ├── code/
│   │   └── module-map.mdc             agent — where code lives
│   └── prompts/
│       ├── feature.mdc                agent — new features
│       ├── debugging.mdc              agent — bugs
│       ├── planning.mdc               agent — design before code
│       ├── understanding.mdc          agent — explain code (read-only)
│       └── cleanup.mdc                agent — audit / reorg plan
│
├── context/                           ← deep reference (@ manually or via rules)
│   ├── project-overview.md
│   ├── features-index.md              → sections in features.txt
│   ├── architecture-decisions.md
│   ├── system-flows.md
│   ├── app-startup.md             ← activate() + startup reconcile
│   ├── developer-ergonomics.md    ← find code fast; naming; onboarding
│   └── module-map.md
│
└── prompts/                           ← full templates (@ or paste)
    ├── feature-implementation.md
    ├── debugging.md
    ├── architecture-planning.md
    ├── code-understanding.md
    └── codebase-cleanup.md














