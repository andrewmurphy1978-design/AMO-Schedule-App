// Comparing what a supplier charges for an ingredient: the same ingredient comes in different packages (a case of 12 bags, a 2 kg bag...),
// with a different weight, a different yield (a whole lettuce is trimmed) and sometimes arrives ready to use (already cut) or needs preparing at the restaurant.

const num = (v) => { const n = typeof v === "string" ? Number(v.replace(",", ".")) : v; return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null; };

/**
 * The cost of one offer. `o` = { price, pack_qty, pack_weight, yield_pct, prep_min }: the price of one package, how many units it holds,
 * its weight (kg), the share of it that is usable (100 when it arrives ready to use) and the minutes of preparation it needs at the restaurant.
 * `laborRate` is the cost of an hour of preparation ($/h, or null / 0 to leave preparation out of the price).
 */
export function offerCost(o, laborRate = null) {
  const price = num(o?.price);
  if (!price) return null;
  const weight = num(o.pack_weight), qty = num(o.pack_qty);
  const yieldF = Math.min(100, num(o.yield_pct) ?? 100) / 100;
  const prepMin = num(o.prep_min) ?? 0, rate = num(laborRate) ?? 0;
  const prepCost = prepMin && rate ? (prepMin / 60) * rate : 0;
  const total = price + prepCost;
  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    price, prepCost: r2(prepCost), total: r2(total), prepMin,
    perUnit: qty ? r2(price / qty) : null, totalPerUnit: qty ? r2(total / qty) : null,
    perKg: weight ? r2(price / weight) : null,
    usableKg: weight ? Math.round(weight * yieldF * 1000) / 1000 : null,
    totalPerUsableKg: weight ? r2(total / (weight * yieldF)) : null,
  };
}

/**
 * Compares the offers of several suppliers ([{ id, name, ...offer }]) on the best common basis: per usable kg when every offer has a weight,
 * else per unit when every offer has a size, else the package price. Returns { basis, rows: [{ id, name, cost, value, best }] }.
 */
export function compareOffers(list, laborRate = null) {
  const rows = list.map((o) => ({ id: o.id, name: o.name, cost: offerCost(o, laborRate), prep: o.prep ?? null }));
  const priced = rows.filter((r) => r.cost);
  const basis = priced.length && priced.every((r) => r.cost.totalPerUsableKg !== null) ? "kg" : priced.length && priced.every((r) => r.cost.totalPerUnit !== null) ? "unit" : "pack";
  const key = { kg: "totalPerUsableKg", unit: "totalPerUnit", pack: "total" }[basis];
  const values = priced.map((r) => r.cost[key]);
  const min = values.length ? Math.min(...values) : null;
  for (const r of rows) { r.value = r.cost ? r.cost[key] : null; r.best = priced.length > 1 && r.value !== null && r.value === min; }
  return { basis, rows };
}
