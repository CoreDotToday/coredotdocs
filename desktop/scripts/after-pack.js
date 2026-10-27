// electron-builder afterPack 훅.
// 1) Next standalone(web/)을 직접 복사한다 — extraResources는 node_modules(pnpm 심링크 구조)를 버린다.
// 2) 앱과 편집기의 라이선스·저작권 고지를 별도 licenses/ 폴더에 보존한다.
// 3) macOS면 Electron 전용 entitlements로 ad-hoc 서명하고(sign-mac.js), provenance 속성을 떼어낸다(clean-sign-mac.sh).
//    dmg는 이 훅 뒤에 만들어지므로 설치 이미지에도 깨끗한 앱이 들어간다.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const appName = packager.appInfo.productFilename;
  const isMac = electronPlatformName === "darwin";
  const appDir = isMac ? path.join(appOutDir, `${appName}.app`) : appOutDir;
  const resDir = isMac ? path.join(appDir, "Contents", "Resources") : path.join(appOutDir, "resources");
  const src = path.join(__dirname, "..", "resources", "web");
  const dst = path.join(resDir, "web");
  // The desktop runs precompiled production routes. SWC's build-time download
  // fallback and its vendored tar are unused there and must not ship. Keep the
  // Next source installation intact for development/builds; do not patch vendor code.
  const buildOnlyPaths = [
    "node_modules/next/dist/compiled/tar",
    "node_modules/next/dist/lib/download-swc.js",
    "node_modules/next/dist/lib/download-swc.js.map",
    // images.unoptimized disables this unused native service in the built app.
    "node_modules/sharp",
    "node_modules/@img",
  ];
  const serverConfig = JSON.parse(fs.readFileSync(path.join(src, ".next", "required-server-files.json"), "utf8")).config;
  if (serverConfig.images?.unoptimized !== true) throw new Error("Rebuild frontend with images.unoptimized before excluding sharp from desktop");
  fs.rmSync(dst, { recursive: true, force: true });
  if (process.platform === "win32") {
    fs.cpSync(src, dst, {
      recursive: true,
      dereference: true,
      filter: (entry) => {
        const relative = path.relative(src, entry).split(path.sep).join("/");
        return !buildOnlyPaths.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`))
          && !/^node_modules\/\.pnpm\/(?:sharp@|@img\+sharp)/.test(relative);
      },
    });
  } else {
    execFileSync("rsync", ["-rlpt", ...buildOnlyPaths.map((entry) => `--exclude=/${entry}`), "--exclude=/node_modules/.pnpm/sharp@*", "--exclude=/node_modules/.pnpm/@img+sharp*", `${src}/`, `${dst}/`]);
  }
  console.log(`  • web 복사       ${dst}`);
  const repoRoot = path.resolve(__dirname, "..", "..");
  const licenses = path.join(resDir, "licenses");
  const notices = [
    [path.join(repoRoot, "LICENSE"), "LICENSE"],
    [path.join(repoRoot, "NOTICE"), "NOTICE"],
  ];
  for (const vendor of ["genoffice-docx", "ieumoffice-hwp"]) {
    for (const name of ["LICENSE", "NOTICE", "NOTICE-upstream", "ORIGIN.md"]) {
      const relative = path.join("third_party", vendor, name);
      notices.push([path.join(repoRoot, relative), relative]);
    }
  }
  notices.push(
    [path.join(repoRoot, "third_party", "genoffice-docx", "packages", "docx-engine", "src", "vendor", "emf-converter", "LICENSE"), path.join("third_party", "emf-converter", "LICENSE")],
    [path.join(repoRoot, "third_party", "genoffice-docx", "packages", "docx-engine", "src", "vendor", "emf-converter", "README.md"), path.join("third_party", "emf-converter", "ORIGIN.md")],
    [path.join(src, "public", "rhwp", "LICENSE-rhwp.txt"), path.join("third_party", "rhwp", "LICENSE-studio.txt")],
    [path.join(src, "public", "rhwp", "THIRD-PARTY-LICENSES-rhwp.md"), path.join("third_party", "rhwp", "THIRD-PARTY-LICENSES.md")],
    [path.join(src, "public", "rhwp-core", "LICENSE"), path.join("third_party", "rhwp", "LICENSE-core.txt")],
  );
  for (const [source, relative] of notices) {
    const target = path.join(licenses, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target); // Missing attribution fails packaging instead of silently omitting it.
  }
  console.log(`  • 라이선스 고지  ${licenses}`);
  require("./collect-licenses.cjs").generate({ repoRoot, resourcesDir: resDir });
  if (isMac) {
    execFileSync("node", [path.join(__dirname, "sign-mac.js"), appDir, process.env.MAC_SIGN_IDENTITY || "-"], { stdio: "inherit" });
    execFileSync(path.join(__dirname, "clean-sign-mac.sh"), [appDir], { stdio: "inherit" });
  }
};
