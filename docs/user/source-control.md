# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin, Tangled, and Linear to clone/publish repos, review and merge pull requests, manage issues, and watch CI.

## Connect an account

Install Git and authenticate on the machine running your T3 Code server (for remote environments, do this on the remote machine), then click **Rescan** in **Settings → Source control & issues**.

| Host                               | Setup                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                         | 1) Save a token in **Settings → Source control & issues → GitHub**, 2) set `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` + `GH_HOST` for Enterprise), or 3) sign in with [GitHub CLI](https://cli.github.com/) 2.81.0+ (`gh auth login`; use `--hostname` for Enterprise). Pick accounts or disable hosts in Settings when multiple `gh` logins exist.                                                                                |
| **GitLab**                         | Install [GitLab CLI](https://gitlab.com/gitlab-org/cli) and run `glab auth login`.                                                                                                                                                                                                                                                                                                                                        |
| **Forgejo / Gitea**                | Install [`fj`](https://codeberg.org/forgejo-contrib/forgejo-cli) (`fj --host https://your-server auth add-token`) or [`gt`](https://gitea.com/gitea/cli) 2.0+ (`gt auth login --host https://your-server`; it replaces the archived `tea`, so sign in again). Prefers `fj`, falls back to `gt` (use `gt` for subpath-hosted servers). Use full URLs when multiple servers exist.                                          |
| **Bitbucket**                      | Save a repo/project/workspace **Access token** or **Atlassian email + API token** (with repo/PR read-write, `read:user:bitbucket`, `read:workspace:bitbucket`) in **Settings → Source control & issues → Bitbucket**, or set `T3CODE_BITBUCKET_ACCESS_TOKEN` / `T3CODE_BITBUCKET_EMAIL` + `T3CODE_BITBUCKET_API_TOKEN` in the server env (or [`service.env`](./background-service.md#configure-the-service-environment)). |
| **Azure DevOps**                   | Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), run `az extension add --name azure-devops`, then `az login`.                                                                                                                                                                                                                                                                                           |
| **GitCafe**                        | Save a token in Settings, set `CAFE_TOKEN` (+ `CAFE_HOST`), or install `@gitcafe/cli` and run `cafe auth login --host https://git.cafe/api`. Line comments are not yet supported; stack merges/updates are native.                                                                                                                                                                                                        |
| **Cursor Origin**                  | Install [Origin CLI](https://cursor.com/docs/origin/cli) and run `origin auth login` (`origin auth setup-git` if push prompts for credentials). Uses private HTTPS repos; GitHub-mirrored PRs stay on GitHub.                                                                                                                                                                                                             |
| **TanStack Source** (private beta) | Set `T3CODE_FEATURE_FLAGS=tanstack_source` and restart the server. Save a token in Settings, set `SRC_TOKEN`, or run `src auth login --web`. Supports live CI logs, private PRs on public repos, and issues.                                                                                                                                                                                                              |

> Note: Git `push` and `clone` still require Git SSH/HTTPS credentials on the server, separate from API tokens.

> Note: With several `gt` servers and no `fj` login, `owner/repo` and newly published repositories go to `gt`'s default server (`gt config set default_host https://your-server`). With several `gt` accounts on one server, pick one with `gt auth switch <user> --host https://your-server`. If an SSH remote uses a different host name than the server's web address, run `gt config set ssh_host <ssh-host> --host https://your-server`.

### Tangled

Open **Settings → Source control & issues**, expand **Tangled**, and sign in with your atproto account. Public repositories read without a sign-in; opening, merging, closing and commenting on pull requests need one. Pushing goes over SSH, so add the server's SSH key in [tangled.org settings](https://tangled.org/settings).

- Repositories on a self-hosted knot work too: T3 Code recognizes a remote such as `git@knot.example.com:did:plc:…`, or `git@knot.example.com:alice.example.com/repo` when the knot's host name starts with `knot`, and clones and fetches from the knot itself. For a knot named otherwise, use the repository-DID form of the remote. Git uses the server machine's own SSH settings, so a knot reachable only on a private network needs a `Host` entry there. To publish new repositories to your knot, enter its host name under **Knot for new repositories** in the Tangled settings.
- T3 Code knows a Tangled repository by its own identity, so renaming it or changing your handle keeps its project, threads and pull requests together.
- Tangled keeps each submission of a pull request as a [round](#review-a-change-round-by-round), and a push alone does not make one. When T3 Code pushes a branch with your open pull request, it submits the new commits as the next round, so a stack of Jujutsu changes on one bookmark stays one pull request. If that fails, the push still stands and its notice says why. After pushing from elsewhere, choose **Resubmit** from the pull request's menu (its status menu on mobile).
- Tangled merges by rebasing onto the target branch, the only merge method offered. It has no draft pull requests, requested reviewers, review approvals or line comments; comments apply to the whole pull request. Checks come from the repository's spindle; a run for a pull request from outside the repository waits until a collaborator approves it on Tangled.
- Publishing a project to Tangled creates a public repository in your account on the default knot, `knot1.tangled.sh`. Tangled has no private repositories. To use another knot, create the repository on tangled.org, then add it by its URL.

## Start, clone, or publish a project

- **New project**: Run **New project** from the command palette (`Cmd/Ctrl+K`) or **Add Project** to initialize a new Git repo in `~/.t3/projects/<slug>` with a README, icon, and first commit (optionally creating a private GitHub repo).
- **Clone**: Use **Add Project** to pick a host (enable non-GitHub hosts in **Settings → Source control & issues**) or paste a Git URL or web page URL. Cloning runs in the background so you can draft your first prompt immediately; falls back to HTTPS if SSH auth fails. Enable **Clone into host folders** (**Settings → Threads**, or **Source control** on mobile) for `ghq`-style `<host>/<owner>/<repo>` paths.
- **Publish**: For a local repo without a remote, **Publish Repository** creates the remote, adds `origin`, and pushes commits.

## Review turn changes

A turn's diff shows only that turn's own edits, commits, and conflict fixes—excluding unrelated files brought in by a pull, merge, or rebase. Use the branch comparison to view everything changed against your base branch.

- **Commits view** (web/desktop): Switch the Diff pane source picker to **Commits** to inspect the latest 100 local commits one by one.
- **Commit links**: Links to local commits open in the Diff pane (follows **Settings → Diffs → Open pull requests in T3 Code**; `Cmd/Ctrl+Click` opens in browser).
- **Multi-repo projects**: Use the repository picker in the Diff pane and expand per-repo rows in thread details. See [Projects with several repositories](./multi-repo-projects.md).

## Create, review, and merge pull requests

- **Create**: Commit, push, and open PRs from a thread's source control actions (jj in a [Jujutsu workspace](#jujutsu-repositories), with the same hosting integration and writing settings). Configure AI-generated commit/PR writing style in **Settings → Source control & issues → Commits & pull requests** (**Repository conventions** or **Custom instructions**).
- **Review**: Open **Pull requests** to inspect diffs, comments, checks, commits, and request reviewers. Draft line comments stay local until submitted. If new commits are pushed while you review, click **Load new commits** before merging or submitting.
- **Saved views**: Save and update filter/sort setups under **Views → Save current view** (stored per device).
- **Mark files viewed**: Check off files in the **Code** tab to collapse them (reopens as **Changed** on new pushes). Syncs natively with GitHub; stored on your T3 Code server for other hosts. An earlier round on its own keeps no ticks, since a tick records the latest version of a file; **Changes since round N** keeps them.
- **Mobile**: Open **Pull requests** across environments (cached lists, details, guides, and diffs stay readable offline). Tap **Work on PR** to start a worktree thread on the PR's branch.
- **Quick actions & options**:
  - Enable **Remove agent credits when merging** in **Settings → Source control & issues** to strip recognized agent co-author/generated-by trailers on GitHub merge/squash commits (keeps human co-authors).
  - Hold `Shift` in the GitHub PR list (web/desktop) to drag-close multiple PRs (`Esc` cancels).
  - GitHub, GitLab, and Azure DevOps support auto-merge; GitHub also supports approving fork workflows and opening revert PRs.
  - Azure DevOps comments must be edited on the host site; Bitbucket cannot reopen declined PRs.

### Review a change round by round

Some hosts, such as Tangled, keep every resubmission of a change request as a numbered round. On those, the **Code** tab on web and the changed files on mobile offer a round picker. It opens on the latest round. Pick an earlier round to read it as it was, or **Changes since round N** to read only what changed after the round you last reviewed, such as an agent's next iteration. Line comments are written on the latest round, as they are from **All commits**.

### Review guides (beta)

Turn on **Settings → Source control & issues → Review guides** to add a **Guide** tab to pull requests. Click **Write guide** to have Claude or Codex read the PR in a temporary read-only checkout and produce an ordered tour of the change (highlighting **Look closely** spots and grouping mechanical changes at the end).

- Customize emphasis/ordering via **Review guide instructions** in **Settings → Source control & issues** (project-overridable).
- On web, select lines in any stop to add review comments or ask an agent about that stop.
- Agents can also generate guides for multiple PRs when asked. Choose **Rewrite guide** from the PR's **⋯** menu after new pushes.

### Pull request sharing across environments

Disabled by default. In **Settings → Environments → Pull request sharing** (**Pull request routing** on mobile), opt in trusted environments to **Read PRs** or **Read and act** so review reads/actions can route through another connected environment signed into the same account on the same host (credentials never leave their machines). Enable on both source and target environments; only grant **Read and act** to environments you control.

## Linked pull requests and watching

Threads can link multiple PRs (even across repos on the same host). Creating a PR via Git actions, `gh pr create`, `glab mr create`, or an agent's `link_pull_request` links it automatically; manage links from **Linked items** or the command palette.

- **Agent PR tools**: Agents can read, open, update, comment on, and merge PRs in the thread's repo using your configured sign-in (refusing merges if the head moved since last read).
- **Watch / babysit a PR**: Ask an agent to watch or babysit a PR (or toggle it in **Linked items** / click the eye icon in thread details). The server polls every 2 minutes and wakes the agent on failed checks, passed required checks, new comments/reviews from others, conflicts, merge-queue drops, or merge/close.
  - Watched threads stay in the **Working** section while checks run (or until merge/close if the agent is waiting to act) and never auto-settle.
  - Watching stops automatically on merge/close, Stop, settle/archive, 10 comment-only wakes in a row, or 8 consecutive read failures. Subagents cannot watch PRs—the parent thread watches instead.

## GitHub stacks

The Pull requests page displays stack layer positions and navigation:

- **Merge stack**: Merges the selected PR and every open layer below it together, respecting branch rules and merge queues.
- **Rebase stack**: Updates remote branches bottom-to-top without modifying your local checkout (may rewrite history and restart checks).

## Issues

Open **Issues** from the sidebar utility row or **Open issues** in the command palette to browse, filter, search, save views, comment, edit, and transition issues across GitHub, GitLab, Azure DevOps, Forgejo, and Linear.

- **Linear**: Connect an API key in **Settings → Source control & issues** and bind one or more teams per project (supports multiple Linear accounts). Agents file new issues in the first bound team unless another is named.
- **Link to threads**: Click **Link to this thread** on an issue beside a thread (or let agents call `link_issue`) to track it in **Linked items**.
- Remote issue writes require the `source-control:write` scope.

## Jujutsu repositories

T3 Code supports [Jujutsu](https://jj-vcs.github.io/jj/) repositories colocated with Git. Install Jujutsu 0.46.0 or newer on the machine running the T3 Code server, including the remote machine when using a remote environment. Git is still required for the shared object store and diff rendering.

jj manages changes, bookmarks and workspaces. Hosting integrations use the colocated Git store and the same accounts, tokens and writing settings as Git projects. Adding or cloning a project does not automatically convert a Git repository to jj.

Terms follow the repository: bookmarks instead of branches, workspaces instead of worktrees, changes instead of commits. New isolated thread environments use jj workspaces, with the same submodule initialization settings as Git worktrees. Existing Git worktrees remain Git checkouts. Idle jj workspaces follow the same cleanup settings as Git worktrees, but are kept, with an explanation, while they hold uncommitted tracked edits, a description, conflicts, or commits not on a bookmark. **Uncommitted changes** also keeps untracked files but deletes ignored files, including `.env`. **Any local files** keeps ignored files except `node_modules`; **Edited tracked files** allows untracked and ignored files to be removed, like Git cleanup. These files remain intact until jj successfully forgets the workspace. Stale workspaces and workspaces where jj is unavailable are kept without updating their files. Cleanup never moves your local bookmarks.

Checkpoints snapshot the working-copy change without committing it or moving bookmarks. Restoring a turn restores the full saved workspace, not just the files shown in its diff. `jj undo` undoes an ordinary restore; if a restore had to recover a checkpoint jj no longer knew about, find that restore in `jj op log` to undo it.

### Detecting the version control system

T3 Code uses the nearest `.jj` or `.git` marker, resolving symlinks first. When both are at the same root, jj takes precedence. A nearer Git checkout inside a jj repository still uses Git.

If jj is not found on the server’s PATH, is older than 0.46.0, or cannot run, a colocated repository uses Git instead and shows a notice explaining why. Colocated Git has a detached HEAD: commits won't be on a branch; push needs a branch. Detection notices server executable path or modification-time changes automatically and rechecks successful probes at least every five minutes. **Settings → Source Control → Rescan** refreshes immediately. **New project** and cloning still create Git repositories.

An existing `.t3code/vcs.json` preference is honored: `{"vcs":{"kind":"git"}}` selects Git without a notice, `"jj"` selects jj without automatic fallback, and `"unknown"` or an omitted kind uses automatic detection and fallback. Explicit driver requests take precedence. In a colocated repository, jj automatically tracks this file, so the preference will be included in pushes unless you explicitly exclude it.

If you run `jj git init --colocate` inside a Git linked worktree, T3 Code keeps using Git there and shows a notice that jj in linked Git worktrees is unsupported. If the repository explicitly prefers jj, source control actions are refused with that explanation instead.

For a non-colocated jj repository, the unsupported reason explains the colocation requirement first. If jj is also missing, it additionally reports that Jujutsu was not found on the server’s PATH and asks you to install jj and rescan.

### Commit, push and pull

Committing runs `jj commit`, using your typed message first, then an existing change description, and generating one only when both are empty. A new bookmark uses the same selected text. T3 Code selects the workspace's bookmark, or the nearest bookmarked descendant or ancestor of `@` in an ordinary workspace. Editing in the middle of a feature stack pushes its feature bookmark without rewinding the descendant tip or moving `main`. If the agent already committed the work and `@` is empty, T3 Code can advance the bookmark without creating another empty commit.

After you amend, squash, describe or rebase changes under a pushed bookmark, **Push rewrite** replaces their pushed versions. Push still refuses when the remote has anything else, such as someone else's commits, or moved since jj last fetched.

Pull fetches the remote and refuses when the selected bookmark has unpublished commits. It rebases the existing working-copy change and its unbookmarked descendants onto that bookmark, keeping descriptions and edits, including dirty files. Automatic pull doesn't apply to Jujutsu repositories; use **Pull**.

### What is different under Jujutsu

- **Git hooks do not run** for commits made through T3 Code. Hooks that read the Git index, such as
  `lint-staged` or a staged-diff format check, see nothing under Jujutsu, so T3 Code skips them
  rather than reporting a hook run that did nothing. Run them yourself if you depend on them.
- A change with conflicts cannot be committed or pushed until you resolve it, and its diff shows one side of each
  conflicted file rather than the markers on disk.
- Jujutsu refuses to snapshot a new file above `snapshot.max-new-file-size`, 1 MiB by default. That
  file is outside checkpoints, so reverting a turn leaves it on disk. Raise the limit in your own
  Jujutsu config if you want those files tracked.
- A repository without a reachable colocated Git store remains unsupported. Source control actions are disabled with the reason, and checkpoints are skipped. Use a Git-colocated repository.

## Troubleshooting

- **Not authenticated**: Run the host's CLI login on the server and click **Rescan** (for Bitbucket/tokens, verify Settings or server env vars).
- **GitHub verification fails**: Upgrade `gh` to 2.81.0+ or save a token in Settings.
- **Push fails**: Check Git SSH/HTTPS credentials separately from API auth.
- **Fork PR badge missing**: Set upstream with `git branch --set-upstream-to=<remote>/<branch>`.
