# xcode

[한국어](README.ko.md)

A terminal coding assistant that works with your local project and an OpenAI-compatible Chat Completions endpoint. xcode can find and read relevant source files from a question, stream the answer, and show the paths and line numbers it used.

## Install

Requires Node.js 22.5 or later. Run from a checkout on Linux, macOS, or Windows.

    npm install -g .
    xcode setup
    xcode profile test

Setup asks for an API URL, model ID, and token. Both local and remote HTTP or HTTPS addresses work. Use a base URL ending in /v1 or the full /v1/chat/completions URL. Choose HTTPS when the token or project contents need encryption in transit. The saved default profile applies to new sessions. Editing a URL keeps its token unless you change or clear it.

    cd my-project
    xcode
    xcode ask "Where is the invoice retry policy configured?"
    xcode sessions
    xcode resume latest

## Work in a session

- The current Git worktree or starting directory serves as the project scope. xcode can locate filenames, search their contents, read bounded line ranges, and apply AGENTS.md instructions. Use @src/config.ts to point to a known file.
- Use /new and /sessions for parallel sessions, /resume to switch, and /queue to see pending messages. /stop pauses the active message, /continue resumes it, and /next stops it and sends the next queued message. Automatic retry can be enabled with /retry 60 for transient failures. Usage and rate limits pause the queue.
- Use /attach "notes.txt" for UTF-8 text or /inputs image on for a model with image input. /inputs pdf on enables native PDF input. When native PDF is disabled, xcode can extract text locally with pdftotext when installed.
- Read-only is the initial session mode. Use --write or /write on to allow exact replacements in existing source files. /tools shows the tools used in the last or current message.
- The local tool loop needs Chat Completions function calling support. For an endpoint with chat only, set /inputs tools off and attach the context explicitly.

## Harnesses

A harness combines a role, skills, and one or more stages. Stages have separate instructions, tool lists, and completion criteria. xcode saves stage results in the session, so an interrupted turn can continue from the stored stage.

    xcode harness list
    xcode harness roles
    xcode harness show code-review
    xcode --harness deepseek-flash
    xcode harness import my-review harness.json

Predefined harnesses cover general work, focused DeepSeek Flash tasks, review, implementation, infrastructure, and documentation. Use /harness <name> to switch in a session. The project and user skill directories at .claude/skills and .xcode/skills are scanned for compatible SKILL.md files.

A custom harness example

    {
      "role": "backend",
      "stages": [
        {
          "name": "Review",
          "instruction": "Find the relevant callers and trace error handling.",
          "tools": ["glob", "grep", "read"],
          "done": "Summarize findings with file paths and line numbers."
        }
      ]
    }

## Configuration and data

Configuration and sessions live under ~/.xcode by default. Set XCODE_HOME to choose another directory. settings.json contains profiles and custom harnesses. The CLI stores saved tokens separately in tokens.json with user-only permissions where supported. XCODE_API_TOKEN overrides the saved token for the current process.

    xcode profile set work --endpoint https://model.example/v1 --model model-id
    xcode profile use work

File search runs locally. Selected source snippets, active skill context, and attachments are sent to the endpoint configured for the session. ripgrep is used to list search candidates when available, with a built-in fallback. The optional source map summarizes declarations and resolvable relative JavaScript and TypeScript imports.

Run npm test to check file discovery, sessions, token retention, and model streaming against a loopback fixture.
