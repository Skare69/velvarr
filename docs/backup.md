# Backup and recovery

```sh
bun run backup /backups/velvarr.sqlite   # consistent online snapshot; refuses to overwrite
```

To restore, copy the snapshot as `velvarr.sqlite` into a new, empty data directory. Start Velvarr with the same `VELVARR_SECRET_KEY` as at backup time. The backup does not contain the key.

Velvarr creates the database, its WAL files, and each backup owner-only (mode `600`), because they hold the encrypted credentials and sessions. At startup, Velvarr also sets mode `600` on an existing database that other accounts can read. On Windows, these modes do not apply. Keep the backup folder private too.

The command creates the backup exclusively. It refuses an existing file or symbolic link, even if another process creates that path during the command.
A missing source database causes failure without a backup file. An absent `.env.local` is allowed, but other errors from that file stop the command.
