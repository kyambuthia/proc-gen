// Importing this module installs the built-in generators into the registry.
import "./tree.js";
import "./rock.js";
import "./cat.js";
import "./car.js";
import "./bicycle.js";
import "./human.js";
import "./water.js";
import "./rat.js";

export {
  createAsset,
  deserializeAsset,
  listAssetTypes,
  rebuildAsset,
  registerAssetGenerator,
  serializeAsset,
} from "./asset-registry.js";
export { createGrove, createTree } from "./tree.js";
export { createRock, createRockField } from "./rock.js";
export { createCat } from "./cat.js";
export { createCar } from "./car.js";
export { createBicycle } from "./bicycle.js";
export { createHuman } from "./human.js";
export { createWater } from "./water.js";
export { createRat } from "./rat.js";
