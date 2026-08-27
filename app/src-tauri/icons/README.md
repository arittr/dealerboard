# App icon assets

`../Dealerboard.icon` is the canonical, editable macOS app icon. Its two SVG
layers were authored as deterministic geometry for this repository and
incorporate no external artwork. `../app-icon.svg` preserves the same flat
layout for tools that do not understand Icon Composer documents. The artwork
is available under the repository's MIT license.

The app bundle carries both formats expected across supported macOS releases:

- `Assets.car` contains the layered Icon Composer artwork used by macOS 26 and
  later. It was compiled with Xcode 26.6 and is checked in, so ordinary builds
  do not require a full Xcode installation.
- `icon.icns` and the PNG matrix are generated from
  `../app-icon-legacy.png`, Icon Composer's 1024-point Default export. They
  provide a complete, already-enclosed fallback for earlier macOS releases.

To refresh the fallback, export `Dealerboard.icon` from Icon Composer as
`app-icon-legacy.png` at 1024pt, 1x, Default appearance, then run from `app/`:

```sh
bunx tauri icon src-tauri/app-icon-legacy.png
```

To refresh the layered catalog, Xcode 26 or later is required:

```sh
icon_build_dir=$(mktemp -d /tmp/dealerboard-icon.XXXXXX)
cp -R src-tauri/Dealerboard.icon "$icon_build_dir/Icon.icon"
mkdir "$icon_build_dir/out"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun actool \
  "$icon_build_dir/Icon.icon" \
  --compile "$icon_build_dir/out" \
  --output-format human-readable-text \
  --notices --warnings \
  --output-partial-info-plist "$icon_build_dir/out/assetcatalog_generated_info.plist" \
  --app-icon Icon \
  --include-all-app-icons \
  --accent-color AccentColor \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 10.13 \
  --platform macosx
cp "$icon_build_dir/out/Assets.car" src-tauri/icons/Assets.car
```
