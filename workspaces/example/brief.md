This is the project brief the orch splices into every agent's instructions
(see `lib/brief.md`, section "This project"). Write it for an unattended agent
that has never seen the repository: what the project is, how to run its checks,
what it must never do. Keep it short; the repository's own CLAUDE.md is read too.

- Stack: (language, framework, package manager)
- Verify with: `npm test` (say which suites are slow, and which need services)
- Never: commit, push, deploy, or touch files outside the ticket's scope
