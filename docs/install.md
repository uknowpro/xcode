# Install or upgrade xcode

Install Node.js 22.5 or newer and npm. For an offline installation, bring the Node.js installer and the release .tgz to the machine. xcode has no npm runtime dependencies. Keep the downloaded package and its checksum in the same folder.

Linux

```sh
sha256sum -c SHA256SUMS
npm install --offline -g ./uknowpro-xcode-<version>.tgz
xcode setup
```

macOS

```sh
shasum -a 256 -c SHA256SUMS
npm install --offline -g ./uknowpro-xcode-<version>.tgz
xcode setup
```

Windows PowerShell

```powershell
Get-FileHash .\uknowpro-xcode-<version>.tgz -Algorithm SHA256
Get-Content .\SHA256SUMS
npm install --offline -g .\uknowpro-xcode-<version>.tgz
xcode setup
```

Substitute the version in the downloaded filename and verify that the hashes match before installing. Update with the same install command and a newer archive.

Generate shell completions with `xcode completion bash`, `xcode completion zsh`, `xcode completion fish` or `xcode completion powershell`. Save the output as a shell script and load it from your shell profile. For PowerShell use `xcode completion powershell | Set-Content xcode-completion.ps1` and then `. .\xcode-completion.ps1`.

Use `xcode worktrees` to find the path to an existing worktree. Use `xcode --cwd /path/to/worktree` to work in it with its own saved sessions, pending approvals and registered checks.
