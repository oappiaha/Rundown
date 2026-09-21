# Assisted topic preparation — completed locally

September 15, 2026. Claude Code implemented the frontend in the isolated retained
checkout; root Codex implemented the backend, integrated/reviewed the result,
and added two final recovery/consent guards with failing-before-fix regressions.

## Delivered

Inbox → Assisted preparation previews the saved text to send, names the configured
provider/model and remaining request allowance, and requires explicit consent.
Generate creates a separate suggested summary and 3–5 talking points. Edit them,
choose Append to context, then Save idea. Original notes and source attribution
remain intact, and copying/publishing into shows still uses the existing controls.

The server stores a durable PreparationRun using an idempotency UUID and the
source idea's revision. Duplicate submissions do not repeat provider calls.
Preparation never writes the live clock, saved shows or inbox content. Edited or
archived ideas make older suggestions stale. Failed/incomplete provider responses
produce durable safe errors; no automatic retries. A 90-second interrupted lease
permits a deliberate retry; all attempted requests count toward the UTC-day cap.

Input is capped at 12,000 characters plus fixed system instructions, output at
1,200 tokens; daily cap defaults to 10 attempts. These are request/token controls,
not a dollar budget. AI is disabled by default and requires an explicit model
and Anthropic API key in server configuration (see apps/api/README.md).

## Verification and evidence

- API: Ruff, Pyright, and 84 tests pass. Real installed-SDK HTTP roundtrip to a
  local Anthropic-protocol fixture proved exact preview input, dummy credentials,
  bounded output, failures without retries, idempotence, overlapping-request
  refusal, edits during generation, daily cap and exact clock-row preservation.
- Actual API process restart retained results, unchanged topic context and the
  exhausted daily allowance.
- Web: lint, typecheck, production build and 102 tests pass (83 prior, 19 added).
- Claude browser proof: 67 initial desktop/390px touch checks, then 32 focused
  rework checks for filter persistence, pending replies through empty selection,
  guarded resend, dropped responses and wording. Real fixture-backed API.
- Root independently drove the compiled app: consent, exact input preview,
  generation without mutation, edited suggestions surviving view/refresh/filter
  changes, local append, explicit save, reload, source attribution, stale external
  edit with explicit recovery, and fresh 390px touch editing without overflow.
- Root tested the final guards in Chromium: aborting an actual completed provider
  response and revealing its run later preserves edits to the older suggestion;
  a controlled provider/model configuration response clears consent without any
  real provider POST. Separately, an actually disabled API showed setup guidance,
  refused generation with 503 and consumed zero requests.

Round artifacts: `/private/tmp/dienda/rundown-prep/`. Reports:
`backend-evidence.md`, `frontend-evidence.md`, `integrated-hashes.json` and
`root-acceptance.md`. Runtime JSON: `evidence/backend.json`, `evidence/restart.json`,
`evidence/root-ui/result.json`, `recovery-result.json`, `off-result.json`.
Fixture, seed and Playwright scripts are retained alongside reports/screenshots.
Use a fresh disposable DB and the explicit loopback test origin to reproduce.

## Lessons captured

Per-idea review state must live at InboxView lifetime, not inside a panel that
unmounts when filtering clears selection. Keep async sequence counters and pending
requests in that same store. Finding a previously unanswered generation must use
normal edit-preserving adoption, and changing provider/model invalidates consent.
Regression tests cover each case; stale-topic recovery has a visible reload action.

## Limits and release status

Unapplied suggestion edits are in-memory: ordinary navigation/filtering preserves
them, a full browser reload restores the server's generated suggestion. The
production model's response quality/account access was not tested; all application
generation traffic used the local fixture. Configuration and enablement remain
operator choices. Next: opt-in recurring RSS collection with visible scheduling.

Local build only: no commit, push, deployment, OBS or launchd changes; live data
untouched. Temporary servers stopped and disposable runtime DBs removed after
read-back. The preexisting dirty worker checkout remains retained; no new worktree
or branch was created. Detailed cleanup ledger is in round state.md.
