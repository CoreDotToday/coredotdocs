// 편집기 안 플러그인(third_party/ieumoffice-hwp/agent-plugin.mjs, Apache-2.0)과의 다리.
// 우리 코드는 이 파일의 `plugins.invoke("coredotdocs-agent", method, args)` 하나로만 그 플러그인에 닿는다 (설계 문서 04 §9.3-1).
import type { AgentPluginSurface } from "../../../third_party/ieumoffice-hwp/agent-plugin.d.mts";
import type { RhwpEditor } from "./studio";

export const AGENT_PLUGIN_ID = "coredotdocs-agent";

export type AgentBridge = {
  [K in keyof AgentPluginSurface]: (...args: Parameters<AgentPluginSurface[K]>) => Promise<ReturnType<AgentPluginSurface[K]>>;
} & {
  /** 플러그인을 올릴 수 있는가 (공개 미러 빌드에는 없다) */
  available(): Promise<boolean>;
};

const METHODS: (keyof AgentPluginSurface)[] = [
  "foreignChanges",
  "readText",
  "findText",
  "replaceText",
  "replaceAllText",
  "insertParagraphs",
  "deleteParagraph",
  "insertTable",
  "formatText",
  "formatParagraph",
  "listTables",
  "readTable",
  "fillCells",
  "addTableLines",
  "removeTableLines",
  "deleteTable",
  "installFileMenu",
  "reveal",
  "selection",
  "replaceSelection",
  "formatSelection",
  "listFields",
  "fillField",
  "insertToc",
  "refreshToc",
  "listNotes",
  "insertNote",
  "editNote",
  "deleteNote",
  "measureTabs",
  "clearMarks",
  "listStyles",
  "printPages",
  "formatCells",
  "mergeCells",
  "splitCell",
  "undo",
];

/** 플러그인을 처음 쓸 때 올리고(스튜디오마다 한 번), 메서드마다 iframe으로 메시지를 보낸다. 올리기에 실패하면 다음 호출이 다시 시도한다. */
export function createAgentBridge(studio: RhwpEditor): AgentBridge {
  let ready: Promise<unknown> | null = null;
  const load = () => {
    if (!ready) {
      ready = studio.plugins.load(AGENT_PLUGIN_ID);
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };
  const bridge: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async available() {
      try {
        await load();
        return true;
      } catch {
        return false; // 공개 미러 빌드(플러그인 없음)면 여기로 온다 → 서버 실행으로 폴백
      }
    },
  };
  for (const m of METHODS) {
    bridge[m] = async (...args: unknown[]) => {
      await load();
      return studio.plugins.invoke(AGENT_PLUGIN_ID, m, args);
    };
  }
  return bridge as unknown as AgentBridge;
}
