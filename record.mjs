// Registro de precios de la tienda de Steam.
//
// Steam solo dice cuánto cuesta algo AHORA. Para tener historial hay que anotar el precio actual
// cada cierto tiempo y guardar cada cambio: este script hace eso y lo guarda en este mismo repositorio.
//
//   node record.mjs            -> modo "ofertas": todo lo que tiene descuento hoy (+ lo que dejó de tenerlo)
//   MODE=full node record.mjs  -> modo "completo": toda la tienda (una vez al día)
//   COUNTRIES=MX,AR node record.mjs
//
// Solo usa APIs públicas de Steam (las mismas que usa su tienda). Sin dependencias: Node 18 o más nuevo.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const LOWS = path.join(ROOT, "lows");
const BUCKETS = 256;
const PAGE = 1000;
const PAUSE_MS = 400; // entre consultas, para no saturar a Steam

// Moneda de la tienda de Steam en cada país.
const CURRENCIES = {
  MX: "MXN", AR: "USD", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU", CR: "CRC", BR: "BRL", US: "USD", ES: "EUR",
};

const MODE = process.env.MODE === "full" ? "full" : "sales";
const COUNTRIES = (process.env.COUNTRIES || "MX").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const NOW = Math.floor(Date.now() / 1000);
const TYPES = { include_games: true, include_dlc: true, include_software: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function steam(url, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "steam-price-history (github.com/aaoollaaooll/steam-price-history)" } });
      if (res.ok) return await res.json();
      if (attempt >= tries || (res.status < 500 && res.status !== 429)) throw new Error(`Steam respondió ${res.status}`);
    } catch (e) {
      if (attempt >= tries) throw e;
    }
    await sleep(2000 * attempt * attempt);
  }
}

function query(country, start, onlyDiscounted) {
  const input = {
    query: {
      start,
      count: PAGE,
      sort: 2, // orden estable entre páginas (con el de popularidad se repiten y se saltan juegos)
      filters: { type_filters: TYPES, ...(onlyDiscounted ? { price_filters: { min_discount_percent: 1 } } : {}) },
    },
    context: { language: "english", country_code: country },
    data_request: {},
  };
  return steam(`https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
}

function getItems(country, appids) {
  const input = { ids: appids.map((appid) => ({ appid })), context: { language: "english", country_code: country }, data_request: {} };
  return steam(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
}

// Precio en centavos (enteros) a partir de lo que entrega Steam; null si no se puede comprar.
function priceOf(item) {
  const option = item?.best_purchase_option;
  if (!option?.final_price_in_cents) return null;
  const final = Number(option.final_price_in_cents);
  const initial = Number(option.original_price_in_cents || option.final_price_in_cents);
  return Number.isFinite(final) && Number.isFinite(initial) ? { final, initial } : null;
}

// ---------- Almacenamiento: data/<PAÍS>/<cubeta>.json, un juego por renglón ----------
// { "appid": { "n": nombre, "h": [[fecha unix, precio final, precio sin descuento], ...] } }
// Solo se agrega un renglón a "h" cuando el precio cambia.

const bucketOf = (appid) => String(appid % BUCKETS).padStart(3, "0");

class Store {
  constructor(country) {
    this.country = country;
    this.dir = path.join(DATA, country);
    this.buckets = new Map();
    this.dirty = new Set();
    this.changes = 0;
  }

  async load(bucket) {
    if (!this.buckets.has(bucket)) {
      let data = {};
      try {
        data = JSON.parse(await readFile(path.join(this.dir, `${bucket}.json`), "utf8"));
      } catch {}
      this.buckets.set(bucket, data);
    }
    return this.buckets.get(bucket);
  }

  async loadAll() {
    for (let i = 0; i < BUCKETS; i++) await this.load(bucketOf(i));
  }

  async observe(appid, name, price) {
    if (!Number.isInteger(appid) || appid <= 0 || !price) return;
    const bucket = bucketOf(appid);
    const data = await this.load(bucket);
    const entry = (data[appid] ??= { n: name || String(appid), h: [] });
    if (name && entry.n !== name) {
      entry.n = name;
      this.dirty.add(bucket);
    }
    const last = entry.h.at(-1);
    if (!last || last[1] !== price.final || last[2] !== price.initial) {
      entry.h.push([NOW, price.final, price.initial]);
      this.dirty.add(bucket);
      this.changes++;
    }
  }

  // Juegos cuyo último precio anotado tenía descuento.
  discountedIds() {
    const ids = [];
    for (const data of this.buckets.values())
      for (const [appid, entry] of Object.entries(data)) {
        const last = entry.h.at(-1);
        if (last && last[1] < last[2]) ids.push(Number(appid));
      }
    return ids;
  }

  async save() {
    await mkdir(this.dir, { recursive: true });
    for (const bucket of this.dirty) {
      const data = this.buckets.get(bucket);
      const lines = Object.keys(data)
        .map(Number)
        .sort((a, b) => a - b)
        .map((appid) => `${JSON.stringify(String(appid))}:${JSON.stringify(data[appid])}`);
      await writeFile(path.join(this.dir, `${bucket}.json`), `{\n${lines.join(",\n")}\n}\n`);
    }
  }

  // lows/<PAÍS>.json: el precio más bajo registrado de cada juego que alguna vez tuvo descuento.
  // { "appid": [precio más bajo, fecha, % de descuento, precio sin descuento] }
  async saveLows() {
    const lows = [];
    for (const data of this.buckets.values())
      for (const [appid, entry] of Object.entries(data)) {
        let best = null;
        for (const [ts, final, initial] of entry.h) if (final < initial && (!best || final < best[1])) best = [ts, final, initial];
        if (best) lows.push([Number(appid), [best[1], best[0], Math.round((1 - best[1] / best[2]) * 100), best[2]]]);
      }
    lows.sort((a, b) => a[0] - b[0]);
    await mkdir(LOWS, { recursive: true });
    const body = lows.map(([appid, low]) => `${JSON.stringify(String(appid))}:${JSON.stringify(low)}`).join(",\n");
    await writeFile(path.join(LOWS, `${this.country}.json`), `{\n${body}\n}\n`);
    return lows.length;
  }
}

async function sweep(store, onlyDiscounted) {
  const seen = new Set();
  let total = Infinity;
  for (let start = 0; start < total; start += PAGE) {
    const res = (await query(store.country, start, onlyDiscounted)).response ?? {};
    total = res.metadata?.total_matching_records ?? 0;
    const items = res.store_items ?? [];
    for (const item of items) {
      const appid = item.appid || item.id;
      seen.add(appid);
      await store.observe(appid, item.name, priceOf(item));
    }
    if (items.length === 0) break;
    await sleep(PAUSE_MS);
  }
  return seen;
}

async function run(country) {
  const store = new Store(country);
  await store.loadAll();
  const started = Date.now();

  const seen = await sweep(store, MODE !== "full");

  // Lo que tenía descuento y ya no aparece: se consulta para anotar que la oferta terminó.
  const ended = store.discountedIds().filter((id) => !seen.has(id));
  for (let i = 0; i < ended.length; i += 100) {
    const res = (await getItems(country, ended.slice(i, i + 100))).response ?? {};
    for (const item of res.store_items ?? []) await store.observe(item.appid || item.id, item.name, priceOf(item));
    await sleep(PAUSE_MS);
  }

  await store.save();
  const lows = await store.saveLows();
  const apps = [...store.buckets.values()].reduce((sum, data) => sum + Object.keys(data).length, 0);
  console.log(
    `${country} (${MODE}): ${seen.size} vistos, ${ended.length} ofertas revisadas al terminar, ` +
      `${store.changes} cambios, ${apps} juegos registrados, ${lows} con mínimo, ${Math.round((Date.now() - started) / 1000)} s`,
  );
  return { apps, lows, changes: store.changes };
}

async function main() {
  const metaPath = path.join(ROOT, "meta.json");
  let meta = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {}
  meta.countries ??= {};
  for (const country of COUNTRIES) {
    if (!CURRENCIES[country]) throw new Error(`País sin moneda configurada: ${country}`);
    const result = await run(country);
    const previous = meta.countries[country] ?? {};
    meta.countries[country] = {
      currency: CURRENCIES[country],
      since: previous.since ?? NOW,
      lastRun: NOW,
      lastFull: MODE === "full" ? NOW : (previous.lastFull ?? null),
      apps: result.apps,
      withLow: result.lows,
    };
  }
  meta.note = "Precios en centavos de la moneda indicada. Fechas en segundos unix (UTC).";
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
