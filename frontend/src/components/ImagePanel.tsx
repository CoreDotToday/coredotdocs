"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

type Img = { image_id: string; filename: string; width: number; height: number };

export function ImagePanel({ documentId }: { documentId: string }) {
  const [images, setImages] = useState<Img[]>([]);
  const [status, setStatus] = useState("");

  async function refresh() {
    try {
      const res = await fetch(`${API_BASE}/api/documents/${documentId}/images`, { cache: "no-store" });
      if (res.ok) setImages(await res.json());
    } catch {}
  }

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/documents/${documentId}/images`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Img[]) => {
        if (alive) setImages(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [documentId]);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setStatus("올리는 중…");
    try {
      const res = await fetch(`${API_BASE}/api/documents/${documentId}/images`, { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      setStatus("");
      await refresh();
    } catch (err) {
      setStatus(String(err));
    } finally {
      e.target.value = "";
    }
  }

  return (
    <section className="panel">
      <h2>그림</h2>
      <p className="muted">올린 그림은 insert_image 도구에 image_id로 넣습니다 (PNG·JPEG·GIF·BMP).</p>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/bmp" onChange={upload} aria-label="그림 올리기" />
      <span className="muted">{status}</span>
      <ul className="hits">
        {images.map((img) => (
          <li key={img.image_id}>
            <code>{img.image_id}</code> {img.filename} ({img.width}×{img.height})
          </li>
        ))}
      </ul>
    </section>
  );
}
