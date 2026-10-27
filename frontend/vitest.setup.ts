import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// globals: false 설정에서는 RTL 자동 정리가 안 되므로 테스트마다 DOM을 비운다
afterEach(() => cleanup());
