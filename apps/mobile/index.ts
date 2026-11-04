// Entry point. Polyfills must load before matrix-js-sdk is evaluated.
import "./src/polyfills";
import { registerRootComponent } from "expo";
import { App } from "./src/App";

registerRootComponent(App);
