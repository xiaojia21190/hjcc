# -*- coding: utf-8 -*-
"""
从中金所官网抓取股指期货(IF/IH/IC/IM)中信系会员的每日多空持仓。

用法:
    python cffex_citic.py [--start 20240101] [--end YYYYMMDD] [--out PATH]

输出:
    JSON 数组, 每项 {date, product, longHold, shortHold}, 按 date 升序。
    date 形如 YYYY-MM-DD, product 为 IF/IH/IC/IM, longHold/shortHold 为该日该品种
    全部合约中信系会员的合计持仓手数。

只依赖 akshare(底层是抓取 cffex.com.cn 每日结算 CSV)。
日期非交易日时 akshare 返回空, 静默跳过; 末尾连续失败(节假日/网络)会自动收敛。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

import akshare as ak

VARIETIES = ["IF", "IH", "IC", "IM"]
# 只统计名字里带 "中信" 的会员(中信期货/中信建投, 均为代客持仓)。
BROKER_KEYWORD = "中信"
# 末尾连续多少个非交易日就停止, 避免网络故障时空转。
MAX_MISSING_TAIL = 10


def _today() -> _dt.date:
    return _dt.date.today()


def _daterange(start: _dt.date, end: _dt.date):
    cur = start
    while cur <= end:
        yield cur
        cur += _dt.timedelta(days=1)


def _citic_holds(df) -> tuple[int, int]:
    """累加 df 中中信系会员的多单/空单。返回 (long, short)。"""
    long_name = df.get("long_party_name")
    long_hold = df.get("long_open_interest")
    short_name = df.get("short_party_name")
    short_hold = df.get("short_open_interest")

    l_total = 0
    s_total = 0
    if long_name is not None and long_hold is not None:
        mask = long_name.astype(str).str.contains(BROKER_KEYWORD, na=False)
        if mask.any():
            l_total = int(long_hold[mask].astype("int64").sum())
    if short_name is not None and short_hold is not None:
        mask = short_name.astype(str).str.contains(BROKER_KEYWORD, na=False)
        if mask.any():
            s_total = int(short_hold[mask].astype("int64").sum())
    return l_total, s_total


def fetch_day(date: _dt.date) -> dict[str, tuple[int, int]]:
    """返回 {product: (long, short)}; 非交易日返回空 dict。"""
    try:
        res = ak.get_cffex_rank_table(date=date, vars_list=list(VARIETIES))
    except Exception:
        return {}
    if not res:
        return {}
    out: dict[str, tuple[int, int]] = {}
    for contract, df in res.items():
        if df is None or len(df) == 0:
            continue
        try:
            product = str(df["variety"].iloc[0])
        except Exception:
            product = str(contract)[:2]
        if product not in VARIETIES:
            continue
        l, s = _citic_holds(df)
        if l == 0 and s == 0:
            continue
        prev_l, prev_s = out.get(product, (0, 0))
        out[product] = (prev_l + l, prev_s + s)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="20240101")
    parser.add_argument("--end", default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    start = _dt.datetime.strptime(args.start, "%Y%m%d").date()
    end = (
        _dt.datetime.strptime(args.end, "%Y%m%d").date()
        if args.end
        else _today()
    )

    rows: list[dict] = []
    missing = 0
    for day in _daterange(start, end):
        holds = fetch_day(day)
        if not holds:
            missing += 1
            if missing > MAX_MISSING_TAIL:
                break
            continue
        missing = 0
        iso = day.isoformat()
        for product in VARIETIES:
            if product not in holds:
                continue
            long_hold, short_hold = holds[product]
            rows.append(
                {
                    "date": iso,
                    "product": product,
                    "longHold": long_hold,
                    "shortHold": short_hold,
                }
            )

    rows.sort(key=lambda r: (r["date"], r["product"]))
    payload = json.dumps(rows, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
