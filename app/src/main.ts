const tiles = document.querySelector<HTMLElement>("#tiles");
if (tiles !== null) {
  for (let index = 0; index < 4; index += 1) {
    const tile = document.createElement("div");
    tile.className = "tile blank";
    tiles.append(tile);
  }
}
