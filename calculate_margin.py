"""
calculate_margin.py
--------------------
Called by server.js as a subprocess. Reads a CSV file path from argv[1],
uses Pandas to compute Net Profit Margin, and prints ONE line of JSON
to stdout. Node reads that line and returns it to the browser.

Usage:
    python3 calculate_margin.py /path/to/uploaded.csv
"""

import sys
import json
import pandas as pd

REVENUE_ALIASES = ["revenue", "total revenue", "total income", "net sales", "sales"]
NET_PROFIT_ALIASES = ["net profit", "net income", "net earnings"]
EXPENSE_ALIASES = ["total expenses", "expenses", "total costs", "cost of goods sold"]


def find_column(columns, aliases):
    normalized = {c.strip().lower(): c for c in columns}
    for alias in aliases:
        if alias in normalized:
            return normalized[alias]
    return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided."}))
        sys.exit(1)

    csv_path = sys.argv[1]

    try:
        df = pd.read_csv(csv_path)
    except Exception:
        print(json.dumps({"error": "Could not parse this file as a CSV."}))
        sys.exit(1)

    if df.empty:
        print(json.dumps({"error": "The uploaded CSV has no rows."}))
        sys.exit(1)

    revenue_col = find_column(df.columns, REVENUE_ALIASES)
    profit_col = find_column(df.columns, NET_PROFIT_ALIASES)
    expense_col = find_column(df.columns, EXPENSE_ALIASES)

    if revenue_col is None:
        print(json.dumps({
            "error": f"No revenue column found. Columns found: {list(df.columns)}"
        }))
        sys.exit(1)

    revenue_total = pd.to_numeric(df[revenue_col], errors="coerce").sum()

    if profit_col is not None:
        net_profit_total = pd.to_numeric(df[profit_col], errors="coerce").sum()
        profit_source = profit_col
    elif expense_col is not None:
        expense_total = pd.to_numeric(df[expense_col], errors="coerce").sum()
        net_profit_total = revenue_total - expense_total
        profit_source = f"derived from {revenue_col} - {expense_col}"
    else:
        print(json.dumps({
            "error": f"No net profit or expense column found. Columns found: {list(df.columns)}"
        }))
        sys.exit(1)

    if revenue_total == 0:
        print(json.dumps({"error": "Total revenue is zero; cannot compute margin."}))
        sys.exit(1)

    net_profit_margin = (net_profit_total / revenue_total) * 100

    print(json.dumps({
        "revenue_column_used": revenue_col,
        "profit_source": profit_source,
        "total_revenue": round(float(revenue_total), 2),
        "net_profit": round(float(net_profit_total), 2),
        "net_profit_margin_percent": round(float(net_profit_margin), 2),
        "rows_processed": int(len(df)),
    }))


if __name__ == "__main__":
    main()
