// macOS 서명: Developer ID가 없으면 ad-hoc('-')으로, Electron이 요구하는 순서·entitlements로 서명한다.
// (codesign --deep로 프레임워크까지 뭉뚱그려 다시 서명하면 Electron이 초기화 중 SIGTRAP으로 죽는다.)
// 사용: node scripts/sign-mac.js "<path>/Foo.app" [identity]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findOsxSign() {
  try {
    return require("@electron/osx-sign");
  } catch {}
  const pnpm = path.join(__dirname, "..", "node_modules", ".pnpm");
  const dir = fs.readdirSync(pnpm).find((d) => d.startsWith("@electron+osx-sign@"));
  if (!dir) throw new Error("@electron/osx-sign을 찾지 못했습니다 (pnpm install 필요)");
  return require(path.join(pnpm, dir, "node_modules", "@electron", "osx-sign"));
}

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`;

async function main() {
  const [app, identity = "-"] = process.argv.slice(2);
  if (!app) throw new Error("앱 경로를 주세요");
  const { signAsync } = findOsxSign();
  const ent = path.join(os.tmpdir(), `entitlements-${process.pid}.plist`);
  fs.writeFileSync(ent, ENTITLEMENTS);
  try {
    await signAsync({
      app: path.resolve(app),
      identity,
      platform: "darwin",
      preAutoEntitlements: false,
      identityValidation: identity !== "-",
      optionsForFile: () => ({ entitlements: ent, hardenedRuntime: identity !== "-" }),
    });
    console.log(`서명 완료 (${identity === "-" ? "ad-hoc" : identity}): ${app}`);
  } finally {
    fs.rmSync(ent, { force: true });
  }
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
