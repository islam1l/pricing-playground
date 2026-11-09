# Automatic Pricing Playground (OSRM)

A plain HTML/CSS/JS page, with no build step and no backend, for tuning a delivery pricing formula on real road distances from OSRM and OpenStreetMap maps (Ismailia, Egypt). The UI is in Arabic.

## Live version

https://islam1l.github.io/pricing-playground/ (GitHub Pages, from the `islam1l/pricing-playground` repo)

- It uses the public OSRM demo server `router.project-osrm.org`. That server is for non-commercial use only and allows one request per second, which is enough for a demo. The "Docker محلي :5000" button only shows when the page is opened from `localhost`.
- A new browser starts with the defaults in `pricing.js` (`PARAMS`, `DEFAULT_TIERS`) and `app.js` (`DEFAULT_SETTINGS`, `DEFAULT_POINTS`). Changes you make on the page are saved in that browser only.
- To update the site: edit the files, then `git commit` and `git push`. Pages redeploys in about a minute.

## Running locally

The page must be served over http, not opened as `file://`, because OSM tiles need a Referer header.

```bash
cd ~/Desktop/pricing-playground
python3 -m http.server 8077
```

Then open http://localhost:8077. Port 8000 is taken by the Laravel app.

## Files

- `pricing.js`: the formula. `PARAMS` defines the parameters, and the parameters form is generated from it. `calculatePrice(summary, params)` is a pure function that returns the full breakdown. To add or remove a price component, edit this file only.
- `osrm.js`: the OSRM client. All requests go through one queue with 1.1 s between requests (skipped for a local server) and a 15 s timeout. The `lat,lng` → `lng,lat` swap happens here only.
- `app.js`: the map, the UI and the saved test cases (localStorage).

## Pricing formula

The total is the sum of these components:

- **Base fee** (`base_fee`).
- **Approach tier**: the first `approach_tier_km` km of the approach (gathering point → first stop) cost `approach_price_per_km` each, a cheaper rate.
- **Distance tiers** (`distance_tiers`): they apply to the trip km, plus any approach km beyond the approach tier, and always start from the first tier. Each tier only charges the km that fall inside it. The free `included_km` come off the start of the trip.
- **Extra stops**: `per_extra_stop` for each stop after the first. With no delivery point, the last stop is not counted.

The total is then raised to `min_fare` if it is lower, and rounded up to the nearest `rounding_step`.

The last tier limit is the maximum **total distance** (approach + trip). Above it there is no automatic price: the order is shown as "خارج الحد الأقصى — تسعير يدوي" (manual pricing).

Time is not priced. The route panel shows durations for information only.

Example with the defaults (tiers 5 / 10 / 15 / 50 km at 3.5 / 4 / 5 / 6, 1 km included, approach tier 5 km at 2.5): approach 7 km + trip 10 km.
- Base fee: 20
- Approach tier: 5 × 2.5
- The 2 approach km beyond the tier join the trip, so the distance tiers cover 12 km: 4 × 3.5 + 5 × 4 + 2 × 5

Total 76.5, rounded up to **77**.

## How the route is computed

1. **Route**: gathering point (optional) → stops → delivery point (always last).
   - The delivery point is optional. Without it, for example a doctor booking, or a pickup at one place dropped at another, the last entered stop is the fixed end of the route.
   - The other stops are ordered by the shortest route over all permutations (max 8 stops), unless "التسعير بالترتيب المدخل" (price in entered order) is on.
2. **Snapping to roads**: for each point, `nearest` returns up to 10 nearby roads.
   - Every road within the "مسافة السماح للالتقاط" (snap tolerance) radius is kept, 30 m by default, without duplicates.
   - If no road is within the radius, the plain nearest road is used, and the "pin far from road" warning still applies.
   - `nearest` results are cached per coordinate, so dragging one pin doesn't re-query the others.
3. **One table**: a single `table?annotations=distance,duration` request covers all candidates of all points. It passes the `hints` returned by `nearest`, so OSRM uses exactly the same road.
4. **Each leg on its own**: a leg's distance and duration are the shortest connection from any candidate of its start point to any candidate of its end point.
   - So a driver can reach a stop on one side of a divided road and leave from the other side (park, then turn at the nearest opening).
   - These legs are used both to order the stops and for the price.
5. **Why not one `route` call?** Pricing doesn't use a single `route` call through all points, because the car profile blocks U-turns at intermediate waypoints. On a divided road, moving a pin 4 m past a U-turn opening used to add over 2 km.
6. **Drawing the map**: each leg is drawn with its own `route` request between the chosen candidates.
   - The price appears first and the line follows.
   - Snap points are shown with an orange dashed line.
   - The route panel lists which road each point snapped to and how far from the pin, with arrival and departure shown separately when they differ.
7. **Approach and trip**: the first leg (gathering point → first stop) is the "approach" and the rest is the "trip".

## Caveats

- `table` distances are the distance of the **fastest** route, not the shortest, and that is what gets priced.
- Durations assume no traffic.
- The demo server `router.project-osrm.org` is for testing only. It's limited to non-commercial use and one request per second, with no uptime guarantee. Production needs a self-hosted OSRM.
- Current API docs: https://project-osrm.org/docs/v26.6.1/http

## Local OSRM on Docker

Already set up on the development machine:
- The data lives in `~/osrm`.
- The container is `osrm-egypt` on port 5000.
- It starts with Docker, including after a reboot (`--restart unless-stopped`).

```bash
docker start osrm-egypt   # start
docker stop osrm-egypt    # stop (frees the RAM)
docker logs osrm-egypt    # troubleshooting
```

### First-time setup (Manjaro)

```bash
sudo pacman -S --needed docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

mkdir -p ~/osrm && cd ~/osrm
curl -LO https://download.geofabrik.de/africa/egypt-latest.osm.pbf
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/egypt-latest.osm.pbf
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/egypt-latest.osrm
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/egypt-latest.osrm
docker run -d --name osrm-egypt --restart unless-stopped -p 5000:5000 -v "$HOME/osrm:/data" \
  ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/egypt-latest.osrm
```

To update the map: download the file again, re-run `extract`, `partition` and `customize`, then `docker restart osrm-egypt`.

### Measured on the Egypt extract (November 2026)

| Step | Time | Peak RAM |
|---|---|---|
| `osrm-extract` | about 2 min (including the first image pull) | 7.4 GB |
| `osrm-partition` | 25 s | 2.3 GB |
| `osrm-customize` | 7 s | 2.9 GB |
| `osrm-routed` running | — | 1.8–2.0 GB |

- The map file is 171 MB. The folder is 2.8 GB after preparation.
- For production, preparation (`extract` above all) needs about 7.5 GB of RAM. It can run on another machine and the prepared files can be uploaded. The server itself only runs `osrm-routed`, which needs about 2 GB.

### Notes

- With a local server the page doesn't wait 1.1 s between requests, so a full calculation takes a fraction of a second.
- Results can differ slightly from the demo server, because each one runs a map snapshot downloaded on a different day.
- If you edit a file and don't see the change, do a hard reload (`Ctrl+Shift+R`). The browser may keep the old version cached.
- Test cases saved against the demo server can be recomputed on the local server with "إعادة حساب المسارات" (recompute routes).
