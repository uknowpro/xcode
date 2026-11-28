# Backup, downgrade and recover sessions

Before upgrading, close xcode and copy your entire xcode data directory. It is `~/.xcode` unless you set `XCODE_HOME`. Keep the backup private. File-backed credentials and conversation contents can be present in it. OS keychain credentials remain in the system credential store.

To install an older release, use the older package with the same npm install command. If you want to restore the complete pre-upgrade state, point `XCODE_HOME` at the backup before launching the older CLI.

For a session edited after the upgrade, export a version that older xcode versions can read before downgrading.

```sh
xcode session backup latest --output session-backup.json
```

Close xcode. In a copy of the data directory, put that file under `sessions` as `<id>.json`, using the ID in the file. Start the previous release with `XCODE_HOME` pointing to that copy. Keep the session's original workspace path so that the CLI can locate it. Back up every session you need and retain the original upgrade data.

After an interrupted apply or undo, use `xcode review recovery` to see which files were applied or conflict. Close other xcode processes before following any stale-lock recovery instruction. Use `xcode draft latest` to read a saved draft without acquiring the session lock.
