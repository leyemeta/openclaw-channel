import { describe, expect, it, vi } from "vitest";

import {
  AttachmentDownloadError,
  buildSkippedAttachmentsNote,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  processInboundAttachments,
  type AttachmentMediaRuntime,
} from "../../src/channel/attachments.js";
import type { InboundAttachment } from "../../src/transport/frames.js";

function makeMedia(overrides: Partial<AttachmentMediaRuntime> = {}): AttachmentMediaRuntime {
  return {
    fetchRemoteMedia: vi.fn(async ({ url }) => ({
      buffer: Buffer.from(`bytes:${url}`),
      contentType: "image/png",
      fileName: undefined,
    })),
    saveMediaBuffer: vi.fn(async (buf: Buffer, mime?: string, _sub?: string, _max?: number, name?: string) => ({
      id: `id-${name}`,
      path: `/tmp/media/${name}`,
      size: buf.byteLength,
      contentType: mime,
    })),
    ...overrides,
  } as AttachmentMediaRuntime;
}

function captureLog() {
  const calls: Record<string, string[]> = { info: [], warn: [], error: [], debug: [] };
  return {
    log: {
      info: (m: string) => calls.info.push(m),
      warn: (m: string) => calls.warn.push(m),
      error: (m: string) => calls.error.push(m),
      debug: (m: string) => calls.debug.push(m),
    },
    calls,
  };
}

describe("processInboundAttachments · happy path", () => {
  it("空附件列表返回空 fields", async () => {
    const media = makeMedia();
    const result = await processInboundAttachments({ attachments: undefined, media });
    expect(result.fields).toEqual({});
    expect(result.acceptedCount).toBe(0);
    expect(media.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("单张图片下载并落盘,fields 含 MediaPath/MediaPaths/MediaType/MediaTypes", async () => {
    const media = makeMedia();
    const atts: InboundAttachment[] = [
      { type: "image", url: "https://x/a.png", filename: "a.png", mime: "image/png" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(1);
    expect(result.fields).toEqual({
      MediaPath: "/tmp/media/a.png",
      MediaPaths: ["/tmp/media/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
    expect(media.fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://x/a.png",
      maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    });
  });

  it("多附件按顺序进 MediaPaths/MediaTypes", async () => {
    const media = makeMedia({
      fetchRemoteMedia: vi.fn(async ({ url }) => ({
        buffer: Buffer.from(url),
        contentType: url.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
      })),
      saveMediaBuffer: vi.fn(async (buf, mime, _sub, _max, name) => ({
        id: `id-${name}`,
        path: `/tmp/media/${name}`,
        size: buf.byteLength,
        contentType: mime,
      })),
    });
    const atts: InboundAttachment[] = [
      { type: "image", url: "https://x/1.jpg", filename: "1.jpg", mime: "image/jpeg" },
      { type: "document", url: "https://x/2.pdf", filename: "2.pdf", mime: "application/pdf" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(2);
    expect(result.fields.MediaPaths).toEqual(["/tmp/media/1.jpg", "/tmp/media/2.pdf"]);
    expect(result.fields.MediaTypes).toEqual(["image/jpeg", "application/pdf"]);
    expect(result.fields.MediaPath).toBe("/tmp/media/1.jpg");
    expect(result.fields.MediaType).toBe("image/jpeg");
  });

  it("无 filename 时用 attachment-<idx>", async () => {
    const media = makeMedia();
    const atts: InboundAttachment[] = [
      { type: "image", url: "https://x/anon", mime: "image/png" },
    ];
    await processInboundAttachments({ attachments: atts, media });
    expect(media.saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
      "inbound",
      DEFAULT_MAX_ATTACHMENT_BYTES,
      "attachment-1",
    );
  });

  it("帧 mime 缺失时用 fetch response 的 Content-Type 复查支持范围", async () => {
    const media = makeMedia({
      fetchRemoteMedia: vi.fn(async () => ({
        buffer: Buffer.from("pdf"),
        contentType: "application/pdf; charset=binary",
      })),
    });
    const atts: InboundAttachment[] = [
      { type: "document", url: "https://x/a.pdf", filename: "a.pdf" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(1);
    expect(result.fields.MediaTypes).toEqual(["application/pdf"]);
  });
});

describe("processInboundAttachments · 黑名单跳过逻辑", () => {
  it("非黑名单类型(视频)默认放行并落盘", async () => {
    const media = makeMedia({
      fetchRemoteMedia: vi.fn(async () => ({
        buffer: Buffer.from("video-bytes"),
        contentType: "video/mp4",
      })),
    });
    const atts: InboundAttachment[] = [
      { type: "video", url: "https://x/v.mp4", filename: "v.mp4", mime: "video/mp4" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.fields.MediaPaths).toEqual(["/tmp/media/v.mp4"]);
    expect(result.fields.MediaTypes).toEqual(["video/mp4"]);
  });

  it("不安全后缀(.exe)按文件名提前跳过,不下载", async () => {
    const media = makeMedia();
    const { log, calls } = captureLog();
    const atts: InboundAttachment[] = [
      { type: "file", url: "https://x/setup.exe", filename: "setup.exe", mime: "application/octet-stream" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media, log });
    expect(result.acceptedCount).toBe(0);
    expect(result.skipped).toEqual([
      { filename: "setup.exe", mime: "application/octet-stream", reason: "unsafe-extension" },
    ]);
    expect(media.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(calls.warn.join("\n")).toMatch(/unsafe extension/);
  });

  it("后缀判定大小写不敏感 + 忽略 query 串(.JS?token=)", async () => {
    const media = makeMedia();
    const atts: InboundAttachment[] = [
      { type: "file", url: "https://x/a", filename: "evil.JS?token=abc", mime: "" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(0);
    expect(result.skipped[0]).toMatchObject({ filename: "evil.JS?token=abc", reason: "unsafe-extension" });
    expect(media.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("此前被白名单挡掉的 zip 现在放行", async () => {
    const media = makeMedia({
      fetchRemoteMedia: vi.fn(async () => ({
        buffer: Buffer.from("..."),
        contentType: "application/zip",
      })),
    });
    const atts: InboundAttachment[] = [
      { type: "document", url: "https://x/a.zip", filename: "a.zip" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(1);
    expect(result.fields.MediaPaths).toEqual(["/tmp/media/a.zip"]);
    expect(result.fields.MediaTypes).toEqual(["application/zip"]);
    expect(result.skipped).toHaveLength(0);
  });

  it("混合:安全 + 不安全,只保留安全的", async () => {
    const media = makeMedia();
    const atts: InboundAttachment[] = [
      { type: "file", url: "https://x/m.bat", filename: "m.bat", mime: "application/octet-stream" },
      { type: "image", url: "https://x/a.png", filename: "a.png", mime: "image/png" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media });
    expect(result.acceptedCount).toBe(1);
    expect(result.fields.MediaPaths).toEqual(["/tmp/media/a.png"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ filename: "m.bat", reason: "unsafe-extension" });
  });

  it("缺 url 时仅 warn 跳过,不算 skipped(协议层错误,非用户附件类型问题)", async () => {
    const media = makeMedia();
    const { log, calls } = captureLog();
    const atts: InboundAttachment[] = [
      // @ts-expect-error 故意构造 url 缺失场景
      { type: "image", url: "", filename: "bad.png", mime: "image/png" },
    ];
    const result = await processInboundAttachments({ attachments: atts, media, log });
    expect(result.acceptedCount).toBe(0);
    expect(result.skipped).toHaveLength(0);
    expect(calls.warn.join("\n")).toMatch(/missing url/);
  });
});

describe("processInboundAttachments · 失败兜底", () => {
  it("白名单内附件下载失败 → 抛 AttachmentDownloadError", async () => {
    const media = makeMedia({
      fetchRemoteMedia: vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    });
    const atts: InboundAttachment[] = [
      { type: "image", url: "https://x/a.png", filename: "a.png", mime: "image/png" },
    ];
    await expect(
      processInboundAttachments({ attachments: atts, media }),
    ).rejects.toBeInstanceOf(AttachmentDownloadError);
  });

  it("AttachmentDownloadError 携带 filename + cause", async () => {
    const cause = new Error("boom");
    const media = makeMedia({
      fetchRemoteMedia: vi.fn(async () => {
        throw cause;
      }),
    });
    const atts: InboundAttachment[] = [
      { type: "image", url: "https://x/x.png", filename: "x.png", mime: "image/png" },
    ];
    try {
      await processInboundAttachments({ attachments: atts, media });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentDownloadError);
      const e = err as AttachmentDownloadError;
      expect(e.filename).toBe("x.png");
      expect(e.cause).toBe(cause);
    }
  });

  it("saveMediaBuffer 失败也归 AttachmentDownloadError", async () => {
    const media = makeMedia({
      saveMediaBuffer: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const atts: InboundAttachment[] = [
      { type: "image", url: "https://x/a.png", filename: "a.png", mime: "image/png" },
    ];
    await expect(
      processInboundAttachments({ attachments: atts, media }),
    ).rejects.toBeInstanceOf(AttachmentDownloadError);
  });
});

describe("buildSkippedAttachmentsNote", () => {
  it("空 skipped 返回空字符串", () => {
    expect(buildSkippedAttachmentsNote([])).toBe("");
  });

  it("拼出附件名 + mime", () => {
    const note = buildSkippedAttachmentsNote([
      { filename: "setup.exe", mime: "application/octet-stream", reason: "unsafe-extension" },
      { filename: "m.bat", mime: "application/octet-stream", reason: "unsafe-extension" },
    ]);
    expect(note).toContain("setup.exe (application/octet-stream)");
    expect(note).toContain("m.bat (application/octet-stream)");
    expect(note).toMatch(/^\n\[已忽略不安全的附件:/);
  });

  it("mime 为空时只显示文件名", () => {
    const note = buildSkippedAttachmentsNote([
      { filename: "evil.vbs", mime: "", reason: "unsafe-extension" },
    ]);
    expect(note).toContain("evil.vbs");
    expect(note).not.toContain("()");
  });
});
