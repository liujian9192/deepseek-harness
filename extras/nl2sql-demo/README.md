# NL2SQL Demo

Standalone MySQL demo. Not wired into DeepSeek Harness yet.

- You write table meaning by hand (`schemas/*.json`).
- The demo reads live columns and a few real rows from MySQL.
- `ask` builds a prompt from manual comments + live schema + sample rows, then generates a SELECT and runs it.

## Setup

```powershell
cd E:\project\deepseek-harness
git checkout dev
git pull

cd extras\nl2sql-demo
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env` with a **read-only** MySQL account.

## Add a table

1. Create `schemas/your_table.json`:

```json
{
  "table": "t_psr_ds_feeder",
  "description": "配网馈线台账",
  "columns": {
    "psr_id": "设备ID",
    "name": "线路名称"
  }
}
```

Only listed files are allowed. Unknown tables cannot be queried.

2. Pull live columns and 5 sample rows:

```powershell
python app.py inspect t_psr_ds_feeder
python app.py refresh
python app.py list
```

`inspect` creates the json if missing. `refresh` updates `live_columns` and `sample_rows` for every file in `schemas/`.

## Ask

```powershell
python app.py ask "苏利线今年故障几次"
```

Without `LLM_API_KEY`, it prints the prompt only. With a key, it generates SQL, checks that it is a single SELECT against allowlisted tables, adds LIMIT, then runs it.

```powershell
python app.py sql "SELECT name FROM t_psr_ds_feeder LIMIT 5"
```

## Safety

- Only `SELECT`
- Table names must exist in `schemas/`
- Forced `LIMIT` (default 50)
- No comments, no multiple statements, no INTO OUTFILE
