// Node handles long Windows paths that Windows PowerShell 5.1 cannot remove.
// Only the three generated resource directories are eligible for replacement.
const fs = require('node:fs');
const path = require('node:path');
const name = process.argv[2];
if (!['backend', 'skills', 'web'].includes(name)) throw new Error('Unknown build resource');
const root = path.resolve(__dirname, '..', 'resources');
const destination = path.resolve(root, name);
if (path.dirname(destination) !== root) throw new Error('Resource path is outside the build directory');
fs.rmSync(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
fs.mkdirSync(destination, { recursive: true });
console.log(destination);
