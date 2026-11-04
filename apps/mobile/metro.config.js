// Expo's default Metro config detects the pnpm workspace (watch folders and
// node_modules lookup), so nothing else is needed here.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
