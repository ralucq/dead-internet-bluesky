# Web app (static page)

Files
- index.html, app.js      the page
- signals.js              the signals for one account (copy of the study code; used by the page and by verify_signals.mjs)
- model.json              made by export_web_model.mjs (not included in the zip)
- serve.mjs               tiny local server: node app/serve.mjs -> http://localhost:8080
- verify_signals.mjs      proves the app gives the same numbers and the same score as the study

Steps (from the folder that contains the data folder)
1. node export_web_model.mjs     (writes app/model.json and data/web_model_report.txt)
2. node app/verify_signals.mjs   (must say ALL SIGNALS MATCH and SCORES MATCH)
3. node app/serve.mjs            (open http://localhost:8080 and try a handle)

The page runs fully in the browser and calls only https://public.api.bsky.app. Nothing is stored.
