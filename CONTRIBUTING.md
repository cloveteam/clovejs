# Contributing to CloveJS

Thanks for taking the time to contribute! This document covers how to set up
the project, the rules CI enforces, and how to open a pull request.

## Getting started

Fork the repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/clovejs.git
cd clovejs
npm install
```

Requires Node.js >= 20.

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile with tsup |
| `npm run dev` | Compile in watch mode |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run docs:dev` | Serve the docs locally |

## Before opening a pull request

CI (`.github/workflows/ci.yml`) runs on every push and pull request, and must
pass before a PR can be merged:

- **Lint** — `npm run lint`. Run `npm run lint:fix` to fix most issues
  automatically.
- **Typecheck** — `npm run typecheck`. The codebase is strict TypeScript;
  avoid `any` where a real type is feasible (`@typescript-eslint/no-explicit-any`
  is a warning, not an error, but reviewers will ask about it).
- **Build** — `npm run build`. Make sure the package still compiles.
- **Tests** — `npm test`, run against Node 20 and 22. Tests live under
  `test/e2e/**/*.test.ts` and generally spin up a real Clove app against the
  fixtures in `test/fixtures/`. Add or update tests for any behavior change —
  PRs that change behavior without test coverage will be asked for tests
  before merge.

Run all four locally before pushing:

```bash
npm run lint && npm run typecheck && npm run build && npm test
```

## Making changes

- Keep pull requests focused on a single change; unrelated cleanup makes
  review harder and is easier to land as its own PR.
- Match the existing code style — the ESLint config
  ([`eslint.config.js`](./eslint.config.js)) is the source of truth, not this
  document.
- Update [`README.md`](./README.md) or the [`docs/`](./docs) site when you
  change or add user-facing behavior.
- Write commit messages following [Conventional Commits](https://www.conventionalcommits.org/)
  (e.g. `fix: correct route matching for optional params`,
  `feat: add support for nested layouts`). Squash noisy WIP commits before
  opening the PR if you can.

## Opening a pull request

Before you start work, make sure a [GitHub issue](https://github.com/cloveteam/clovejs/issues)
exists describing the bug or feature — open one yourself if it doesn't. This
lets maintainers weigh in on the approach before you invest time, and gives
the PR something to link back to.

1. Create a branch off `main`: `git checkout -b my-fix main`.
2. Make your changes, with tests, and verify the checks above pass locally.
3. Push your branch to your fork and open a pull request against
   `cloveteam/clovejs:main`.
4. Fill in the PR description: what changed and why, and how you tested it.
   Link the issue from step 0.
5. A maintainer will review, and CI must be green before merge. Be responsive
   to review feedback — most PRs need at least one round of changes.
6. Once merged, feel free to add yourself to [`CONTRIBUTORS.md`](./CONTRIBUTORS.md)
   in the same PR.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/cloveteam/clovejs/issues) with:

- For bugs: what you expected, what happened instead, and a minimal
  reproduction (a small fixture or snippet is ideal).
- For features: the use case you're trying to solve, not just the API you
  have in mind — there may be a simpler fit within Clove's conventions.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT license](./LICENSE.md).
