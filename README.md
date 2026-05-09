# Gmaps Scrapper

Chrome extension (Manifest V3) that expands and collects **Google Maps** place reviews from the open side panel, with export to **JSON** and **CSV**.

**Author / maintainer:** [@marviano](https://github.com/marviano)

## Requirements

- Google Chrome or another Chromium browser with extension support
- A Google Maps place page with the **Reviews** section available

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the **`extension`** folder inside this repo (the one that contains `manifest.json`).

## Usage (short)

1. Open a place on Google Maps so reviews are visible.
2. Click the extension icon and follow the popup tutorial.
3. Start collecting; when finished, copy JSON or download CSV.

## Repo layout

| Path | Purpose |
|------|--------|
| `extension/` | The loadable Chrome extension |
| `MAPS_REVIEWS_SCRAPER_AUDIT.md` | Technical notes about scraping behavior |

## License

Licensed under the [MIT License](LICENSE).

## Disclaimer

This tool interacts with pages on **google.com** / **maps.google.com**. You are responsible for complying with Google’s Terms of Service and applicable laws. The software is provided for educational and personal use **as-is** without warranty.

## Publishing to GitHub (steps only you can do)

These require **your** GitHub login and credentials.

1. Log in at [GitHub](https://github.com) as **[@marviano](https://github.com/marviano)**.
2. Click **New repository** → name it (for example **`gmaps-scrapper`**) → **Public** → create it **without** adding README, `.gitignore`, or a license (this project already includes them).
3. In a terminal **in this project folder**, connect the remote and push (replace **`REPO_NAME`** if yours differs):

   ```powershell
   cd path\to\your\gmaps-scrapper
   git remote add origin https://github.com/marviano/REPO_NAME.git
   git push -u origin main
   ```

   If `git remote add` errors because `origin` already exists, use `git remote set-url origin https://github.com/marviano/REPO_NAME.git` then `git push -u origin main`.

4. If Git asks for a password when using HTTPS, use a [**Personal Access Token**](https://github.com/settings/tokens) with **repo** access (not your GitHub password). Or set up [**SSH**](https://docs.github.com/en/authentication/connecting-to-github-with-ssh) and use `git@github.com:marviano/REPO_NAME.git` as `origin`.

**New machine / no git history yet:** run `git init`, `git branch -M main`, `git add .`, `git commit -m "Initial publish"` first, then steps 2–4.

After pushing, the project is **public**; ownership is reflected by **your account**, **commits**, **LICENSE**, and this **README**.
