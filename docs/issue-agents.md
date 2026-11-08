# Working on issues with agents (maintainers)

Everything happens on GitHub. Nothing runs by itself: every trigger is manual until you turn automation on (section 5).

Checked against the official Claude Code documentation: https://code.claude.com/docs/en/github-actions and the action's repository https://github.com/anthropics/claude-code-action

## 0. Current state

- **Labels:** created on `bootkicker/window-memory`: `bug`, `needs-info`, `agent:review`, `agent:fix`.
- **Claude workflow:** `.github/workflows/claude.yml` is on `main` and in use. It answers `@claude` in an issue's comments, in a new or assigned issue's title or body, and in pull request review comments. Only the repository owner (`bootkicker`) can start it (section 2b). It authenticates with a Claude subscription token (the repository secret `CLAUDE_CODE_OAUTH_TOKEN`), uses `claude-sonnet-5-5`, and stops after 15 turns. A run's log in the Actions tab shows the model, the number of turns and the cost (a short reply takes about 3 turns and costs a few cents).
- **Issue template and these guides** are on `main`, so the bug report form and the New issue link's template are live.
- **Automatic triggers:** not enabled (section 5).
- **Permissions:** the job has contents, pull-requests and issues write, and id-token write. It does not have `actions: read`, which lets Claude read CI results: no CI workflow exists. If one is added, add `actions: read` to `permissions:` and set `additional_permissions: actions: read` on the action.

## 1. Triage

Labels (create them once on the Labels page, or with `gh label create`):

- `bug`: added by the bug report form.
- `needs-info`: the report is missing something. Ask the reporter in a comment. Do not guess.
- `agent:review`: ready for an agent to look at and report, without changing code.
- `agent:fix`: ready for an agent to fix and open a draft pull request.

Before an agent starts, check the report:

- The versions and the log file are there. The log file is the one from `docs/reporting-issues.md`.
- Open the log file yourself and remove personal data before any agent reads it. Never paste log content into a public comment.

## 2. Claude: the two options

The Claude GitHub App and the Claude Code GitHub Action are different things:

- **Claude GitHub App** (https://github.com/apps/claude): one GitHub App installed on the repository. Claude's GitHub features share it: the Claude Code GitHub Action acts as this app, and so do Code Review (automatic pull request reviews) and auto-fix in Claude Code on the web. Code Review and auto-fix need no workflow file. Replies to `@claude` come from the workflow file, so the app alone does not answer issue mentions.
- **Claude Code GitHub Action** (`anthropics/claude-code-action`): a workflow file in `.github/workflows/` that runs Claude Code on GitHub's runners. It answers `@claude` in issues and pull requests. With a `prompt` input it runs on any GitHub event, such as a label.

| | Claude GitHub App | Claude Code GitHub Action |
|---|---|---|
| What it is | A GitHub App installed on the repository | A workflow file that runs Claude Code |
| Answers `@claude` in issues and PRs | No, the workflow does | Yes |
| Automatic review of every PR | Yes, Code Review, no workflow file | Only if you write a review workflow |
| You control triggers, prompts and permissions | No, Claude manages them | Yes, in the workflow file |
| Costs | Your Claude plan (see the docs for the current terms) | GitHub Actions minutes, plus API tokens or your subscription token |
| Credentials | Your Claude account | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, or a cloud provider |

Advantages and disadvantages:

- **App.** Advantages: nothing to maintain, and automatic reviews. Disadvantages: less control, and a broad permission set that you accept in full (Actions, Contents, Issues, Pull requests, Workflows and more).
- **Action.** Advantages: you decide the triggers, the prompts, the model and the permissions, and each run has logs in your repository. Disadvantages: you maintain a workflow, you pay for Actions minutes and keep secrets, and anyone who can trigger a run can have Claude act on the repository. Sections 2b and 5 have the trigger rules.

Recommendation for this repository: install the App and use the Action. The Action runs as the App, so you need both.

### 2a. Setup: quick (recommended)

Requires repository admin rights and a GitHub.com repository.

1. Install the GitHub CLI and log in: `gh auth login`.
2. In a terminal, open the repository folder, start `claude`, and run `/install-github-app`.
3. Choose the repository and the authentication: a subscription token made with `claude setup-token`, or an API key.
4. Select the workflow files. Claude pushes a branch and opens a pull request in your browser. Review it and merge it into the default branch. The merge is your decision.

### 2b. Setup: manual

1. Install the Claude GitHub App on the repository (https://github.com/apps/claude). Give it Contents, Issues and Pull requests, read and write.
2. Add a repository secret: Settings → Secrets and variables → Actions → New repository secret. Use `CLAUDE_CODE_OAUTH_TOKEN` (made locally with `claude setup-token`) or `ANTHROPIC_API_KEY` (from the Claude Console). Never paste a key or token into an issue, a comment, a commit or a log.
3. Add `.github/workflows/claude.yml` with the content below, on a branch, and merge it through a pull request. The workflow must be on the default branch for comments to start it.

```yaml
name: Claude Code
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
jobs:
  claude:
    if: >-
      github.actor == 'bootkicker' && (
        (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
        (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
        (github.event_name == 'issues' && (contains(github.event.issue.body, '@claude') || contains(github.event.issue.title, '@claude')))
      )
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: --model claude-sonnet-5-5 --max-turns 15
```

With an API key instead of the subscription token, replace the `claude_code_oauth_token` line with `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`. Replace `bootkicker` with the owner's user name in a fork.

**Who can start it.** Two checks, and both must pass. (1) The `github.actor` test in the `if:` runs the job only for the owner; anyone else's comment or issue starts no job (the run shows as skipped). (2) The action itself refuses anyone without write access to the repository, and refuses bots, unless `allowed_non_write_users` or `allowed_bots` are set. Do not set them: the action's documentation calls `allowed_non_write_users` a significant security risk. Without check (1), anyone with write access could start a run.

**Model and length.** `claude_args` is passed to the Claude Code command line: `--model` sets the model (a full name pins it; an alias such as `sonnet` follows the latest), and `--max-turns` stops a run after that many turns. One value applies to every trigger.

Check it works: comment `@claude say hello` on a test issue, or open an issue with it in the body. Claude replies in the thread, and the run's log in the Actions tab shows the model and the number of turns.

## 3. Manual triggers

- **Claude, interactive:** comment `@claude` followed by a concrete request on the issue or pull request. Claude replies in the same thread and can push commits to a branch. Examples: `@claude implement this based on the issue description`, `@claude find the cause of the TypeError in the dashboard and propose a fix`.
- **Claude, review only:** `@claude review the cause of this issue and reply with the likely file and line. Do not change code.`
- **GitHub Copilot coding agent:** set the issue's assignee to Copilot, or start a task from the repository's Agents tab. Copilot works in a branch and opens a draft pull request. Read it, and check that it adds or changes tests.

## 4. Fix and merge (manual)

1. The agent's work is a draft pull request. Ask it to add a failing test first, then the fix, and to run only the scoped tests.
2. You review the diff and run `bash scripts/check.sh` on the branch.
3. You merge. Agents never merge, publish, tag, change repository visibility, or submit to the Spices store.

Prompt for a fix (for `@claude` or Copilot):

> Fix issue #N in window-memory. 1) Write a failing test in the matching tests/*.test.js file. 2) Make the smallest change that passes it. 3) Run `node --test` on the test files you touched, not the whole suite. 4) Commit with the trailer `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`. 5) Open a draft pull request that links the issue. Do not merge, do not reinstall, do not change visibility, do not paste attachment contents into comments.

## 5. Automatic triggers (not enabled)

To start Claude on its own, add a workflow in automation mode: a `prompt` input makes the action run without an `@claude` mention. This example runs when the label `agent:fix` is added. It is not in the repository. Adding it is your decision, because each run costs Actions minutes and tokens.

```yaml
name: Claude fixes labelled issues
on:
  issues:
    types: [labeled]
jobs:
  fix:
    if: github.event.label.name == 'agent:fix' && github.actor == 'bootkicker'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: --model claude-sonnet-5-5 --max-turns 15
          prompt: "Fix issue #${{ github.event.issue.number }}: write a failing test first, make the smallest change, run only the scoped tests, and open a draft pull request that links the issue. Do not merge."
```

Points to keep in mind:

- Only users with write access can start a run on an issue event, and the `github.actor` test in the example limits it to the owner. Bot accounts are refused unless you list them in `allowed_bots`; do not.
- Issue text is untrusted input. Keep the permissions above to what the job needs.
- Pin the action to the current v1 release (`@v1`), and read its security notes: https://github.com/anthropics/claude-code-action/blob/main/docs/security.md

## 6. Rules for every agent

- Pull requests only, as drafts. No merges, no tags, no releases, no store submission.
- Tests first, the smallest change, scoped test runs. The full check is `bash scripts/check.sh`, run by a maintainer.
- Keep the trailer on every commit.
- Never copy personal data from an attachment into a comment, a commit, or a test.
