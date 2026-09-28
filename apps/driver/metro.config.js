// Metro configuration for a monorepo.
//
// The driver app is deliberately NOT an npm workspace: Expo's dependency
// versions are pinned per SDK, and hoisting them alongside Next.js has a habit
// of resolving two copies of React. It installs on its own, and these two
// settings let Metro still resolve the shared @shuttle/* packages that npm
// symlinks into the repo-root node_modules.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole repo so edits to packages/* trigger a reload.
config.watchFolders = [workspaceRoot];

// Resolve from the app first, then the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
