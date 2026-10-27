/**
 * Derived from IeumOffice apps/hwp/scripts/build-studio.mjs (Apache-2.0, see ./LICENSE and ./NOTICE).
 * Changes for coredotdocs: cache and output paths, engine from npm @rhwp/core, no custom scheme.
 *
 * Builds rhwp-studio (MIT, https://github.com/edwardkim/rhwp) from the pinned tag and ships it under
 * frontend/public/rhwp, with coredotdocs' plugin (agent-plugin.mjs) compiled in and the patches in
 * rhwp-patches.mjs applied. rhwp publishes its engine (@rhwp/core) and embed SDK (@rhwp/editor) on
 * npm but not the studio; the public GitHub Pages build only allows its own hwpctrl plugin.
 *
 * Usage: node third_party/ieumoffice-hwp/build-studio.mjs [--force]
 * Requires git and network on the first run (~16MB sparse checkout, cached under
 * frontend/node_modules/.cache/rhwp-studio/<tag>). The studio's own dependencies (@noble/hashes,
 * canvaskit-wasm, pixelmatch, pngjs, vite) are devDependencies of frontend/, which the cached
 * checkout resolves by walking up to frontend/node_modules.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_PLUGIN_MODULE, STUDIO_PATCHES, missingPluginHooks, rhwpPatches } from './rhwp-patches.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const FRONTEND = join(ROOT, 'frontend')
const require = createRequire(join(FRONTEND, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)

const REPO = 'https://github.com/edwardkim/rhwp.git'
const CORE_DIR = dirname(require.resolve('@rhwp/core/package.json'))
const core = JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8'))
const VERSION = core.version
const TAG = `v${VERSION}`
/** Commit each supported tag must resolve to; a moved tag stops the build (docs/04 §9.3-3). */
const PINNED_COMMITS = {
  'v0.8.7': '1a76570e833917d15817415a53c09ad61ab3203f',
}
/** Only what the build reads. The repository also carries large sample documents and a font set. */
const SPARSE_PATTERNS = [
  '/LICENSE',
  '/THIRD_PARTY_LICENSES.md',
  '/rhwp-studio/index.html',
  '/rhwp-studio/src/',
  '/rhwp-studio/public/',
  '!/rhwp-studio/public/fonts',
  '!/rhwp-studio/public/samples',
  '/npm/hwpctrl-ocx/src/',
]

const CACHE = join(FRONTEND, 'node_modules', '.cache', 'rhwp-studio', TAG)
const OUT = join(FRONTEND, 'public', 'rhwp')
const AGENT_PLUGIN = join(HERE, 'agent-plugin.mjs')
const STAMP = join(OUT, '.stamp')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()
}

function stampValue() {
  const hash = createHash('sha256')
  hash.update('build:' + TAG)
  for (const file of ['build-studio.mjs', 'rhwp-patches.mjs', 'agent-plugin.mjs', '../../frontend/scripts/studio-format-patches.mjs']) hash.update(readFileSync(join(HERE, file)))
  hash.update(readFileSync(join(CORE_DIR, 'rhwp_bg.wasm')))
  return hash.digest('hex')
}

function fetchSource() {
  const pinned = PINNED_COMMITS[TAG]
  if (!pinned) throw new Error(`rhwp-studio: no pinned commit for ${TAG}; add it to PINNED_COMMITS after reviewing the release`)
  if (existsSync(join(CACHE, '.git')) && git(['rev-parse', 'HEAD'], CACHE) === pinned) {
    git(['sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS], CACHE)
    return
  }
  rmSync(CACHE, { recursive: true, force: true })
  mkdirSync(dirname(CACHE), { recursive: true })
  console.log(`rhwp-studio: fetching ${TAG} from ${REPO}`)
  git(['clone', '--depth', '1', '--branch', TAG, '--filter=blob:none', '--no-checkout', REPO, CACHE], dirname(CACHE))
  git(['sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS], CACHE)
  git(['checkout', '--quiet', TAG], CACHE)
  const head = git(['rev-parse', 'HEAD'], CACHE)
  if (head !== pinned) {
    rmSync(CACHE, { recursive: true, force: true })
    throw new Error(`rhwp-studio: ${TAG} resolved to ${head}, expected ${pinned}`)
  }
}

/** Stop the build when the fetched studio no longer has what the plugin reaches into. */
function checkPluginHooks() {
  const missing = missingPluginHooks((file) => {
    try {
      return readFileSync(join(CACHE, 'rhwp-studio', file), 'utf8')
    } catch {
      return null
    }
  })
  if (missing.length > 0) {
    throw new Error(`rhwp-studio ${TAG}: the editor no longer has what the plugin uses (see pluginHooks in rhwp-patches.mjs):\n  ` + missing.join('\n  '))
  }
}

async function buildStudio() {
  const studio = join(CACHE, 'rhwp-studio')
  await build({
    configFile: false,
    root: studio,
    base: './',
    logLevel: 'warn',
    define: {
      __APP_VERSION__: JSON.stringify(VERSION),
      // no CDN web fonts: the app makes no request the user did not ask for
      __RHWP_DISABLE_EXTERNAL_WEBFONTS__: 'true',
      __RHWP_HWPCTRL__: 'true',
    },
    resolve: {
      alias: {
        '@': join(studio, 'src'),
        '@wasm': CORE_DIR,
        '@rhwp/hwpctrl/studio-plugin': join(CACHE, 'npm', 'hwpctrl-ocx', 'src', 'studio-plugin.mjs'),
        [AGENT_PLUGIN_MODULE]: AGENT_PLUGIN,
      },
    },
    // upstream registers a service worker for its website build; this build leaves that plugin out
    plugins: [rhwpPatches(...STUDIO_PATCHES)],
    build: { outDir: OUT, emptyOutDir: true, chunkSizeWarningLimit: 4096 },
  })
  copyFileSync(join(CACHE, 'LICENSE'), join(OUT, 'LICENSE-rhwp.txt'))
  copyFileSync(join(CACHE, 'THIRD_PARTY_LICENSES.md'), join(OUT, 'THIRD-PARTY-LICENSES-rhwp.md'))
}

const force = process.argv.includes('--force')
const stamp = stampValue()
if (!force && existsSync(join(OUT, 'index.html')) && existsSync(STAMP) && readFileSync(STAMP, 'utf8') === stamp) {
  console.log(`rhwp-studio: ${TAG} build is up to date (${OUT})`)
} else {
  fetchSource()
  checkPluginHooks()
  await buildStudio()
  rmSync(join(OUT, '.complete'), { force: true }) // the mirror's marker, if a mirror was here before
  writeFileSync(STAMP, stamp)
  console.log(`rhwp-studio: built ${TAG} into ${OUT}`)
}
