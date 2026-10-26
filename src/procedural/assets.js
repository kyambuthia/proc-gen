// Importing this module installs the built-in generators into the registry.
import "./tree.js";
import "./rock.js";
import "./cat.js";
import "./car.js";

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
