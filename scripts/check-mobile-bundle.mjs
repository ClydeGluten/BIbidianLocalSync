import fs from "node:fs";
import vm from "node:vm";

const bundle = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");

class Plugin {}
class PluginSettingTab {}
class TFile {}
class TFolder {}

const obsidian = {
  Plugin,
  PluginSettingTab,
  TFile,
  TFolder,
  Platform: { isDesktopApp: false },
  Notice: class {},
  Setting: class {},
  SecretComponent: class {},
  normalizePath: (path) => path.replaceAll("\\", "/").replace(/\/{2,}/g, "/")
};

const context = {
  ArrayBuffer,
  BigInt,
  DataView,
  Date,
  Error,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  Set,
  String,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  URL,
  atob,
  btoa,
  clearTimeout,
  console,
  crypto,
  module: { exports: {} },
  navigator: {},
  require: (id) => {
    if (id === "obsidian") return obsidian;
    throw new Error(`Desktop dependency loaded on mobile: ${id}`);
  },
  setTimeout,
  structuredClone,
  window: {
    clearTimeout,
    confirm: () => false,
    setInterval,
    setTimeout
  }
};

vm.runInNewContext(bundle, context, { filename: "main.js" });
if (typeof context.module.exports !== "function") throw new Error("Plugin bundle did not export its main class");
console.log("Mobile bundle smoke check passed");
