#!/usr/bin/env python3
"""Minimal MySQL NL2SQL demo: manual schema files + live sample rows."""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import pymysql
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
SCHEMA_DIR = ROOT / "schemas"
DEFAULT_LIMIT = 50
SAMPLE_LIMIT = 5

FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|"
    r"load\s+data|outfile|dumpfile|into\s+outfile|information_schema|"
    r"performance_schema|mysql\.|sys\.)\b",
    re.IGNORECASE,
)


def load_env() -> None:
    load_dotenv(ROOT / ".env")


def db_conn():
    return pymysql.connect(
        host=os.getenv("MYSQL_HOST", "127.0.0.1"),
        port=int(os.getenv("MYSQL_PORT", "3306")),
        user=os.getenv("MYSQL_USER", "root"),
        password=os.getenv("MYSQL_PASSWORD", ""),
        database=os.getenv("MYSQL_DATABASE"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
    )


def schema_path(table: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_]", "_", table)
    return SCHEMA_DIR / f"{safe}.json"


def list_schema_files() -> list[Path]:
    SCHEMA_DIR.mkdir(exist_ok=True)
    return sorted(p for p in SCHEMA_DIR.glob("*.json") if not p.name.startswith("_"))


def load_schema(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "table" not in data:
        raise ValueError(f"{path.name} missing table")
    data.setdefault("description", "")
    data.setdefault("columns", {})
    data.setdefault("live_columns", [])
    data.setdefault("sample_rows", [])
    return data


def save_schema(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def allowlisted_tables() -> dict[str, dict]:
    out = {}
    for path in list_schema_files():
        item = load_schema(path)
        out[item["table"].lower()] = item
    return out


def fetch_live(table: str) -> tuple[list[dict], list[dict]]:
    ident = table.replace("`", "")
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_COMMENT AS comment
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
                ORDER BY ORDINAL_POSITION
                """,
                (ident,),
            )
            cols = cur.fetchall()
            if not cols:
                raise SystemExit(f"MySQL 里没有表 {ident}（检查库名和表名）")
            cur.execute(f"SELECT * FROM `{ident}` LIMIT %s", (SAMPLE_LIMIT,))
            rows = cur.fetchall()
    for row in rows:
        for key, value in list(row.items()):
            if hasattr(value, "isoformat"):
                row[key] = value.isoformat()
            elif isinstance(value, bytes):
                row[key] = value.decode("utf-8", errors="replace")
    return cols, rows


def cmd_inspect(table: str) -> None:
    path = schema_path(table)
    if path.exists():
        data = load_schema(path)
    else:
        data = {"table": table, "description": "", "columns": {}}
    cols, rows = fetch_live(table)
    data["live_columns"] = cols
    data["sample_rows"] = rows
    data["refreshed_at"] = datetime.now(timezone.utc).isoformat()
    save_schema(path, data)
    print(f"wrote {path}")
    print(f"live columns: {len(cols)}, sample rows: {len(rows)}")
    missing = [c["name"] for c in cols if c["name"] not in data.get("columns", {})]
    if missing:
        print("建议在 columns 里补中文说明:", ", ".join(missing[:20]))


def cmd_refresh() -> None:
    files = list_schema_files()
    if not files:
        raise SystemExit("schemas/ 是空的，先 python app.py inspect <table>")
    for path in files:
        data = load_schema(path)
        cols, rows = fetch_live(data["table"])
        data["live_columns"] = cols
        data["sample_rows"] = rows
        data["refreshed_at"] = datetime.now(timezone.utc).isoformat()
        save_schema(path, data)
        print(f"refreshed {data['table']}: {len(cols)} cols, {len(rows)} rows")


def cmd_list() -> None:
    files = list_schema_files()
    if not files:
        print("no schema files")
        return
    for path in files:
        data = load_schema(path)
        n_cols = len(data.get("live_columns") or [])
        n_rows = len(data.get("sample_rows") or [])
        print(
            f"- {data['table']}  manual_cols={len(data.get('columns') or {})}  "
            f"live_cols={n_cols}  samples={n_rows}  file={path.name}"
        )
        if data.get("description"):
            print(f"  {data['description']}")


def build_prompt(question: str) -> str:
    blocks = []
    for data in allowlisted_tables().values():
        lines = [f"TABLE `{data['table']}`", data.get("description") or ""]
        comments = data.get("columns") or {}
        live = data.get("live_columns") or []
        if live:
            lines.append("COLUMNS:")
            for col in live:
                hint = comments.get(col["name"]) or col.get("comment") or ""
                lines.append(f"- {col['name']} {col['type']}  {hint}".rstrip())
        elif comments:
            lines.append("COLUMNS:")
            for name, hint in comments.items():
                lines.append(f"- {name}  {hint}")
        samples = data.get("sample_rows") or []
        if samples:
            lines.append("SAMPLE_ROWS_JSON:")
            lines.append(json.dumps(samples, ensure_ascii=False, default=str))
        blocks.append("\n".join(lines).strip())
    catalog = "\n\n".join(blocks) or "(no tables)"
    names = ", ".join(sorted(allowlisted_tables()))
    return f"""You are a MySQL NL2SQL helper.
Return ONLY one SELECT statement. No markdown, no comments, no explanation.
Rules:
- Use only these tables: {names}
- Read-only SELECT
- Prefer explicit column names
- Add LIMIT {DEFAULT_LIMIT} if the question does not need a full scan aggregate-only answer
- Match filters using sample row values when the user uses a display name

SCHEMA AND SAMPLES:
{catalog}

QUESTION:
{question}
"""


def extract_sql(text: str) -> str:
    text = text.strip()
    fence = re.search(r"```(?:sql)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    text = text.strip().rstrip(";") + ";"
    return text


def validate_sql(sql: str, allowed: set[str]) -> str:
    compact = " ".join(sql.strip().split())
    if ";" in compact[:-1]:
        raise ValueError("only one statement allowed")
    if FORBIDDEN.search(compact):
        raise ValueError(f"forbidden keyword in SQL: {compact}")
    if not re.match(r"^select\b", compact, re.IGNORECASE):
        raise ValueError("only SELECT is allowed")
    found = {m.group(1).lower() for m in re.finditer(r"\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?", compact, re.IGNORECASE)}
    extra = found - allowed
    if extra:
        raise ValueError(f"table not allowlisted: {', '.join(sorted(extra))}")
    if found and not found <= allowed:
        raise ValueError("table not allowlisted")
    if not re.search(r"\blimit\s+\d+", compact, re.IGNORECASE):
        compact = compact.rstrip(";") + f" LIMIT {DEFAULT_LIMIT};"
    return compact


def run_sql(sql: str) -> list[dict]:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
    for row in rows:
        for key, value in list(row.items()):
            if hasattr(value, "isoformat"):
                row[key] = value.isoformat()
    return rows


def cmd_sql(sql: str) -> None:
    allowed = set(allowlisted_tables())
    safe = validate_sql(sql, allowed)
    print("SQL:", safe)
    rows = run_sql(safe)
    print(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
    print(f"rows: {len(rows)}")


def cmd_ask(question: str, dry_run: bool) -> None:
    prompt = build_prompt(question)
    print("===== PROMPT =====")
    print(prompt)
    api_key = os.getenv("LLM_API_KEY", "").strip()
    if dry_run or not api_key:
        print("===== NOTE =====")
        print("no LLM_API_KEY or --dry-run; not calling a model.")
        return
    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url=os.getenv("LLM_BASE_URL") or None)
    resp = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "deepseek-chat"),
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
    )
    raw = resp.choices[0].message.content or ""
    sql = extract_sql(raw)
    print("===== MODEL SQL =====")
    print(sql)
    cmd_sql(sql)


def main() -> None:
    load_env()
    parser = argparse.ArgumentParser(description="MySQL NL2SQL demo")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ins = sub.add_parser("inspect", help="read live schema + sample rows into schemas/<table>.json")
    p_ins.add_argument("table")

    sub.add_parser("refresh", help="refresh live columns and samples for all schema files")
    sub.add_parser("list", help="list registered tables")

    p_ask = sub.add_parser("ask", help="build prompt and optionally generate + run SQL")
    p_ask.add_argument("question")
    p_ask.add_argument("--dry-run", action="store_true")

    p_sql = sub.add_parser("sql", help="run a validated SELECT")
    p_sql.add_argument("query")

    args = parser.parse_args()
    if args.cmd == "inspect":
        cmd_inspect(args.table)
    elif args.cmd == "refresh":
        cmd_refresh()
    elif args.cmd == "list":
        cmd_list()
    elif args.cmd == "ask":
        cmd_ask(args.question, args.dry_run)
    elif args.cmd == "sql":
        cmd_sql(args.query)


if __name__ == "__main__":
    main()
