import { startGame } from "./raw-game.js";

let stop = () => {};
startGame().then((dispose) => { stop = dispose; });
window.addEventListener("pagehide", () => stop(), { once: true });
