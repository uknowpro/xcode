# xcode

[한국어](README.ko.md)

A terminal coding assistant for your local project and an OpenAI-compatible Chat Completions endpoint. Ask it to find code, propose changes, and verify approved edits.

## Setup

Requires Node.js 22.5 or later on Linux, macOS, or Windows. From the checkout, run

    npm install -g .
    xcode setup
    xcode profile test

Enter the **API URL, model ID, and token**. Use a local or remote HTTP or HTTPS address ending in /v1 or /chat/completions. The saved default profile applies to new sessions. Changing the URL keeps the token. The connection test reports plain chat, SSE, and tool calling separately.

## Work in a project

    cd my-project
    xcode
    xcode ask "Where is the retry policy configured?"
    xcode sessions

xcode searches the current worktree and returns paths and line numbers. Tool calling must be supported by the model endpoint. Type @ and press Tab to complete a file path. Use /paste followed by /send for multi-line input.

To propose edits and run project verification, use

    xcode check add unit -- npm test
    xcode --harness implement --write --checks

1. Describe the change. xcode prepares a change set for existing or new text files.
2. Open /diff, scroll with the arrow or page keys, and close it with Esc. Use /apply or /reject to decide.
3. After approval, the verify stage can run the registered check and show its exit code. /check unit runs it manually.

Read-only mode is the default. /write on allows proposals, and /checks on allows a compatible harness to run only registered commands for the current project. For one-off requests, use xcode review show, xcode review apply, and xcode continue after xcode ask pauses for review.

## Settings and sessions

- **Global** · xcode setup saves the default model, xcode profile use <name> changes it, and xcode settings shows your profile and project checks. settings.json and a separate token file live under ~/.xcode or XCODE_HOME. XCODE_API_TOKEN overrides a stored token.
- **Session** · /settings shows the active profile, harness, and permissions. Use /model or /harness to switch, and /new, /sessions, or /resume for parallel or saved conversations.
- **Input** · /attach accepts text, images and PDFs. Use /inputs image on or /inputs pdf on for supported models. For a text-only PDF workflow, xcode can use the optional pdftotext tool.
- **Harness** · xcode harness list and xcode harness show implement show the presets and their steps. Use xcode harness import <name> <file> for custom JSON. Compatible SKILL.md files can be loaded from .claude/skills and .xcode/skills.

File search runs locally. Selected file excerpts, attachments, and outputs from enabled project checks are sent to the configured model endpoint. Run npm test and npm run test:install for verification.
