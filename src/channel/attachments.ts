/**
 * 入站附件下载与落盘:把平台 URL 直链下载入沙箱,产出可合并进 ctxPayload 的
 * Media* 字段(磁盘绝对路径,agent 经 MsgContext.MediaPaths 读取)。
 * 帧格式 attachments[] = { type, url, filename?, mime? },详见 DESIGN.md §5.3。
 *
 * 准入用黑名单(见 UNSAFE_EXTENSIONS):默认放行,仅按文件扩展名拦截可执行/脚本类。
 * 不用 MIME —— 平台对未知类型常回 application/octet-stream,后缀才是执行风险的直接信号。
 * 命中的附件静默跳过(不算失败),计入 skipped 供 buildSkippedAttachmentsNote 提示用户。
 *
 * 放行的附件一旦下载/落盘失败即抛 AttachmentDownloadError,turn-resolver 会发
 * outbound.error 收尾、本轮不进 agent。平台已保证 URL 可达,失败基本是真异常,
 * 喂半套附件给 agent 只会误导回复。
 *
 * 落盘复用 SDK saveMediaBuffer,subdir 固定 "inbound" 与 chat.send 路径对齐。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { Logger } from "../runtime/logger.js";
import { describeError } from "../runtime/logger.js";
import type { InboundAttachment } from "../transport/frames.js";

// 从 PluginRuntime 公开类型链反推 media 子接口,绕开 SDK 未导出的私有子路径
// (openclaw/plugin-sdk/media)。与 turn-resolver.ts 反推 ResolveTurnReturn 同款手法。
type RuntimeMedia = PluginRuntime["channel"]["media"];
type FetchRemoteMediaFn = RuntimeMedia["fetchRemoteMedia"];
type SaveMediaBufferFn = RuntimeMedia["saveMediaBuffer"];

/**
 * 不安全文件后缀黑名单(小写,不含点),命中即拒收。覆盖落盘后可能被直接执行的类型:
 * 原生可执行/安装包、脚本、快捷方式链接、含宏的 Office 文档。
 *
 * 这是粗粒度防御,只挡最常见的可执行投递面;内容级安全交给沙箱与下游模型边界。
 */
export const UNSAFE_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // 原生可执行 / 库 / 安装包
    "exe", "dll", "com", "scr", "msi", "msp", "cpl", "drv", "sys", "ocx",
    "pif", "gadget", "jar", "app", "deb", "rpm", "dmg", "pkg", "apk",
    // 脚本 / 批处理 / 解释执行
    "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "hta", "sh", "bash", "zsh", "py", "pl", "rb", "php",
    // 快捷方式 / 链接(可指向任意命令)
    "lnk", "url", "scf", "inf", "reg",
    // 含宏的 Office 文档(启用宏即可执行 VBA)
    "docm", "xlsm", "pptm", "dotm", "xltm", "potm",
  ]),
);

/** 与 DESIGN.md §6.1 capabilities.media.maxSizeBytes (20MB) 对齐。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 下载/落盘失败时抛出。只带 filename 不带原始 URL,避免外链泄漏到平台 UI。 */
export class AttachmentDownloadError extends Error {
  public readonly filename: string;
  public override readonly cause?: unknown;

  constructor(filename: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AttachmentDownloadError";
    this.filename = filename;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

export interface AttachmentMediaRuntime {
  fetchRemoteMedia: FetchRemoteMediaFn;
  saveMediaBuffer: SaveMediaBufferFn;
}

export interface ProcessAttachmentsParams {
  attachments: InboundAttachment[] | undefined;
  media: AttachmentMediaRuntime;
  /** 单文件最大字节;默认 20MB,跟 capabilities 一致。 */
  maxBytes?: number;
  log?: Logger;
}

/**
 * ctxPayload 片段,可直接 Object.assign 合并。无附件时 fields 为空,SDK 走纯文本路径。
 */
export interface AttachmentInjection {
  fields: {
    MediaPath?: string;
    MediaPaths?: string[];
    MediaType?: string;
    MediaTypes?: string[];
  };
  /** 已成功下载的附件数量,用于日志。 */
  acceptedCount: number;
  /** 因命中不安全后缀黑名单被跳过的附件;调用方可决定是否在 textForAgent 末尾追加提示。 */
  skipped: Array<{ filename: string; mime: string; reason: "unsafe-extension" }>;
}

function pickFilename(att: InboundAttachment, idx: number): string {
  const f = att.filename?.trim();
  if (f) return f;
  // 无文件名时用带 idx 的占位,主要给日志/错误消息
  return `attachment-${idx + 1}`;
}

/**
 * 解析 mime:优先帧上显式 mime,其次下载响应的 Content-Type,都没有则空串(unknown)。
 * 黑名单策略下 mime 只用于落盘与日志,不参与准入。
 */
function resolveDeclaredMime(
  att: InboundAttachment,
  fetchedContentType?: string,
): string {
  const declared = att.mime?.trim() ?? "";
  if (declared) return declared.toLowerCase();
  const ct = fetchedContentType?.trim() ?? "";
  if (ct) {
    // 剥掉参数:text/plain; charset=utf-8 → text/plain
    return ct.split(";")[0]!.trim().toLowerCase();
  }
  return "";
}

/**
 * 取小写扩展名(不含点),无则空串。只认最后一段:archive.tar.gz → gz。
 * 先剥掉 query/fragment —— 平台偶尔把带 ?token 的直链塞进 filename。
 */
function extractExtension(filename: string): string {
  const clean = filename.split(/[?#]/)[0]!.trim();
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) {
    // 点在首位的隐藏文件(.bashrc)整体当扩展名;无点或点在末尾则无扩展名
    return dot === 0 ? clean.slice(1).toLowerCase() : "";
  }
  return clean.slice(dot + 1).toLowerCase();
}

/** 命中不安全后缀黑名单即拒收。无扩展名(空串)默认放行。 */
function isUnsafeAttachment(filename: string): boolean {
  const ext = extractExtension(filename);
  return ext.length > 0 && UNSAFE_EXTENSIONS.has(ext);
}

/**
 * 串行下载 + 落盘。串行(非并行)是因为单轮附件量级小(通常 1-3 个),
 * 串行让失败定位更可预测;量级变大时再改并行,届时需重估失败清理语义。
 */
export async function processInboundAttachments(
  params: ProcessAttachmentsParams,
): Promise<AttachmentInjection> {
  const { attachments, media, log } = params;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  if (!attachments || attachments.length === 0) {
    return { fields: {}, acceptedCount: 0, skipped: [] };
  }

  const paths: string[] = [];
  const types: string[] = [];
  const skipped: AttachmentInjection["skipped"] = [];

  for (const [idx, att] of attachments.entries()) {
    const filename = pickFilename(att, idx);
    const url = att.url?.trim();
    if (!url) {
      // url 必填,缺失视为平台传错;不阻塞 agent,记 warn 跳过
      log?.warn?.(
        `attachment[${idx}] "${filename}": missing url, skipped (platform should always send url)`,
      );
      continue;
    }

    // 命中黑名单连下载都跳过,省带宽且不落盘
    if (isUnsafeAttachment(filename)) {
      const mime = (att.mime?.trim() ?? "").toLowerCase();
      log?.warn?.(
        `attachment[${idx}] "${filename}": unsafe extension, skipped (blacklisted)`,
      );
      skipped.push({ filename, mime, reason: "unsafe-extension" });
      continue;
    }

    let fetched: Awaited<ReturnType<typeof media.fetchRemoteMedia>>;
    try {
      fetched = await media.fetchRemoteMedia({ url, maxBytes });
    } catch (err) {
      throw new AttachmentDownloadError(
        filename,
        `failed to fetch attachment "${filename}": ${describeError(err)}`,
        { cause: err },
      );
    }

    const finalMime = resolveDeclaredMime(att, fetched.contentType);

    let saved: Awaited<ReturnType<typeof media.saveMediaBuffer>>;
    try {
      saved = await media.saveMediaBuffer(
        fetched.buffer,
        finalMime,
        "inbound",
        maxBytes,
        filename,
      );
    } catch (err) {
      throw new AttachmentDownloadError(
        filename,
        `failed to save attachment "${filename}" to media store: ${describeError(err)}`,
        { cause: err },
      );
    }

    paths.push(saved.path);
    types.push(finalMime);
    log?.info?.(
      `attachment[${idx}] saved: filename="${filename}" mime=${finalMime} bytes=${saved.size} path=${saved.path}`,
    );
  }

  if (paths.length === 0) {
    return { fields: {}, acceptedCount: 0, skipped };
  }

  return {
    fields: {
      MediaPath: paths[0]!,
      MediaPaths: paths,
      MediaType: types[0]!,
      MediaTypes: types,
    },
    acceptedCount: paths.length,
    skipped,
  };
}

/**
 * 把跳过的不安全附件拼成一段提示 append 到 textForAgent 末尾,让 agent 知道用户
 * 发了文件但被忽略,避免"我没收到附件"的尴尬回答。无可提示则返回空串。
 */
export function buildSkippedAttachmentsNote(
  skipped: AttachmentInjection["skipped"],
): string {
  if (skipped.length === 0) return "";
  const items = skipped
    .map((s) => `${s.filename}${s.mime ? ` (${s.mime})` : ""}`)
    .join(", ");
  return `\n[已忽略不安全的附件:${items}]`;
}
