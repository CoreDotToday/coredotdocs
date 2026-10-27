"use client";

import { useEffect, useRef, useState } from "react";
import { APP_VERSION, RELEASES_URL } from "@/lib/app-info";
import { desktopBridge } from "@/lib/desktop";
import { HELP_TOPICS, type HelpSectionId } from "@/lib/help";
import styles from "./HelpDialog.module.css";

const SHORTCUTS = [
  ["도움말 열기", "F1", "F1"],
  ["새 한글 문서", "Ctrl+N", "⌘N"],
  ["문서 열기", "Ctrl+O", "⌘O"],
  ["저장", "Ctrl+S", "⌘S"],
  ["다른 이름으로 저장", "Ctrl+Shift+S", "⇧⌘S"],
  ["탭 닫기", "Ctrl+W", "⌘W"],
  ["AI 패널 표시·숨기기", "Ctrl+J", "⌘J"],
  ["편집 용지", "F7", "F7"],
  ["도움말 닫기", "Esc", "Esc"],
];

export function HelpDialog({ initialSection, onClose }: { initialSection: HelpSectionId; onClose: () => void }) {
  const [section, setSection] = useState(initialSection);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const topic = HELP_TOPICS.find((item) => item.id === section) ?? HELP_TOPICS[0];
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = HELP_TOPICS.filter((item) => {
    const text = `${JSON.stringify(item)} ${item.id === "about" ? APP_VERSION : ""} ${item.id === "shortcuts" ? SHORTCUTS.flat().join(" ") : ""}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    search.current?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function select(id: HelpSectionId) {
    setSection(id);
    setQuery("");
    content.current?.scrollTo({ top: 0 });
  }

  const version = desktopBridge()?.version ?? APP_VERSION;
  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="help-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.mark} aria-hidden="true">C.</span>
          <div>
            <p className={styles.eyebrow}>Core.Docs · 도움말</p>
            <h1 id="help-title">코어닷독스 사용 안내</h1>
          </div>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="도움말 닫기" title="닫기 (Esc)">×</button>
        <div className={styles.search}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          <input ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="궁금한 기능을 검색하세요. 예: 저장, PDF, AI 연결" aria-label="도움말 검색" />
          {query && <button type="button" onClick={() => { setQuery(""); search.current?.focus(); }} aria-label="검색어 지우기">지우기</button>}
        </div>
      </header>
      <div className={styles.body}>
        <nav className={styles.sidebar} aria-label="도움말 주제">
          <p className={styles.navLabel}>사용 가이드</p>
          {HELP_TOPICS.map((item, index) => <button key={item.id} type="button" aria-current={!terms.length && section === item.id ? "page" : undefined} onClick={() => select(item.id)}><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}
          <div className={styles.sidebarNote}>도움말은 인터넷 연결 없이<br />앱 안에서 볼 수 있습니다.</div>
        </nav>
        <div ref={content} className={styles.content}>
          {terms.length ? <>
            <p className={styles.eyebrow}>찾고 있는 기능을 골라 보세요</p>
            <h2>검색 결과 <span className={styles.count}>{matches.length}</span></h2>
            <p className={styles.summary} role="status">“{query.trim()}” 검색 결과입니다.</p>
            {matches.length ? <div className={styles.results}>{matches.map((item) => <button key={item.id} type="button" onClick={() => select(item.id)}><strong>{item.title}<span aria-hidden="true">↗</span></strong><span>{item.summary}</span></button>)}</div> : <div className={styles.empty}><strong>일치하는 도움말이 없습니다.</strong><p>‘저장’, ‘한글’, ‘단축키’처럼 짧은 단어로 검색하거나 왼쪽 주제를 선택하세요.</p><button type="button" className="secondary" onClick={() => select("start")}>처음 사용하기</button></div>}
          </> : <>
            <p className={styles.eyebrow}>{topic.id === "about" ? "함께 쓰고, 더 쉽게 고치세요" : "코어닷독스 가이드"}</p>
            <h2>{topic.title}</h2>
            <p className={styles.summary}>{topic.summary}</p>
            {topic.id === "start" && <div className={styles.quickLinks}>{[["files", "저장은 어떻게 하나요?"], ["ai", "AI로 고쳐 보고 싶어요"], ["shortcuts", "단축키를 보고 싶어요"]].map(([id, label]) => <button key={id} type="button" onClick={() => select(id as HelpSectionId)}>{label}<span aria-hidden="true">→</span></button>)}</div>}
            {topic.id === "about" && <div className={styles.versionCard}><span className={styles.versionLabel}>현재 버전</span><strong>{version}</strong><p>한글·Word 문서를 AI와 함께 고치는 문서 편집기</p><a href={RELEASES_URL} target="_blank" rel="noreferrer">GitHub 릴리스 및 변경 사항 보기 <span aria-hidden="true">↗</span></a></div>}
            {topic.articles.map((article) => <section key={article.title} className={styles.article}><h3>{article.title}</h3>{article.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}{article.steps && <ol>{article.steps.map((step) => <li key={step}>{step}</li>)}</ol>}{article.note && <aside className={styles.note}><strong>알아 두세요</strong><p>{article.note}</p></aside>}</section>)}
            {topic.id === "shortcuts" && <><div className={styles.tableWrap}><table><thead><tr><th scope="col">기능</th><th scope="col">Windows · Linux</th><th scope="col">macOS</th></tr></thead><tbody>{SHORTCUTS.map(([label, windows, mac]) => <tr key={label}><th scope="row">{label}</th><td><kbd>{windows}</kbd></td><td><kbd>{mac}</kbd></td></tr>)}</tbody></table></div><p className={styles.muted}>편집 단축키는 본문에 커서가 있을 때 사용하세요. 문서 형식과 현재 선택에 따라 사용할 수 있는 기능이 달라집니다.</p></>}
            <div className={styles.related}><span>다음으로 살펴보기</span><button type="button" onClick={() => select(HELP_TOPICS[(HELP_TOPICS.indexOf(topic) + 1) % HELP_TOPICS.length].id)}>{HELP_TOPICS[(HELP_TOPICS.indexOf(topic) + 1) % HELP_TOPICS.length].title} →</button></div>
          </>}
        </div>
      </div>
      <footer className={styles.footer}><span>코어닷독스 <b>{version}</b></span><a href={RELEASES_URL} target="_blank" rel="noreferrer">GitHub 릴리스 ↗</a><span className={styles.escape}><kbd>Esc</kbd> 닫기</span></footer>
    </dialog>
  );
}
