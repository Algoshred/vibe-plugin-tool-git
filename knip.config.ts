import { knipConfig } from "@burdenoff/toolchain/knip/base";

export default knipConfig({
  entry: ["src/index.ts"],
  project: ["src/**/*.ts"],
  // The plugin contract exports the factory both as `createPlugin` and as the
  // default export (the agent loads either), so duplicate exports are intended.
  // @opentui/core is an optional runtime dependency of the agent host, loaded
  // through a guarded dynamic import and kept external in the bundle.
  ignoreDependencies: ["@opentui/core"],
  rules: { duplicates: "off" },
});
