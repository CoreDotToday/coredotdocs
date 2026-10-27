// Materialize Next's traced pnpm packages without junctions. Each package keeps
// the dependency versions it resolved in the original standalone directory.
const fs = require('node:fs');
const path = require('node:path');

function packageEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  const entries = [];
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith('.')) continue;
    const entry = path.join(directory, name);
    if (!fs.statSync(entry).isDirectory()) continue;
    if (name.startsWith('@')) {
      for (const child of fs.readdirSync(entry)) entries.push([`${name}/${child}`, path.join(entry, child)]);
    } else entries.push([name, entry]);
  }
  return entries;
}

function resolveTracedPackage(from, name, traceRoot) {
  for (let current = from; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(candidate)) {
      const resolved = fs.realpathSync(candidate);
      const relative = path.relative(traceRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Package escapes standalone directory: ${name}`);
      return resolved;
    }
    if (current === traceRoot || path.dirname(current) === current) return null;
  }
}

function copyPackage(source, destination, accessible, traceRoot) {
  const nested = path.join(source, 'node_modules');
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => entry !== nested,
  });
  const manifestPath = path.join(source, 'package.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  const local = new Map();
  for (const name of Object.keys(dependencies)) {
    const resolved = resolveTracedPackage(source, name, traceRoot);
    // Next traces only the files and optional packages needed by this platform.
    if (resolved && accessible.get(name) !== resolved) local.set(name, resolved);
  }
  const nextAccessible = new Map([...accessible, ...local]);
  for (const [name, resolved] of local) copyPackage(resolved, path.join(destination, 'node_modules', name), nextAccessible, traceRoot);
}

function copyStandalone(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  const modules = path.join(source, 'node_modules');
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => entry !== modules,
  });
  // Preserve top-level package precedence over pnpm's hoisted dependencies.
  const packages = new Map([
    ...packageEntries(path.join(modules, '.pnpm', 'node_modules')),
    ...packageEntries(modules),
  ].map(([name, entry]) => [name, fs.realpathSync(entry)]));
  for (const [name, real] of packages) copyPackage(real, path.join(destination, 'node_modules', name), packages, source);
  console.log(`Standalone packages materialized: ${packages.size} top-level packages`);
}

module.exports = { copyStandalone };
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('usage: node copy-standalone.cjs <source> <destination>');
  copyStandalone(process.argv[2], process.argv[3]);
}
