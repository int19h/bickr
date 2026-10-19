# Repair escaped line breaks in participant notes

This one-time migration repairs literal escape sequences that replace Markdown line breaks in participant notes. It also repairs structured note examples in active runtime messages. It preserves code examples and leaves ambiguous text for review. It leaves archived logs unchanged.

The runtime records a versioned completion marker for each participant. Later requests return that marker without changing the participant again. The migration does not add automatic repair to readers or writers. Remove the migration route and driver after the fleet completes and the operator accepts the results. Keep the completion markers until the runtime removes this migration version.

The driver enumerates nondeleted participants with an active or pending lifecycle. It uses bounded D1 queries with an indexed `bot_id` cursor. It sends each change through the participant runtime. It does not stop participants or enable global maintenance.

Deploy the reviewed runtime to the target environment before this procedure. Use the release worktree for the same commit. Set `TEST_AUTH_SECRET` in the process environment without printing its value. The driver uses Wrangler credentials and the account from `releasePlan`. The environment selects the origin and Wrangler configuration. Test requests include the environment cookie.

Create a private directory under `/build/bickr/scratch/` for the reports. Keep it outside all worktrees. The report contains private participant notes and active messages. The driver creates report files with mode `0600`. Keep the parent directory private too.

Run a preview against test:

```bash
node scripts/migrate-note-newlines.mjs --environment test \
  --report /build/bickr/scratch/note-newlines/test-preview.json
```

Read the private preview before applying it. Each ready entry contains the original text, replacement text, and digest. A digest identifies the exact inspected snapshot. Keep this preview as the backup. Use a new filename for every preview.

Apply that preview:

```bash
node scripts/migrate-note-newlines.mjs --environment test --apply \
  --manifest /build/bickr/scratch/note-newlines/test-preview.json \
  --report /build/bickr/scratch/note-newlines/test-apply.json
```

The driver saves its separate progress report before any mutation. The runtime compares the digest before changing data. If the snapshot changes, the driver records `snapshot_changed`. It never applies a replacement snapshot automatically. Review a fresh preview for those participants.

If the request times out, the driver inspects the durable completion marker. It never repeats an uncertain write in the same pass. If the driver stops, repeat the apply command with the same files. It inspects unresolved participants first and skips completed entries.

Busy participants and participants with pending tool calls remain unchanged. For failures during apply, reuse the apply command. For failures during preview, create and review a fresh preview. If a snapshot changes, create and review a fresh preview. The driver prints counts only. Exit code `2` means that some entries need another pass or review. Exit code `1` means that the command stopped.

After test results pass review, prepare a local Pages proxy with remote production service bindings. Production disables the public proxy intentionally. Keep that host policy unchanged. Make sure that the local proxy uses the production bindings and the intended authentication secret.

Repeat the preview with `--environment production --proxy-origin http://127.0.0.1:8788` and a separate production report. Use the local port that the proxy prints. Use the same environment and proxy origin when applying that preview. The driver accepts only loopback overrides and records the origin in both reports. It rejects reports from another environment or origin. Make sure that the production runtime uses the reviewed release.

Review every ambiguous entry separately. Keep the reports until the migration and any manual corrections complete. Then delete these private backups according to the operator retention policy. The driver creates no recurring job or growing server-side table.
