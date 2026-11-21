# Releasing the phone app

The phone app (`apps/approve`, served at `approve.suveren.ai`) holds a person's keys. Anyone who can change the code it serves can use those keys. So the app is released in a way anyone can check.

This page says how a release works, what a check proves, what it does not prove, and how to verify a release yourself.

Status: the pipeline is built; `apps/approve` does not exist yet. Until it does, the build uses the fixture page of `packages/approval-card` as a stand-in, so every step can be tried.

## How a release works

Three workflows, three jobs. Each has only the permissions it needs.

1. **Build** (`.github/workflows/approve-build.yml`). Runs when someone pushes a tag `approve-vX.Y.Z` that points at a commit on `main`.
   - Builds the app with pinned Node and pnpm and the frozen lockfile.
   - Builds it a second time on another machine. The two builds must be byte-identical, or the workflow stops.
   - Writes `manifest.json`: the SHA-256 and size of every served file, plus the tag and the commit.
   - Signs every file and the manifest (GitHub artifact attestation, `actions/attest-build-provenance`).
   - Creates a GitHub release holding `manifest.json` and `approve-dist.tar.gz` (the files). It puts nothing on the web.
   - A manual run (`workflow_dispatch`) does everything except create the release. Use it as a dry run. It still creates attestations, for the branch it ran on.

2. **Publish** (`.github/workflows/approve-publish.yml`). Starts only by dispatch, and a dispatch alone does nothing.
   - The dispatch must carry a ticket. The workflow fetches the ticket from the Authority Server and checks it: genuine, an action of type `release`, the right profile, younger than 30 minutes, and **bound to this exact source commit**. The commit must be the commit of the release tag.
   - It then checks the release's files: they match the manifest, and each file (and the manifest) has an attestation from the build workflow for this tag and this commit. A file that was not built by that workflow is refused.
   - Only then does the `deploy` job run. It is the only one that can reach the hosting credentials. It deploys the verified files byte for byte, and afterwards fetches the live site and compares it with the manifest.
   - Last, it attaches `deployed.json` to the release. That marks the release as the live one.
   - It takes the same five inputs as the website's gated release, so the gated deploy connector can start it. The connector needs one change first (see "Open decisions").

3. **Compare** (`.github/workflows/approve-compare.yml`). Runs every 6 hours.
   - Takes the newest release marked live, and checks that its manifest is the signed one.
   - Fetches every file from the live site and compares its SHA-256 with the manifest.
   - Red when a file differs, is missing, or when the live page loads a file the release does not list (including a script from another address). Red also when the site cannot be read.
   - The result is public in the Actions tab of this public repository: the run status, its badge (`.../actions/workflows/approve-compare.yml/badge.svg`) and a summary naming each file that differs.

The manifest, the comparison and their tests are in `scripts/approve-release.mjs` (Node only, no packages). Test with `pnpm test:approve-release`.

## What this proves

- The files of a release were built by this repository's build workflow, from the commit the tag names, and the build can be repeated: a second build gives the same bytes.
- A person approved that commit for release. The ticket binds the commit, and the publish workflow checks it before anything goes live.
- What the live site serves is what the release contains. If someone changes one byte of one file, for everyone, the comparing job turns red within 6 hours.

## What this does not prove

- **Code served to one person only.** Whoever controls the hosting or the domain can serve different files to a single person, for example by address or by time. The comparing job asks from one place and sees one answer. It cannot find this. This is stated on the security page.
- **The hosting account itself.** Someone with the hosting credentials can change the live site without the publish workflow. The comparing job then finds it (if served to everyone), but cannot prevent it.
- **That the ticket was meant for this repository.** The public view of a ticket hides the repository and workflow it was issued for. A valid ticket for the same commit hash in another place would pass. This is the same gap as in the website's release.
- **The Authority Server's own signature.** The ticket check reads "signature valid" from the issuer itself. It is trust in the issuer.
- **That the source is good.** The attestation says where the bytes came from, not that the code is free of mistakes.
- **A person who never looks.** The comparing job is only worth something if someone watches the badge. The scheduled run also stops after 60 days with no repository activity. A badge that stops updating is the sign. Re-enable it in the Actions tab.

## Verify a release yourself

You need the `gh` command line tool (logged in) and the release tag, for example `approve-v0.1.0`.

```bash
TAG=approve-v0.1.0
REPO=suverenai/suveren-gateway          # the repository that holds the release
gh release download "$TAG" --repo "$REPO" --pattern manifest.json --pattern approve-dist.tar.gz
mkdir dist && tar -xzf approve-dist.tar.gz -C dist

# 1. Every file carries an attestation from the build workflow, for this tag.
COMMIT=$(gh api "repos/$REPO/commits/$TAG" --jq .sha)
for f in manifest.json $(find dist -type f); do
  gh attestation verify "$f" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/approve-build.yml" \
    --source-ref "refs/tags/$TAG" --source-digest "$COMMIT" >/dev/null && echo "ok  $f" || echo "FAIL $f"
done

# 2. The files match the manifest, and the live site matches the manifest.
node scripts/approve-release.mjs compare --manifest manifest.json --dir dist
node scripts/approve-release.mjs compare --manifest manifest.json --url https://approve.suveren.ai
```

Both comparisons print `GREEN` and exit 0 when everything matches. The script is in this repository (`scripts/approve-release.mjs`); the comparison needs nothing else.

To rebuild yourself: check out the tag, use the Node and pnpm versions pinned at the top of `approve-build.yml`, run `pnpm install --frozen-lockfile`, build the app, and run the `manifest` command. The manifest must equal the released one.

## Open decisions (Andreas)

1. **Hosting target and credentials.** The plan names a separate Vercel project at `approve.suveren.ai`. Not chosen yet. The `deploy` job in `approve-publish.yml` has a marked placeholder step that fails on purpose. The credentials go into secrets of a GitHub environment named `approve-production` (add required reviewers), never into the repository. The host must send the Content Security Policy header from section 8 of the plan and add no scripts of its own.
2. **The mandate and profile for app releases.** The workflow accepts a ticket whose profile id contains `deploy@` (`APPROVE_TICKET_PROFILE` in `approve-publish.yml`), the website's profile. Decide whether app releases get their own profile.
3. **Where the public comparison result lives.** The workflow status, its badge and the run summary are public now. A JSON file in another public place (the security page, for example) has a disabled placeholder step in `approve-compare.yml`.
4. **The gated deploy connector** (`hap-deploy-mcp`) looks up the "deployment" of the repository by URL and re-derives the source commit from the website's artifact layout. A GitHub release is neither. Before the connector can start `approve-publish.yml`, it needs a second kind of release (the release page as `deployment_url`, the tag's commit as `commit`). Until then, only a manual dispatch with a real ticket works.
5. **Site address.** `https://approve.suveren.ai` is the default. Set the repository variable `APPROVE_SITE_URL` to change it (a customer's own copy, a test address).
