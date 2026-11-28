export function shellCompletion(shell, help, options) {
  const commands = [...new Set(help.split('\n').flatMap(line => /^  xcode ([a-z][a-z-]+)\b/.exec(line)?.[1] ?? []))];
  const flags = Object.keys(options).sort();
  const words = [...commands, ...flags.map(flag => '--' + flag)];
  if (shell === 'bash') return "complete -o default -W '" + words.join(' ') + "' xcode";
  if (shell === 'zsh') return "#compdef xcode\n_xcode() {\n  local -a items\n  items=(" + words.join(' ') +
    ")\n  _describe 'xcode command or option' items\n}\ncompdef _xcode xcode";
  if (shell === 'fish') return [
    ...commands.map(command => "complete -c xcode -n '__fish_use_subcommand' -a '" + command + "'"),
    ...flags.map(flag => 'complete -c xcode -l ' + flag + (options[flag].type === 'string' ? ' -r' : '')),
  ].join('\n');
  if (shell === 'powershell' || shell === 'pwsh') return [
    "Register-ArgumentCompleter -Native -CommandName 'xcode' -ScriptBlock {",
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    '  @(' + words.map(word => "'" + word + "'").join(', ') + ') | ForEach-Object {',
    "    if ($_.StartsWith($wordToComplete, [StringComparison]::OrdinalIgnoreCase)) {",
    "      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    '    }', '  }', '}',
  ].join('\n');
  throw new Error('Choose bash, zsh, fish or powershell.');
}
