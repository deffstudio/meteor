# Contributing to METEOR-FLOW

This project follows **GitHub Flow**: `main` is always in a working, deployable state, and all
changes land via short-lived branches and Pull Requests.

## Workflow

1. **Branch** off the latest `main`:
   ```bash
   git switch main && git pull
   git switch -c feat/<short-kebab-description>
   ```
2. **Commit** focused changes. End commit messages with the trailer:
   ```
   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   ```
3. **Verify** before pushing (see below).
4. **Push** and open a PR against `main`:
   ```bash
   git push -u origin feat/<...>
   ```
   Open: `https://github.com/deffstudio/meteor/compare/main...<branch>`
5. **Review** → CI must pass → **squash-merge** → delete the branch.

## Branch naming

| Prefix    | Use for                                  |
| --------- | ---------------------------------------- |
| `feat/`   | new features                             |
| `fix/`    | bug fixes                                |
| `docs/`   | docs / PRD-only changes                  |
| `chore/`  | tooling, deps, CI, housekeeping          |

## Verification gate (run before every PR)

There is **no test suite**. Correctness is gated by the type checker plus a smoke run:

```bash
npx tsc --noEmit     # must be clean (CI enforces this)
npm run scan         # one-shot scan should print the top-N table
```

## Safety rules

- Keep **`DRY_RUN=true`** as the default. Any new on-chain action must be gated by it.
- Max swap slippage stays hard-clamped to **1% (100 bps)** — do not bypass.
- Never commit `.env` or any secret. `.env` is git-ignored; only `.env.example` is tracked.
- If a change alters behavior described in the PRD, update **`docs/PRD.md`** in the same PR and
  add a line to its Changelog.

## PRD changes

The product spec lives at `docs/PRD.md` and is versioned like code — edit it on a branch and
merge via PR so spec and implementation evolve together.
