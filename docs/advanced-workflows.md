# Advanced workflows

## Working in the terminal

Use `/answer find <text>` to find words in saved replies and `/answer outline` to move through headings. `/answer live` returns to the stream. In the draft editor, use `/paste` to enter several lines and `/preview` to review them before sending. `/queue` lists pending messages. Inspect `/help` for queue actions and current terminal shortcuts.

## Files, edits, and verification

Run `xcode index` to update the local source catalog. Use `xcode symbol` for definitions or references, `xcode code-history` for Git context, and `xcode tree-diff` to compare revisions. Run `xcode review show` to inspect a proposal and `xcode review check` to verify its preconditions before applying it. Preview an undo or redo with `xcode undo --preview` or `xcode redo --preview`.

Register checks with `xcode check add <name> -- <executable> <arguments>`. Use `xcode check plan <names...> --output plan.json` to save the dependency order, `xcode check run-plan plan.json --json` to execute it, and `xcode check resume-plan <id> --json` to continue an interrupted run. See `xcode help` for report formats, parallel execution, and comparisons.

## Models, policies, and backups

Use `xcode usage` for usage reported by the provider and `xcode attempts` for recent request records. Review `xcode policy list` before changing a project's transmission rules. `xcode policy preview` previews the model destination, pending attachments, and how much session history is available. `xcode policy offline on` disables commands that call the model or start external tools. When restoring an encrypted session backup, use the same password with `--password-stdin`. Follow the [recovery guide](recovery.md) when rolling back the application version.

## Release verification

`npm run package:release` builds twice and records the archive checksum. `npm run benchmark:workspace` measures a generated set of 1,000 files. Run `npm run compare:release -- previous.json candidate.json` with release reports to compare package size, workspace search, memory, and install results. The CI archive includes its commit, environment, and verification results.
