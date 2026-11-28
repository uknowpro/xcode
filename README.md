# xcode

[한국어](README.ko.md)

A terminal coding assistant for your local project. Connect an OpenAI-compatible endpoint or use OpenAI Responses, Claude Messages, or Gemini GenerateContent. Ask it to find code, propose changes, and verify approved edits.

## Setup

Requires Node.js 22.5 or later on Linux, macOS, or Windows. Download the .tgz from [GitHub Releases](https://github.com/uknowpro/xcode/releases), then run

    npm install -g ./uknowpro-xcode-0.1.6.tgz
    xcode setup
    xcode profile test

Use the same install command with a newer tarball to update. See the [installation guide](docs/install.md) for offline setup, checksums, and xcode completion. The default profile, token, and sessions stay in the existing data directory. Run npm install -g . to install from a checkout.

Enter the **API URL, model ID, and token**. Use a local or remote HTTP or HTTPS address ending in /v1 or /chat/completions. The saved default profile applies to new sessions. Changing the URL keeps the token. The connection test reports plain chat, SSE, and tool calling separately. Use xcode profile models to check advertised model IDs and xcode profile capabilities to see saved probe results. Probe image or PDF input with --only image or --only pdf. Use xcode network to inspect NODE_EXTRA_CA_CERTS and the HTTP_PROXY / HTTPS_PROXY / NO_PROXY configuration. On Node versions that support it, start xcode with NODE_USE_ENV_PROXY=1 to use the environment proxy. Save a diagnostic report with xcode report > xcode-report.json. The report excludes endpoints, tokens, paths, and conversation content. Add --probe --only chat to test the configured connection.

## Work in a project

    cd my-project
    xcode
    xcode ask "Where is the retry policy configured?"
    xcode sessions "retry policy"

xcode searches the current worktree and returns paths and line numbers. Tool calling must be supported by the model endpoint. Type @ and press Tab to complete a file path. Use /paste, /preview, and /send for multi-line input. Tab completes slash commands. Use /status for a compact settings summary, /recall to recover prompts, /copy to copy replies, and Alt+J to switch sessions. Use xcode terminal --accessible for linear output. Set editor shortcuts with xcode terminal --send-key ctrl+x --newline-key ctrl+o. xcode resume restores unsent text and attachment paths. Use xcode draft <id> to retrieve a saved draft without opening its session.

To propose edits and run project verification, use

    xcode check add unit -- npm test
    xcode harness checks implement unit
    xcode --harness implement --write --checks

1. Describe the change. xcode can propose edits, new files, moves, or deletions.
2. Open /diff and scroll using the arrow or page keys. Close with Esc. Use /apply for the full proposal, /apply path1 path2 to accept selected paths and decline the rest, or /reject to decline everything. Either path of a move selects both. Run xcode review check to list conflicts before applying.
3. The verify stage can run a linked check and show its exit code. /check unit runs it manually. Use xcode check run unit --json in scripts. xcode ask and xcode continue exit with code 4 when the latest result of a check is a failure.
4. Use /changes and /undo <id> to inspect or reverse changes applied with version 0.1.2 or later. Undo stops if a file was changed after approval.

Read-only mode is the default. /write on allows proposals, and /checks on allows a compatible harness to run only registered commands for the current project. For one-off requests, use xcode review show, xcode review apply, and xcode continue after xcode ask pauses for review.

## Settings and sessions

- **Global** · xcode setup saves the default model, xcode profile use <name> changes it, and xcode settings shows your profile and project checks. settings.json and a separate token file live under ~/.xcode or XCODE_HOME. XCODE_API_TOKEN overrides a stored token.
- **Session** · /settings shows the active profile, harness, and permissions. Use /new and /resume for parallel or saved conversations, or press the arrow keys and Enter in /sessions to switch. Earlier decisions, file references, changes, and check results are summarized for continuing work. Use /context to inspect the summary.
- **Input** · /attach accepts text, images and PDFs. Use /inputs image on or /inputs pdf on for supported models. For a text-only PDF workflow, xcode can use the optional pdftotext tool.
- **Harness** · xcode harness list shows presets for bug fixes, refactoring, API review, Terraform, Helm, and Kubernetes. Use /harness preview <name> to inspect steps or /harness <name> to switch. xcode harness import <name> <file> accepts custom JSON. Compatible SKILL.md files can be loaded from .claude/skills and .xcode/skills.

File search runs locally. Selected file excerpts, attachments, and outputs from enabled project checks are sent to the configured model endpoint. Run npm test and npm run test:install for verification.

## Automation

Use xcode ask --json for one result or --events for newline-delimited progress. The result distinguishes verification not run, passed and failed. Exit 3 waits for a change review, 4 reports failed registered verification and 1 reports an execution error. A [CI example](docs/ci-example.md) shows how to preserve the result and exit status.

## Model profiles

Use xcode profile show to see the detected adapter, protocol and effective settings.

    xcode setup deepseek
    xcode profile show deepseek
    xcode profile test deepseek --only tools
    xcode --profile deepseek --harness bug-fix --write --checks

Standard DeepSeek Flash, Qwen, and Kimi model IDs are detected automatically. The basic setup uses the server's thinking defaults. For an endpoint that supports these settings, use

    xcode profile tune deepseek --thinking on --effort high
    xcode profile tune deepseek --context-window 65536 --max-tokens 8192 --request-timeout 120

Use --adapter deepseek-flash for a custom model alias, or --adapter compatible for generic Chat Completions. The tool probe checks that the endpoint accepts a follow-up after a tool result. On DeepSeek profiles, recent model-returned reasoning and tool state are saved with sessions locally for replay to the same model endpoint. Older turns are summarized as the replay budget fills.

For Qwen3.6 or Kimi K3, use xcode profile tune <name> --preset coding to try its model-specific sampling settings. Use the default preset when your server does not expose those options. The protocol is inferred from official hostnames or full API paths. You can set --protocol responses, --protocol anthropic, --protocol gemini, or --protocol chat-completions explicitly for other endpoints.

    xcode profile eval deepseek --against deepseek-tuned

Both profiles must refer to the same model and endpoint. The temporary fixture checks file discovery, tool use, checkpoint replay, a local test, citation, and elapsed time. Add --json to either profile eval or profile test for a machine-readable report.

In /diff, use Tab to switch between Diff, Files, and Tests. In Files, use the arrow keys and Space to choose paths. The selection is saved with the pending review. Close the panel, then /apply. In the implement and bug-fix harnesses, an eligible failed test can trigger up to two repair proposals. Approving a repair reruns the same registered check. See the result with /verification.
