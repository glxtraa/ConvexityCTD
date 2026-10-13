"""Shared CTD and quality delivery-option calculations for Vercel and Colab."""

from __future__ import annotations

import calendar
from datetime import date, datetime
from typing import Any

import numpy as np


def _as_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _shift_month(d: date, months: int) -> date:
    index = d.year * 12 + d.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def _coupon_dates(maturity: date, settlement: date) -> list[date]:
    dates = [maturity]
    while dates[-1] > settlement:
        dates.append(_shift_month(dates[-1], -6))
    return list(reversed(dates))


def bond_price(coupon_pct: float, maturity: Any, settlement: Any, yield_pct: float,
               face: float = 100.0) -> tuple[float, float, float]:
    """Return clean price, dirty price, and accrued interest per 100 par."""
    maturity, settlement = _as_date(maturity), _as_date(settlement)
    if maturity <= settlement:
        raise ValueError("Bond maturity must be after settlement")
    dates = _coupon_dates(maturity, settlement)
    previous, following = dates[0], dates[1]
    period_days = (following - previous).days
    accrued = face * coupon_pct / 100.0 / 2.0 * (settlement - previous).days / period_days
    first_fraction = (following - settlement).days / period_days
    y = float(yield_pct) / 100.0
    if 1.0 + y / 2.0 <= 0:
        raise ValueError("Yield is outside the supported range")
    coupon = face * coupon_pct / 100.0 / 2.0
    dirty = sum(
        (coupon + (face if pay_date == maturity else 0.0))
        / (1.0 + y / 2.0) ** (2.0 * (first_fraction + j))
        for j, pay_date in enumerate(dates[1:])
    )
    return dirty - accrued, dirty, accrued


def _dirty_price_vector(coupon_pct: float, maturity: Any, settlement: Any,
                        yields_pct: np.ndarray, face: float = 100.0) -> np.ndarray:
    maturity, settlement = _as_date(maturity), _as_date(settlement)
    dates = _coupon_dates(maturity, settlement)
    previous, following = dates[0], dates[1]
    period_days = (following - previous).days
    accrued = face * coupon_pct / 100.0 / 2.0 * (settlement - previous).days / period_days
    first_fraction = (following - settlement).days / period_days
    periods = first_fraction + np.arange(len(dates[1:]), dtype=float)
    cashflows = np.full(len(periods), face * coupon_pct / 100.0 / 2.0)
    cashflows[-1] += face
    y = np.asarray(yields_pct, dtype=float) / 100.0
    dirty = np.sum(cashflows[None, :] / (1.0 + y[:, None] / 2.0) ** (2.0 * periods[None, :]), axis=1)
    return dirty


def calculate(payload: dict[str, Any]) -> dict[str, Any]:
    """Calculate current CTD and a two-factor quality-option Monte Carlo estimate."""
    basket = payload.get("basket") or []
    if not basket:
        raise ValueError("Basket must contain at least one eligible bond")
    valuation_date = _as_date(payload["valuation_date"])
    delivery_date = _as_date(payload["delivery_date"])
    horizon = (delivery_date - valuation_date).days / 365.0
    if horizon <= 0:
        raise ValueError("Delivery date must be after valuation date")
    futures_price = float(payload.get("futures_price", 102.25))
    discount_rate_pct = float(payload.get("discount_rate_pct", 4.0))
    level_vol_bp = float(payload.get("level_vol_bp", 45.0))
    slope_vol_bp = float(payload.get("slope_vol_bp", 20.0))
    correlation = float(payload.get("correlation", -0.20))
    n_scenarios = int(payload.get("n_scenarios", 30000))
    seed = int(payload.get("seed", 42))
    if not -1 <= correlation <= 1:
        raise ValueError("Correlation must be between -1 and 1")
    if n_scenarios < 100 or n_scenarios > 200000:
        raise ValueError("Scenario count must be between 100 and 200,000")

    prepared = []
    for bond in basket:
        record = {
            "cusip": str(bond["cusip"]),
            "coupon_pct": float(bond["coupon_pct"]),
            "maturity": str(bond["maturity"])[:10],
            "conversion_factor": float(bond["conversion_factor"]),
            "yield_pct": float(bond["yield_pct"]),
            "yield_source": str(bond.get("yield_source", "Provided")),
        }
        if record["conversion_factor"] <= 0:
            raise ValueError(f"Invalid conversion factor for {record['cusip']}")
        clean, dirty, accrued = bond_price(record["coupon_pct"], record["maturity"], valuation_date, record["yield_pct"])
        record.update({
            "clean_price": clean,
            "dirty_price": dirty,
            "accrued": accrued,
            "adjusted_delivery_cost": dirty / record["conversion_factor"],
            "implied_futures_price": clean / record["conversion_factor"],
            "net_basis_points": (clean - futures_price * record["conversion_factor"]) * 100.0,
        })
        prepared.append(record)

    prepared.sort(key=lambda r: r["adjusted_delivery_cost"])
    current_ctd = prepared[0]
    delivery_years = np.array([(_as_date(r["maturity"]) - delivery_date).days / 365.25 for r in prepared])
    base_yields = np.array([r["yield_pct"] for r in prepared], dtype=float)
    cfs = np.array([r["conversion_factor"] for r in prepared], dtype=float)
    coupons = np.array([r["coupon_pct"] for r in prepared], dtype=float)
    ref_index = next(i for i, r in enumerate(prepared) if r["cusip"] == current_ctd["cusip"])

    rng = np.random.default_rng(seed)
    z = rng.multivariate_normal([[0.0, 0.0]][0], [[1.0, correlation], [correlation, 1.0]], size=n_scenarios)
    level = z[:, 0] * level_vol_bp / 10000.0
    slope = z[:, 1] * slope_vol_bp / 10000.0
    adjusted = np.empty((n_scenarios, len(prepared)), dtype=float)
    for i, bond in enumerate(prepared):
        scenario_yields = (base_yields[i] / 100.0 + level + slope * (delivery_years[i] - 20.0) / 10.0) * 100.0
        adjusted[:, i] = _dirty_price_vector(coupons[i], bond["maturity"], delivery_date, scenario_yields) / cfs[i]
    delivery_ctd = adjusted.argmin(axis=1)
    reference_cost = adjusted[:, ref_index]
    cheapest_cost = adjusted[np.arange(n_scenarios), delivery_ctd]
    payoff = np.maximum(reference_cost - cheapest_cost, 0.0)
    discount = float(np.exp(-discount_rate_pct / 100.0 * horizon))
    pv = payoff * discount
    counts = np.bincount(delivery_ctd, minlength=len(prepared))
    probabilities = counts / n_scenarios
    bin_counts, bin_edges = np.histogram(payoff, bins=50)

    return {
        "model_version": "ctd-quality-option-v1",
        "basket_size": len(prepared),
        "valuation_date": valuation_date.isoformat(),
        "delivery_date": delivery_date.isoformat(),
        "current_ctd": current_ctd["cusip"],
        "current_ctd_adjusted_dirty_cost": current_ctd["adjusted_delivery_cost"],
        "current_rows": prepared,
        "summary": {
            "horizon_years": horizon,
            "reference_cusip": current_ctd["cusip"],
            "option_pv_per_100_par": float(pv.mean()),
            "option_pv_per_1000_par": float(pv.mean() * 10.0),
            "undiscounted_expected_payoff": float(payoff.mean()),
            "mc_standard_error": float(pv.std(ddof=1) / np.sqrt(n_scenarios)),
            "probability_current_ctd_is_not_cheapest": float(np.mean(delivery_ctd != ref_index)),
            "probability_option_payoff_is_positive": float(np.mean(payoff > 0.0)),
            "discount_factor": discount,
            "scenario_count": n_scenarios,
        },
        "ctd_probabilities": [
            {"cusip": prepared[i]["cusip"], "probability": float(probabilities[i])}
            for i in range(len(prepared))
        ],
        "payoff_histogram": {"counts": bin_counts.tolist(), "edges": bin_edges.tolist()},
    }
