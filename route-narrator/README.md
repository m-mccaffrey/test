# Roadside Narrator

A web app that tells you stories about the places along your driving route.
Enter where you're starting and where you're going, pick the topics you care
about (or none, for general history tidbits), and press **Start driving**.
As you approach something interesting, it speaks up: *"Coming up in about
a mile, just off to your left: the Old Stone Mill…"*, followed by a short
history read from Wikipedia.

## Features

- **Route planning**: type addresses or place names (or `lat, lon`), or tap 📍 to start from your current location.
- **Topics of interest**: History, Wars & Battles, Towns & Cities, Architecture, Nature & Parks, Geology, Roads/Rails/Bridges, Industry & Science, Notable People, Arts/Music/Film, Sports, Indigenous Heritage, Odd & Quirky.
  - *Favour my topics* puts your picks first and still mentions other notable places.
  - *Only my topics* is silent about everything else.
  - With nothing picked, you get general history and local trivia.
- **Spoken narration** with the browser's built-in voices: pick the voice and speed. You can also turn on **Text only**.
- **Timed to your drive**: GPS tracks where you are along the route. Each story starts early enough to finish around the time you reach the place, and says how far away it is and on which side.
- **Settings**: how often it talks (Relaxed, Normal, Chatty), how much detail (Brief, Normal, Detailed), how far from the road to look (1, 3 or 8 km), miles or kilometres, and Wikipedia language.
- **Simulate the drive** from 1× to 30× speed to preview a trip from your couch.
- Map with colour-coded markers, an *Up ahead* list and an *Already heard* log. Tap 🔊 on any place to hear about it right away.
- Keeps the screen awake while driving where the browser supports it, and remembers your settings.

## Running it

It's a static site with no build step and no API keys. ES modules need to be
served over HTTP, so open it through any static web server:

```bash
cd route-narrator
python3 -m http.server 8000
# open http://localhost:8000
```

GPS only works on `https://` or `localhost`, so to use it in a car, host the
folder on any static host (GitHub Pages, Netlify, etc.) and open it on your
phone.

## How it works

| Step | Service |
| --- | --- |
| Address → coordinates | [Nominatim](https://nominatim.org/) (OpenStreetMap) |
| Driving route | [OSRM](https://project-osrm.org/) public server |
| Places along the route | Wikipedia geosearch, sampled every few km along the road; each article is tagged with topics from its description and categories |
| Story text | Wikipedia intro extracts, fetched just before they're needed |
| Voice | Web Speech API (`speechSynthesis`) |
| Map | [Leaflet](https://leafletjs.com/) and OpenStreetMap tiles |

Code layout:

- `js/geo.js`: distances, route sampling and projecting a point onto the route (distance along it, offset, left or right side).
- `js/services.js`: geocoding, routing, Wikipedia lookups.
- `js/topics.js`: topic definitions, the article classifier and interest scoring.
- `js/narrator.js`: turns a place into a spoken script and manages the speech queue.
- `js/trip.js`: the trip engine. It tracks position (GPS or simulated) and decides what to narrate next, and when.
- `js/app.js`: UI and map wiring.

Tests for the geometry, classifier and script writer:

```bash
node --test tests/*.test.mjs
```

## Notes

- The free public Nominatim, OSRM and OpenStreetMap tile servers are fine for
  personal use. If you publish this widely, point `services.js` and the tile
  URL in `app.js` at your own or a commercial provider.
- Narration is generated from Wikipedia text (CC BY-SA). Quality depends on
  the articles near your route.
- Please set it up before you drive, and keep your eyes on the road.
