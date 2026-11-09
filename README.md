# steam-price-history

Historial abierto de precios de la tienda de Steam, registrado automáticamente cada 6 horas.

*English summary below.*

## Por qué existe

Steam solo dice cuánto cuesta un juego **ahora**: no ofrece historial de precios. Los sitios que muestran
"el precio más bajo" lo tienen porque llevan años anotando el precio actual y guardando cada cambio.
Este repositorio hace lo mismo, de forma abierta: cualquiera puede leer los datos o copiar el método.

El historial empieza el día en que se encendió el registro (ver `meta.json` → `since`).
No hay datos de antes de esa fecha.

## Cómo funciona

`record.mjs` (Node 18+, sin dependencias) consulta las APIs públicas de la tienda de Steam
(`IStoreQueryService/Query` y `IStoreBrowseService/GetItems`, las mismas que usa la tienda) y anota
cada cambio de precio. Un flujo de GitHub Actions lo ejecuta:

| Cuándo | Qué revisa |
| --- | --- |
| Cada 6 horas | Todo lo que tiene descuento en ese momento, y lo que dejó de tenerlo |
| Una vez al día | Toda la tienda (juegos, DLC y software con precio) |

Países registrados: **México (MXN)**. Se pueden agregar más con la variable `COUNTRIES`.

## Datos

Todos los precios están en **centavos** de la moneda del país y las fechas en **segundos unix (UTC)**.

### `lows/<PAÍS>.json` — el precio más bajo registrado

Solo incluye lo que alguna vez estuvo con descuento:

```json
{ "239140": [4160, 1794243303, 90, 41600] }
```

`[precio más bajo, fecha en que se vio por primera vez, % de descuento, precio sin descuento]`

### `data/<PAÍS>/<cubeta>.json` — historial completo

Cada juego está en la cubeta `appid % 256` (con tres dígitos: `000.json` … `255.json`), un juego por renglón:

```json
{ "239140": { "n": "Dying Light", "h": [[1794243303, 4160, 41600], [1794500000, 41600, 41600]] } }
```

`h` es la lista de cambios: `[fecha, precio final, precio sin descuento]`. Solo se agrega un renglón
cuando el precio cambia; el precio sigue igual hasta el siguiente renglón.

### `meta.json`

Cuándo empezó el registro de cada país, la última ejecución y cuántos juegos hay.

### Leer los datos

```
https://raw.githubusercontent.com/aaoollaaooll/steam-price-history/main/lows/MX.json
https://raw.githubusercontent.com/aaoollaaooll/steam-price-history/main/data/MX/124.json
```

Se agradece guardar en caché lo que se descarga (los datos cambian como mucho cada 6 horas).

## Ejecutar localmente

```bash
node record.mjs                 # ofertas
MODE=full node record.mjs       # toda la tienda
COUNTRIES=MX,AR node record.mjs # otros países
```

## Avisos

- Proyecto independiente, sin relación con Valve ni con SteamDB. Steam es marca de Valve Corporation.
- Los precios vienen de las APIs públicas de Steam tal cual; pueden faltar cambios si Steam no responde
  en una ejecución. Sin garantía de ningún tipo.
- Código bajo licencia MIT. Lo usa [WishlistDeals](https://wishlistdeals.vercel.app).

---

## English summary

Open Steam store price history, recorded every 6 hours by GitHub Actions using Steam's public store APIs.
Steam has no price-history API, so history only exists from the day recording started (`meta.json` → `since`).

- `lows/<CC>.json`: lowest recorded price per app that was ever discounted —
  `[lowest price, first seen at, discount %, regular price]`.
- `data/<CC>/<appid % 256>.json`: full change log per app — `h: [[unix time, final, regular], ...]`.
- Prices in cents of the country's currency, times in unix seconds (UTC). Currently: Mexico (MXN).

Not affiliated with Valve or SteamDB. Code under the MIT license; data provided as-is.
