import pandas as pd
import json
import re

LEAD_TIME_DAYS = 3
RECURRENCE_DAYS = 7  # max 1 order per ingredient per week

# -----------------------------
# Recipes
# -----------------------------
def load_recipes_from_json(json_path: str) -> dict:
    """Load recipe mapping JSON: {food: [(ingredient, '90g'), ...]} -> {food: {ingredient: (qty, unit)}}"""
    with open(json_path, "r") as f:
        recipe_data = json.load(f)

    recipes = {}
    for food_item, ingredients in recipe_data.items():
        recipes[food_item] = {}
        for ingredient, qty_str in ingredients:
            m = re.match(r"([\d.]+)\s*(\w+)", str(qty_str).strip())
            if m:
                qty = float(m.group(1))
                unit = m.group(2)
                recipes[food_item][ingredient] = (qty, unit)
    return recipes

RECIPES = load_recipes_from_json("mcdonalds_recipe_mapping.json")

# -----------------------------
# Load CSV files
# -----------------------------
bank_week1 = pd.read_csv("week1bank.csv", parse_dates=["txn_date"])
bank_week2 = pd.read_csv("week2bank.csv", parse_dates=["txn_date"])
bank_week3 = pd.read_csv("week3bank.csv", parse_dates=["txn_date"])

all_banks = pd.concat([bank_week1, bank_week2, bank_week3], ignore_index=True)
bank = bank_week3.copy()  # use last week only for "latest buy" assumptions

pos_data = pd.read_csv("mcdonalds_full_year_2020_2021.csv", parse_dates=["datetime"])
pos_data["date"] = pd.to_datetime(pos_data["datetime"].dt.date)

forecast_df = pd.read_csv("ingredient_demand_forecast.csv", parse_dates=["date"])

# -----------------------------
# POS -> ingredient usage
# -----------------------------
def pos_to_ingredients(pos_df: pd.DataFrame) -> pd.DataFrame:
    usage_records = []
    for _, row in pos_df.iterrows():
        food_item = row["actual_food"]
        qty_sold = float(row["quantity"])
        date = row["date"]

        if food_item not in RECIPES:
            continue

        for ingredient, (amount, unit) in RECIPES[food_item].items():
            usage_records.append(
                {"date": date, "ingredient": ingredient, "usage": amount * qty_sold, "unit": unit}
            )

    if not usage_records:
        return pd.DataFrame(columns=["date", "ingredient", "usage", "unit"])

    df = pd.DataFrame(usage_records)
    return df.groupby(["date", "ingredient", "unit"], as_index=False)["usage"].sum()

# Actual usage from POS (previous week)
actual_start = pd.Timestamp("2020-03-10")
actual_end = pd.Timestamp("2020-03-16")
pos_actual = pos_data[(pos_data["date"] >= actual_start) & (pos_data["date"] <= actual_end)]
actual = pos_to_ingredients(pos_actual)

# Forecast usage (next week) - map first 7 forecast dates to 2020-03-17..23
forecast_start = pd.Timestamp("2020-03-17")
forecast_end = pd.Timestamp("2020-03-23")

forecast_sample = forecast_df.copy()
unique_dates = sorted(forecast_sample["date"].unique())[:7]
date_mapping = dict(zip(unique_dates, pd.date_range(forecast_start, forecast_end, freq="D")))

forecast_sample = forecast_sample[forecast_sample["date"].isin(unique_dates)].copy()
forecast_sample["date"] = forecast_sample["date"].map(date_mapping)

forecast = forecast_sample.rename(columns={"pred_qty": "usage"})[["date", "ingredient", "usage"]].copy()

# Units from bank
ingredient_units = bank.groupby("ingredient")["unit"].first().to_dict()

def infer_unit(ingredient: str) -> str:
    if ingredient in ingredient_units:
        return ingredient_units[ingredient]
    if any(x in ingredient for x in ["Patty", "Filling"]) or ingredient in ["Lettuce", "Pickles", "Onion", "Potatoes", "Chicken Nugget", "Fish Fillet"]:
        return "g"
    if ingredient in ["Milk", "Ketchup", "Mustard", "Mayonnaise"]:
        return "ml"
    return "unit"

forecast["unit"] = forecast["ingredient"].apply(lambda ing: ingredient_units.get(ing) or infer_unit(ing))

# Types
bank = bank.copy()
bank["qty"] = bank["qty"].astype(float)
forecast["usage"] = forecast["usage"].astype(float)
actual["usage"] = actual["usage"].astype(float)

# -----------------------------
# Latest buy info (costs + starting inventory = last order qty)
# -----------------------------
bank_sorted = bank.sort_values(["ingredient", "txn_date"])
latest_buy = (
    bank_sorted.groupby("ingredient", as_index=False).tail(1)[
        ["ingredient", "unit", "unit_cost_gbp", "merchant", "txn_date", "qty"]
    ]
    .rename(columns={"txn_date": "last_order_date", "qty": "last_order_qty"})
    .set_index("ingredient")
)

# -----------------------------
# Build daily usage grid for 7-day horizon
# -----------------------------
start_date = forecast["date"].min()
end_date = start_date + pd.to_timedelta(RECURRENCE_DAYS - 1, unit="D")
dates = pd.date_range(start_date, end_date, freq="D")

ingredients = sorted(set(forecast["ingredient"]) | set(actual["ingredient"]) | set(bank["ingredient"]))

typical_daily = actual.groupby("ingredient")["usage"].median().to_dict()

idx = pd.MultiIndex.from_product([dates, ingredients], names=["date", "ingredient"])
daily = pd.DataFrame(index=idx).reset_index()

daily = daily.merge(
    forecast.rename(columns={"usage": "forecast_usage"})[["date", "ingredient", "forecast_usage"]],
    on=["date", "ingredient"], how="left"
)
daily = daily.merge(
    actual.rename(columns={"usage": "actual_usage"})[["date", "ingredient", "actual_usage"]],
    on=["date", "ingredient"], how="left"
)

def fallback_usage(row):
    if pd.notna(row["forecast_usage"]):
        return float(row["forecast_usage"])
    if pd.notna(row["actual_usage"]):
        return float(row["actual_usage"])
    return float(typical_daily.get(row["ingredient"], 0.0))

daily["daily_usage"] = daily.apply(fallback_usage, axis=1)

# -----------------------------
# Include deliveries from bank orders (delivery = txn_date + lead time)
# -----------------------------
bank["delivery_date"] = bank["txn_date"] + pd.to_timedelta(LEAD_TIME_DAYS, unit="D")
deliveries = bank.groupby(["delivery_date", "ingredient"], as_index=False)["qty"].sum()
deliveries = deliveries.rename(columns={"delivery_date": "date", "qty": "delivery_qty"})

daily = daily.merge(deliveries, on=["date", "ingredient"], how="left")
daily["delivery_qty"] = daily["delivery_qty"].fillna(0.0)

# -----------------------------
# Simulate + build reorder plan (max 1 order per ingredient)
# -----------------------------
daily = daily.sort_values(["ingredient", "date"]).reset_index(drop=True)
daily["planned_delivery_qty"] = 0.0

reorder_rows = []

for ing in ingredients:
    df = daily[daily["ingredient"] == ing].copy().reset_index(drop=True)
    start_inv = float(latest_buy.loc[ing, "last_order_qty"]) if ing in latest_buy.index else 0.0

    # find first stockout date if we do NOTHING extra
    inv = start_inv
    stockout_date = None
    for i in range(len(df)):
        d = df.loc[i, "date"]
        inv = inv + float(df.loc[i, "delivery_qty"]) - float(df.loc[i, "daily_usage"])
        if inv < 0 and stockout_date is None:
            stockout_date = d

    if stockout_date is None:
        continue  # no order needed -> don’t print it

    # latest safe order date is stockout_date - lead time
    order_date = stockout_date - pd.to_timedelta(LEAD_TIME_DAYS, unit="D")
    delivery_date = order_date + pd.to_timedelta(LEAD_TIME_DAYS, unit="D")

    # size order: cover usage from delivery_date..end, given inventory remaining by delivery_date morning
    inv_at_delivery_morning = start_inv
    for i in range(len(df)):
        d = df.loc[i, "date"]
        if d < delivery_date:
            inv_at_delivery_morning = inv_at_delivery_morning + float(df.loc[i, "delivery_qty"]) - float(df.loc[i, "daily_usage"])
        else:
            break

    remaining_need = float(df[df["date"] >= delivery_date]["daily_usage"].sum())
    order_qty = max(0.0, remaining_need - max(0.0, inv_at_delivery_morning))

    # record planned delivery landing
    daily.loc[(daily["ingredient"] == ing) & (daily["date"] == delivery_date), "planned_delivery_qty"] += order_qty

    unit = str(latest_buy.loc[ing, "unit"]) if ing in latest_buy.index else ""
    unit_cost = float(latest_buy.loc[ing, "unit_cost_gbp"]) if ing in latest_buy.index else 0.0
    supplier = str(latest_buy.loc[ing, "merchant"]) if ing in latest_buy.index else "Unknown"

    reorder_rows.append({
        "ingredient": ing,
        "order_date": order_date.date(),
        "delivery_date": delivery_date.date(),
        "order_qty": round(order_qty, 2),
        "unit": unit,
        "unit_cost_gbp": unit_cost,
        "estimated_cost_gbp": round(order_qty * unit_cost, 2),
        "supplier": supplier,
        "stockout_date_if_no_order": stockout_date.date(),
    })

if reorder_rows:
    reorder_plan = (pd.DataFrame(reorder_rows)
                    .sort_values(["order_date", "estimated_cost_gbp"], ascending=[True, False])
                    .reset_index(drop=True))
else:
    reorder_plan = pd.DataFrame(columns=[
        "ingredient", "order_date", "delivery_date", "order_qty", "unit",
        "unit_cost_gbp", "estimated_cost_gbp", "supplier", "stockout_date_if_no_order"
    ])

# -----------------------------
# Baseline: "recurring weekly order" = repeat last order qty (delivered after lead time)
# -----------------------------
rec_rows = []
for ing in ingredients:
    if ing not in latest_buy.index:
        continue
    last_qty = float(latest_buy.loc[ing, "last_order_qty"])
    unit_cost = float(latest_buy.loc[ing, "unit_cost_gbp"])
    unit = str(latest_buy.loc[ing, "unit"])

    order_date = start_date
    delivery_date = order_date + pd.to_timedelta(LEAD_TIME_DAYS, unit="D")
    if start_date <= delivery_date <= end_date:
        rec_rows.append({"ingredient": ing, "qty": last_qty, "unit": unit, "cost_gbp": last_qty * unit_cost})

recurring_plan = pd.DataFrame(rec_rows)

dynamic_cost = float(reorder_plan["estimated_cost_gbp"].sum()) if not reorder_plan.empty else 0.0
recurring_cost = float(recurring_plan["cost_gbp"].sum()) if not recurring_plan.empty else 0.0
savings = recurring_cost - dynamic_cost

# -----------------------------
# OUTPUT: ONLY USEFUL STUFF
# -----------------------------
pd.set_option("display.width", 180)
pd.set_option("display.max_columns", 30)

print("\n" + "="*80)
print("REORDER / RESTOCK LIST (only items that will stock out without an order)")
print("="*80)

if reorder_plan.empty:
    print("No restocks required in this 7-day window under the model.")
else:
    print(reorder_plan[[
        "ingredient", "supplier",
        "order_date", "delivery_date",
        "order_qty", "unit",
        "unit_cost_gbp", "estimated_cost_gbp",
        "stockout_date_if_no_order"
    ]].to_string(index=False))

print("\n" + "="*80)
print("COSTS (Dynamic vs Weekly Recurring Baseline)")
print("="*80)
print(f"Dynamic plan spend:         £{dynamic_cost:,.2f}")
print(f"Recurring baseline spend:   £{recurring_cost:,.2f} (repeat last order qty once this week)")
if savings >= 0:
    print(f"Estimated savings:          £{savings:,.2f}")
else:
    print(f"Estimated extra spend:      £{abs(savings):,.2f} (dynamic > baseline)")
print("="*80 + "\n")
