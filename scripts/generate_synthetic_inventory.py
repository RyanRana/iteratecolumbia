#!/usr/bin/env python3
"""
Generate realistic synthetic daily inventory for a tech shop (10 products, past year).
Uses product-level reorder points, seasonal events (Black Friday, back-to-school), and
weekday/weekend patterns. Saves JSON and CSV. Run from repo root or any directory.
"""
import csv
import json
import os
import random
from datetime import date, timedelta

SEED = 42
random.seed(SEED)

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA = os.path.join(_REPO_ROOT, "data")
PRODUCTS_PATH = os.path.join(_DATA, "tech_products.json")
OUTPUT_JSON = os.path.join(_DATA, "synthetic_inventory_daily.json")
OUTPUT_CSV = os.path.join(_DATA, "synthetic_inventory_daily.csv")


def seasonal_multiplier(dt: date) -> float:
    """Realistic tech-shop seasonality: Q4 holidays, back-to-school, summer dip."""
    month, day = dt.month, dt.day
    # Black Friday (Nov, 4th Fri) and Cyber Monday (next Mon) spike
    if month == 11 and 24 <= day <= 30:
        return 1.85
    if month == 12 and day <= 23:
        return 1.55
    # Back-to-school (mid-Aug through September)
    if (month == 8 and day >= 15) or month == 9:
        return 1.25
    # Summer dip (July–early Aug)
    if 7 <= month <= 8 and day < 15:
        return 0.82
    # January post-holiday lull
    if month == 1:
        return 0.78
    return 1.0


def weekday_multiplier(weekday: int) -> float:
    """Higher weekend traffic for retail tech."""
    return [0.95, 1.0, 1.02, 1.0, 1.15, 1.38, 1.28][weekday]  # Mon–Sun


def main():
    with open(PRODUCTS_PATH) as f:
        products = json.load(f)

    end_date = date.today()
    start_date = end_date - timedelta(days=364)
    days = (end_date - start_date).days + 1

    records = []
    for product in products:
        asin = product["asin"]
        base_lo, base_hi = product["base_stock_range"]
        qoh = random.randint(base_lo, base_hi)
        sales_mean = product["daily_sales_mean"]
        reorder_point = product["reorder_point"]
        reorder_qty = product["reorder_qty"]
        list_price = product.get("list_price")
        cost = product.get("cost")

        for d in range(days):
            dt = start_date + timedelta(days=d)
            weekday = dt.weekday()
            season = seasonal_multiplier(dt)
            wday = weekday_multiplier(weekday)
            mu = sales_mean * season * wday
            daily_sales = max(0, int(random.gauss(mu, max(1, mu * 0.4))))

            restock = 0
            if qoh < reorder_point:
                restock = reorder_qty
                qoh += restock

            qoh -= daily_sales
            qoh = max(0, qoh)

            row = {
                "date": dt.isoformat(),
                "asin": asin,
                "product_name": product["name"],
                "category": product["category"],
                "quantity_on_hand": qoh,
                "quantity_sold": daily_sales,
                "quantity_received": restock,
            }
            if list_price is not None:
                row["list_price"] = round(list_price, 2)
                row["inventory_value_at_cost"] = round(qoh * cost, 2) if cost else None
            records.append(row)

    with open(OUTPUT_JSON, "w") as f:
        json.dump(records, f, indent=2)

    fieldnames = list(records[0].keys())
    with open(OUTPUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(records)

    print(f"Wrote {len(records)} daily inventory records.")
    print(f"  JSON: {OUTPUT_JSON}")
    print(f"  CSV:  {OUTPUT_CSV}")
    print(f"  Date range: {start_date} to {end_date} ({len(products)} products).")


if __name__ == "__main__":
    main()
