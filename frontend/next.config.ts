import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 개발 서버를 127.0.0.1로 열어도 클라이언트 청크·HMR을 막지 않는다 (Next 16은 localhost 외 origin을 기본 차단)
  allowedDevOrigins: ["127.0.0.1"],
  // 문서 목록·블록은 요청마다 백엔드에서 읽는다 (force-dynamic). 캐시 컴포넌트는 이 앱에서 쓰지 않는다.
  cacheComponents: false,
  // Docker 이미지에서 node_modules 없이 node server.js로 실행하기 위해
  output: "standalone",
  // Document images are rendered directly by the editors. The desktop never
  // needs Next's HTTP image optimizer or its native sharp/libvips dependency.
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    "/*": ["node_modules/sharp/**/*", "node_modules/@img/**/*", "node_modules/.pnpm/sharp@*/**/*", "node_modules/.pnpm/@img+sharp*/**/*"],
  },
};

export default nextConfig;
