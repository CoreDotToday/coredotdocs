// Offline, fail-closed license packaging for the exact installed build inputs.
// Native/WASM inventories are refreshed separately from pinned/checksummed sources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NOTICE = /^(licen[cs]es?|copying|copyright|notices?|unlicense)([._-].*)?$/i;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const slash = (value) => value.split(path.sep).join('/');
const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '_');

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '__pycache__'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, visit);
    else if (entry.isFile()) visit(file);
  }
}

function resolvePackage(name, from) {
  let dir = from;
  while (true) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function npmPackages(frontend, packagedWeb) {
  const root = json(path.join(frontend, 'package.json'));
  // These devDependencies become runtime bytes in the rhwp-studio bundle.
  const queue = [...Object.keys(root.dependencies), 'canvaskit-wasm', '@noble/hashes']
    .map((name) => ({ name, from: frontend, optional: false }));
  const visited = new Set();
  const records = [];
  const missing = [];
  const supplements = json(path.join(frontend, '../desktop/licenses/npm-supplements.json'));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = resolvePackage(name, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`Missing npm build input: ${name}`);
    }
    if (visited.has(dir)) continue;
    visited.add(dir);
    const pkg = json(path.join(dir, 'package.json'));
    // Next's platform compiler is a build dependency and is not in the traced
    // desktop server. If tracing ever includes it, require a native inventory.
    if (pkg.name.startsWith('@next/swc-') || pkg.name === 'sharp' || pkg.name.startsWith('@img/sharp')) {
      if (packagedWeb && fs.existsSync(path.join(packagedWeb, 'node_modules', ...pkg.name.split('/')))) throw new Error(`Unused native image/compiler package unexpectedly shipped: ${pkg.name}`);
      continue;
    }
    const notices = [];
    walk(dir, (file) => {
      const relative = slash(path.relative(dir, file));
      if (NOTICE.test(path.basename(file)) || /(?:^|\/)licenses\//i.test(relative)) {
        const data = fs.readFileSync(file);
        if (data.length && !data.includes(0)) notices.push({ file: relative, text: data.toString('utf8') });
      }
    });
    // @rhwp/editor's published files omit LICENSE, but are the same MIT project
    // and pinned release as @rhwp/core. Preserve the project's exact grant.
    if (!notices.length && pkg.name === '@rhwp/editor' && pkg.license === 'MIT') {
      const coreDir = resolvePackage('@rhwp/core', frontend);
      const core = coreDir && json(path.join(coreDir, 'package.json'));
      if (core?.version === pkg.version && core.license === 'MIT') notices.push({ file: 'LICENSE-rhwp-project', text: fs.readFileSync(path.join(coreDir, 'LICENSE'), 'utf8') });
    }
    if (!notices.length && pkg.name === '@next/env' && pkg.license === 'MIT') {
      const nextDir = resolvePackage('next', frontend);
      const next = nextDir && json(path.join(nextDir, 'package.json'));
      if (next?.version === pkg.version) notices.push({ file: 'LICENSE-next-project', text: fs.readFileSync(path.join(nextDir, 'license.md'), 'utf8') });
    }
    if (!notices.length) {
      for (const file of fs.readdirSync(dir).filter((f) => /^readme(?:\.|$)/i.test(f))) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        if (text.includes('Permission is hereby granted') && text.includes('THE SOFTWARE IS PROVIDED')) notices.push({ file, text });
      }
    }
    if (!notices.length) {
      const supplement = supplements.packages.find((p) => p.name === pkg.name && p.version === pkg.version);
      if (supplement) {
        if (sha(Buffer.from(supplement.text)) !== supplement.sha256) throw new Error(`Corrupt npm supplement: ${pkg.name}`);
        notices.push({ file: 'LICENSE-with-provenance.txt', text: `Source: ${supplement.source}\n\n${supplement.text}` });
      }
    }
    if (!notices.length) missing.push(`${pkg.name}@${pkg.version}`);
    records.push({ name: pkg.name, version: pkg.version, license: pkg.license || 'SEE LICENSE FILES',
      source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, notices });
    for (const dependency of Object.keys(pkg.dependencies || {})) {
      queue.push({ name: dependency, from: dir, optional: Boolean(pkg.optionalDependencies?.[dependency]) });
    }
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) queue.push({ name: dependency, from: dir, optional: true });
    // Installed peers may contribute runtime code. Missing peers are not bundled.
    for (const dependency of Object.keys(pkg.peerDependencies || {})) queue.push({ name: dependency, from: dir, optional: true });
  }
  if (missing.length) throw new Error(`No license text in npm packages: ${missing.join(', ')}`);
  return records.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function verifyInventory(inventory, wasm) {
  if (inventory.schemaVersion !== 1 || !inventory.packages?.length) throw new Error('Invalid native notice inventory');
  if (wasm && inventory.wasmSha256 !== sha(fs.readFileSync(wasm))) throw new Error(`WASM notice inventory is stale: ${inventory.component}`);
  for (const [digest, text] of Object.entries(inventory.texts || {})) {
    if (!text.trim() || sha(Buffer.from(text)) !== digest) throw new Error(`Corrupt license text: ${digest}`);
  }
  for (const pkg of inventory.packages) {
    if (!pkg.name || !pkg.version || !pkg.source || !pkg.license) throw new Error('Incomplete native component provenance');
    if (!Object.keys(pkg.noticeTexts || {}).length) throw new Error(`Missing native notices: ${pkg.name}@${pkg.version}`);
    for (const digest of Object.values(pkg.noticeTexts)) {
      if (!inventory.texts[digest]) throw new Error(`Unresolved native notice: ${pkg.name}@${pkg.version}`);
    }
  }
}

function verifyPublicWasm(publicDir, coreDigest, canvasDigest) {
  const observed = new Set();
  walk(publicDir, (file) => {
    if (!file.endsWith('.wasm')) return;
    const digest = sha(fs.readFileSync(file));
    if (digest !== coreDigest && digest !== canvasDigest) throw new Error(`Unreviewed public WASM: ${path.basename(file)}`);
    observed.add(digest);
  });
  if (!observed.has(coreDigest) || !observed.has(canvasDigest)) throw new Error('Packaged WASM does not match reviewed notice inventories');
}

function verifyBackendSnapshot(snapshot, bundle, expectedLock) {
  if (snapshot.schemaVersion !== 1 || snapshot.sourceLockSha256 !== expectedLock || !Object.keys(snapshot.bundleFiles || {}).length) throw new Error('Stale backend license build snapshot; rebuild backend');
  for (const [relative, expected] of Object.entries(snapshot.bundleFiles)) {
    const file = path.resolve(bundle, ...relative.split('/'));
    if (!file.startsWith(bundle + path.sep)) throw new Error('Backend snapshot path escapes bundle');
    if (expected.symlink !== undefined) {
      if (fs.readlinkSync(file) !== expected.symlink) throw new Error(`Backend link differs from license build snapshot: ${relative}`);
    } else if (sha(fs.readFileSync(file)) !== expected.sha256) throw new Error(`Backend differs from license build snapshot: ${relative}`);
  }
  const actual = [];
  function inspect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (path.relative(bundle, file) !== 'license-build.json') actual.push(slash(path.relative(bundle, file)));
    }
  }
  inspect(bundle);
  if (actual.length !== Object.keys(snapshot.bundleFiles).length || actual.some((p) => !snapshot.bundleFiles[p])) throw new Error('Backend contains unreviewed files outside license build snapshot');
}

function generate({ repoRoot, resourcesDir }) {
  const frontend = path.join(repoRoot, 'frontend');
  const licenseRoot = path.join(resourcesDir, 'licenses');
  fs.mkdirSync(licenseRoot, { recursive: true });
  const manifest = { schemaVersion: 1, application: 'coredotdocs', version: json(path.join(repoRoot, 'desktop/package.json')).version,
    scope: 'Installed npm runtime dependency closure plus bundled studio dependencies; exact PyInstaller distribution inputs; conservative native dependency notice supersets.',
    sourceLocks: {}, packages: [] };
  for (const lock of ['frontend/pnpm-lock.yaml', 'backend/uv.lock']) manifest.sourceLocks[lock] = sha(fs.readFileSync(path.join(repoRoot, lock)));
  const sections = ['coredotdocs — Third-party licenses and notices\n\nThis file preserves upstream license texts and attribution. Some native dependency inventories conservatively include optional/development components. Their inclusion is not a claim that every listed component is linked into the app.'];
  const written = new Map();
  function write(relative, text) {
    const target = path.resolve(licenseRoot, relative);
    if (!target.startsWith(licenseRoot + path.sep)) throw new Error('License path escapes output directory');
    const digest = sha(Buffer.from(text));
    if (written.has(relative) && written.get(relative) !== digest) throw new Error(`Conflicting notice path: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    written.set(relative, digest);
    return { path: `licenses/${slash(relative)}`, sha256: digest };
  }
  function add(ecosystem, pkg) {
    const key = safeName(`${pkg.name}@${pkg.version}`);
    const licenseFiles = pkg.notices.map((notice) => write(path.join(ecosystem, key, ...notice.file.replace(/\\/g, '/').split('/')), notice.text));
    manifest.packages.push({ ecosystem, name: pkg.name, version: pkg.version, license: pkg.license,
      source: pkg.source, licenseFiles });
    sections.push(`\n${'='.repeat(78)}\n${pkg.name} ${pkg.version} (${ecosystem})\nLicense: ${pkg.license}\nSource: ${pkg.source}\n` +
      pkg.notices.map((notice) => `\n--- ${notice.file} ---\n${notice.text}`).join('\n'));
  }
  // Retain local vendor notices, including nested emf-converter attribution.
  const staticNotices = [];
  walk(licenseRoot, (file) => {
    const relative = slash(path.relative(licenseRoot, file));
    if (NOTICE.test(path.basename(file)) && !/^(npm|python|rust|native)\//.test(relative)) staticNotices.push({ file: relative, text: fs.readFileSync(file, 'utf8') });
  });
  sections.push('\nApplication and directly vendored components\n' + staticNotices.map((n) => `\n--- ${n.file} ---\n${n.text}`).join('\n'));
  for (const pkg of npmPackages(frontend, path.join(resourcesDir, 'web'))) add('npm', pkg);
  const backendDir = path.join(resourcesDir, 'backend/editor-server');
  const pythonData = json(path.join(backendDir, 'license-build.json'));
  verifyBackendSnapshot(pythonData, backendDir, manifest.sourceLocks['backend/uv.lock']);
  if (pythonData.runtime.version !== fs.readFileSync(path.join(__dirname, 'python-version.txt'), 'utf8').trim()) throw new Error('Backend runtime version does not match the reviewed pin');
  for (const pkg of [pythonData.runtime, ...pythonData.packages]) add('python', pkg);
  const nativePython = json(path.join(repoRoot, 'desktop/licenses/python-native.json'));
  for (const project of nativePython.projects) {
    const bundled = pythonData.packages.find((p) => p.name.toLowerCase().replaceAll('_', '-') === project.name);
    if (bundled && bundled.version !== project.version) throw new Error(`Native Python notice version mismatch: ${project.name}`);
  }
  const core = json(path.join(frontend, 'node_modules/@rhwp/core/package.json'));
  const canvas = json(path.join(frontend, 'node_modules/canvaskit-wasm/package.json'));
  const inventories = [
    [json(path.join(repoRoot, `desktop/licenses/rhwp-${core.version}.json`)), path.join(frontend, 'node_modules/@rhwp/core/rhwp_bg.wasm')],
    [nativePython, null],
    [json(path.join(repoRoot, `desktop/licenses/canvaskit-${canvas.version}.json`)), path.join(frontend, 'node_modules/canvaskit-wasm/bin/canvaskit.wasm')],
    [json(path.join(repoRoot, `desktop/licenses/python-runtime-${pythonData.runtime.version}.json`)), null],
  ];
  const runtimeInventory = inventories[3][0];
  if (!runtimeInventory.runtimeBinarySha256?.[`${process.platform}-${process.arch}`]) throw new Error(`Python native notices need a reviewed ${process.platform}-${process.arch} runtime inventory before packaging`);
  if (runtimeInventory.runtimeVersion !== pythonData.runtime.version || runtimeInventory.runtimeBuild !== pythonData.runtimeBuild) throw new Error('Native Python runtime notice inventory is stale');
  for (const [name, version] of Object.entries(runtimeInventory.nativeVersions)) {
    if (pythonData.nativeVersions?.[name] !== version) throw new Error(`Native Python ${name} version does not match reviewed notices`);
  }
  for (const [name, digest] of Object.entries(runtimeInventory.runtimeBinarySha256?.[`${process.platform}-${process.arch}`] || {})) {
    const binary = path.join(backendDir, '_internal', name);
    if (fs.existsSync(binary) && sha(fs.readFileSync(binary)) !== digest) throw new Error(`Native Python binary does not match reviewed runtime: ${name}`);
  }
  const nativeSeen = new Set();
  for (const [inventory, wasm] of inventories) {
    verifyInventory(inventory, wasm);
    for (const pkg of inventory.packages) {
      const identity = `${pkg.name}@${pkg.version}:${sha(JSON.stringify(pkg.noticeTexts))}`;
      if (nativeSeen.has(identity)) continue;
      nativeSeen.add(identity);
      const licenseFiles = Object.entries(pkg.noticeTexts).map(([file, digest]) => {
        const result = write(path.join('native', 'texts', `${digest}.txt`), inventory.texts[digest]);
        return { upstreamFile: file, ...result };
      });
      manifest.packages.push({ ecosystem: 'native', name: pkg.name, version: pkg.version, license: pkg.selectedLicense || pkg.license,
        source: pkg.source, sourceSha256: pkg.sourceSha256, authors: pkg.authors || [], acknowledgement: pkg.acknowledgement, licenseFiles });
      sections.push(`\n${'='.repeat(78)}\n${pkg.name} ${pkg.version} (native dependency)\nLicense: ${pkg.selectedLicense || pkg.license}\nSource: ${pkg.source}\n${(pkg.authors || []).join('\n')}\n${pkg.acknowledgement || ''}\n` +
        Object.entries(pkg.noticeTexts).map(([file, digest]) => `\n--- ${file} ---\n${inventory.texts[digest]}`).join('\n'));
    }
  }
  const coreDigest = inventories[0][0].wasmSha256;
  const canvasDigest = inventories[2][0].wasmSha256;
  verifyPublicWasm(path.join(resourcesDir, 'web/public'), coreDigest, canvasDigest);
  const aggregate = sections.join('\n');
  for (const expected of ['Vercel', 'Tiptap GmbH', 'PYTHON SOFTWARE FOUNDATION LICENSE', 'FreeType']) {
    if (!aggregate.includes(expected)) throw new Error(`Required aggregate attribution missing: ${expected}`);
  }
  fs.writeFileSync(path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt'), aggregate + '\n');
  fs.writeFileSync(path.join(resourcesDir, 'third-party-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Re-read the actual output. Missing/truncated notices fail packaging immediately.
  for (const pkg of manifest.packages) for (const file of pkg.licenseFiles) {
    if (sha(fs.readFileSync(path.join(resourcesDir, file.path))) !== file.sha256) throw new Error(`Packaged license checksum mismatch: ${file.path}`);
  }
  // Build certification is consumed before macOS signing changes native bytes;
  // the user-facing manifest hashes license text, which signing does not change.
  fs.unlinkSync(path.join(backendDir, 'license-build.json'));
  console.log(`  • Third-party notices: ${manifest.packages.length} package records, ${written.size} text files`);
  return manifest;
}

module.exports = { generate, npmPackages, verifyInventory, verifyBackendSnapshot, verifyPublicWasm };
