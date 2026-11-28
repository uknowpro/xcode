# Local integrations

Use `xcode skills list` to see which definitions are active. The project .claude directory takes precedence over project .xcode, followed by user xcode and user .claude. `xcode skills disable name` removes a skill from this project's model context.

Register an installed local MCP command with `xcode mcp add name -- executable arguments`. `xcode mcp tools name` lists its input schemas and advisory annotations. `xcode mcp call name tool --input input.json` invokes the selected tool. The process has the permissions of the user who starts xcode. xcode does not pass its API token environment variable to the server. [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

Use `xcode extract file.docx --part tables --rows 5` or `xcode extract file.xlsx --sheet Results --rows 10` to inspect readable document data. CSV and TSV work with the same row options. Office and delimited document extraction uses local Python 3. PDF text uses pdftotext. Use --page 2 to pick a page; table output separates columns based on PDF text spacing. Encrypted documents need an authorized application to open them.

Use `xcode db project.sqlite list` to discover local tables and `xcode db project.sqlite table jobs --rows 15 --where status=done` for bounded read-only results. This command requires a Node.js runtime with SQLite support. [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html)

Use `xcode profile credentials work --backend keychain` to store the token with the platform credential service. macOS uses Keychain, Linux needs a working Secret Service and secret-tool, and Windows uses user-scoped DPAPI. Restore file-backed token storage using `--backend file`.
