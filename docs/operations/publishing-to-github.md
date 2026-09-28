# Publishing this workspace to GitHub

Target repository: <https://github.com/RSelidio/WiwynnRide>

## Important: inspect repository history first

The VS Code workspace provided for this work currently has **no `.git` folder**,
so it has no local branch, remote, or commit history yet. Do not blindly initialize
and push over the GitHub default branch. First open the repository page and check
whether it is empty or already has a README, license, or commits.

### If the GitHub repository is empty

From the project root in PowerShell:

```powershell
git init --initial-branch=main
git remote add origin https://github.com/RSelidio/WiwynnRide.git
git add -A
git status --short
git diff --cached --stat
git diff --cached --name-only
```

Review the staged file list before committing. It must not contain `.env`, local
database dumps, RFID/person data, `node_modules`, `.next`, build output, or
`.osrm-data`. `.gitignore` excludes these local files, but always inspect the
staged list. If a private file appears, unstage it and correct `.gitignore` before
continuing.

After confirming the list is clean:

```powershell
git commit -m "Prepare shuttle prototype"
git push --set-upstream origin main
```

Authenticate through Git Credential Manager or VS Code's GitHub sign-in. Never
put a password or access token in the remote URL or a script.

### If the GitHub repository already has commits

Do not force-push and do not replace its default branch. Clone the repository to
a **separate clean folder**, then merge/copy this workspace's source changes into
that checkout while preserving existing repository files and history. Resolve
any conflicts, run the validation commands below, inspect the staged files, then
commit and push normally. If unsure, ask a repository maintainer to help with the
first merge.

## Before every push

From the project root:

```powershell
npm run typecheck
npm test
npm run typecheck --prefix apps/driver
git status --short
git diff --check
git diff --cached --name-only
```

Review the source diff and staged file list. Check that `.env` remains ignored:

```powershell
git check-ignore .env .osrm-data node_modules apps/driver/node_modules
```

Do not commit production configuration, live data exports, database backups,
RFID card UIDs, driver GPS logs, screenshots containing personal data, private
keys, EAS credentials, or signing files. The checked-in `.env.example` is a
placeholder template; populate real values only in the private environment.
If a secret or real personal data has ever been committed, removing it in a new
commit is not enough—rotate the secret and follow the organization's Git history
cleanup procedure.

## After publishing

1. In GitHub, verify the latest commit and default branch. Keep branch protection
   and review requirements enabled for shared/production code.
2. Configure deployment secrets and environment variables in the approved secret
   store/CI variable groups, not in GitHub source files.
3. Provision separate DEV and PROD databases; run migrations through the release
   process only after a backup and staging test.
4. Use the database maintenance instructions in
   [database-maintenance.md](database-maintenance.md) to back up and test restore.
