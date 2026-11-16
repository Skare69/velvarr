# Backup and recovery

```sh
bun run backup /backups/velvarr.sqlite   # consistent online snapshot; refuses to overwrite
```

To restore, copy the snapshot as `velvarr.sqlite` into a new, empty data directory. Start Velvarr with the same `VELVARR_SECRET_KEY` as at backup time. The backup does not contain the key.

Velvarr creates the database, its WAL files, and each backup owner-only (mode `600`), because they hold the encrypted credentials and sessions. At startup, Velvarr also sets mode `600` on an existing database that other accounts can read. On Windows, these modes do not apply. Keep the backup folder private too.
