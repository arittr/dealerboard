# App icon assets

`../app-icon.svg` is the canonical Dealerboard app icon. It was authored as
deterministic SVG geometry for this repository and incorporates no external
artwork. The artwork is available under the repository's MIT license.

The SVG keeps the background, neutral cells, working cells, and attention cell
in named groups. Its canvas is intentionally opaque and square: Apple platforms
apply the final app-icon enclosure, so the source must not include a baked
rounded-square mask.

Regenerate the platform assets from `app/`:

```sh
bunx tauri icon src-tauri/app-icon.svg
```
