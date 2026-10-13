const { getDefaultConfig } = require('expo/metro-config');
const { join, resolve } = require('node:path');

const config = getDefaultConfig(__dirname);
// Preserve Expo's own binary cache format, while keeping transforms in the
// deployed project rather than a build machine's temporary directory. The
// optional directory is used by isolated cold-cache verification only.
const cacheRoot = resolve(process.env.EXPO_METRO_CACHE_DIRECTORY || join(__dirname, '.expo', 'metro-cache'));
const ExpoCacheStore = config.cacheStores[0].constructor;
config.cacheStores = [new ExpoCacheStore({ root: cacheRoot })];
config.fileMapCacheDirectory = join(cacheRoot, 'file-map');
config.maxWorkers = 2;
module.exports = config;
