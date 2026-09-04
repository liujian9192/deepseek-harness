# dsh-nl2sql

DeepSeek Harness tool plugin. After it is loaded, the Web dialog can call:

- `db_register_table` — save your table comments, then pull live columns + sample rows from MySQL
- `db_list_tables` — list registered tables
- `db_schema` — schema + sample rows for the model
- `db_query` — read-only SELECT against allowlisted tables

## Install dependency once

```powershell
cd E:\project\deepseek-harness\extras\dsh-nl2sql
npm install
```

## Configure

Edit `extras/dsh-nl2sql/cordis.yml`:

- `database` / `user` / `password` — use a read-only MySQL account if you can
- `name` — if load fails, set an absolute path to `src/index.ts`

## Start Harness with the plugin

From the repo root, stop the current Web process, then:

```powershell
cd E:\project\deepseek-harness
pnpm dsh web --patch ./extras/dsh-nl2sql/cordis.yml
```

In a new session ask:

1. `先用 db_register_table 登记表 t_psr_ds_feeder，说明是配网馈线台账`
2. `无锡有多少条线路？`

The model should call `db_schema` / `db_query` instead of guessing.

Do not start `pnpm dsh web` without `--patch`, or the tools will not exist.
