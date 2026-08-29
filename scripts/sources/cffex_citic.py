# -*- coding: utf-8 -*-
"""
从中金所官网抓取股指期货(IF/IH/IC/IM)中信系会员的每日多空持仓，
并计算全市场多空前五集中度（用于空头拥挤度对照）。

用法:
    python cffex_citic.py [--start 20240101] [--end YYYYMMDD] [--out PATH]

输出:
    JSON 数组, 每项 {date, product, longHold, shortHold, longTop5Pct, shortTop5Pct},
    按 date 升序。date 形如 YYYY-MM-DD, product 为 IF/IH/IC/IM,
    longHold/shortHold 为该日该品种全部合约中信系会员的合计持仓手数,
    longTop5Pct/shortTop5Pct 为多头/空头前五会员合计占全市场该侧总持仓 %（保留 2 位小数）。

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


def _product_of(df, contract: str) -> str:
    try:
        return str(df["variety"].iloc[0])
    except Exception:
        return str(contract)[:2]


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


def _aggregate_day(res) -> dict[str, dict]:
    """
    把 akshare 返回的 {contract: df} 聚合为
    {product: {citic_long, citic_short, long_total, short_total, long_by_member, short_by_member}}。
    跨合约按会员名累加，前五集中度用累加后的会员排名计算。
    """
    out: dict[str, dict] = {}
    for contract, df in res.items():
        if df is None or len(df) == 0:
            continue
        product = _product_of(df, contract)
        if product not in VARIETIES:
            continue
        bucket = out.setdefault(
            product,
            {
                "citic_long": 0,
                "citic_short": 0,
                "long_total": 0.0,
                "short_total": 0.0,
                "long_by_member": {},
                "short_by_member": {},
            },
        )
        cl, cs = _citic_holds(df)
        bucket["citic_long"] += cl
        bucket["citic_short"] += cs
        try:
            bucket["long_total"] += float(
                df["long_open_interest"].astype("float64").sum()
            )
        except Exception:
            pass
        try:
            bucket["short_total"] += float(
                df["short_open_interest"].astype("float64").sum()
            )
        except Exception:
            pass
        try:
            ln = df["long_party_name"].astype(str)
            lh = df["long_open_interest"].astype("float64")
            for name, hold in zip(ln, lh):
                bucket["long_by_member"][name] = (
                    bucket["long_by_member"].get(name, 0.0) + float(hold)
                )
        except Exception:
            pass
        try:
            sn = df["short_party_name"].astype(str)
            sh = df["short_open_interest"].astype("float64")
            for name, hold in zip(sn, sh):
                bucket["short_by_member"][name] = (
                    bucket["short_by_member"].get(name, 0.0) + float(hold)
                )
        except Exception:
            pass
    return out


def _top5_pct(by_member: dict[str, float], total: float) -> float | None:
    """前五会员合计占该侧全市场总持仓 %；总持仓非正或无会员时返回 None。"""
    if total <= 0 or not by_member:
        return None
    top5 = sum(sorted(by_member.values(), reverse=True)[:5])
    return round(top5 / total * 100, 2)


def fetch_day(date: _dt.date) -> dict[str, dict]:
    """
    返回 {product: {longHold, shortHold, longTop5Pct, shortTop5Pct}};
    非交易日返回空 dict。
    """
    try:
        res = ak.get_cffex_rank_table(date=date, vars_list=list(VARIETIES))
    except Exception:
        return {}
    if not res:
        return {}
    aggregated = _aggregate_day(res)
    out: dict[str, dict] = {}
    for product, bucket in aggregated.items():
        if bucket["citic_long"] == 0 and bucket["citic_short"] == 0:
            continue
        out[product] = {
            "longHold": bucket["citic_long"],
            "shortHold": bucket["citic_short"],
            "longTop5Pct": _top5_pct(bucket["long_by_member"], bucket["long_total"]),
            "shortTop5Pct": _top5_pct(bucket["short_by_member"], bucket["short_total"]),
        }
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
            entry = holds[product]
            rows.append(
                {
                    "date": iso,
                    "product": product,
                    "longHold": entry["longHold"],
                    "shortHold": entry["shortHold"],
                    "longTop5Pct": entry["longTop5Pct"],
                    "shortTop5Pct": entry["shortTop5Pct"],
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
