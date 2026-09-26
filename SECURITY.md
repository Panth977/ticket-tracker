# Security

If you find a vulnerability, please open a private security advisory on GitHub (Security › Advisories › Report a vulnerability) rather than a public issue. Include the steps to reproduce and, if you can, the affected door (app, REST, MCP, OAuth) or rule file.

What the repository never contains: Firebase project ids, web configs, tokens or provider secrets. They live in gitignored `.env*` files and in Secret Manager; the templates are the `*.example` files. If you believe a credential has landed in the history, report it the same way.
