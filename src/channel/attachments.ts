/**
 * attachments —— 入站附件下载与落盘,把平台 URL 直链转成 OpenClaw agent
 * 可读的本地媒体路径,并产出可合并进 ctxPayload 的 Media* 字段。
 *
 * 协议契约(权威:DESIGN.md §5.3 / §11 Q3 / frames.ts):
 *   inbound.message.payload.attachments[] = { type, url, filename?, mime? }
 *   URL 直链,平台保证可访问,本插件负责下载入沙箱。
 *
 * 支持范围(DESIGN.md §6.1 capabilities.media.supportedTypes):
 *   image/* + application/pdf + text/plain
 *   超出范围的附件 → 仅 warn,**静默跳过**,不阻塞对话(下载根本不发起);
 *   不算"失败",不触发 outbound.error。
 *
 * 失败兜底策略(本批用户决策):**任一在白名单内的附件下载失败 → 抛 AttachmentDownloadError**,
 *   由 turn-resolver 捕获后发 outbound.error(UPSTREAM_DOWN) + done:true 收尾,
 *   本轮不进 agent。设计取舍:平台已对 URL 做可达性保证,这里失败基本意味着真出
 *   网络/平台异常,降级喂半套附件给 agent 反而误导回复。
 *
 * 落盘:复用 SDK `saveMediaBuffer(buffer, mime, "inbound", maxBytes, filename)`,
 *   subdir 固定 "inbound" 与 chat.send RPC 路径对齐。返回的 `path` 即填入
 *   ctxPayload.MediaPath/MediaPaths。
 *
 * 与 SDK chat.send 路径的差异:
 *   - chat.send 路径会区分"图片 inline vs offload"并对非图片做 sandbox staging
 *     (`prestageMediaPathOffloads`),但该工具未通过 PluginRuntime 暴露
 *   - 本实现统一走"全部 offload 到 inbound 子目录 + 直接填 MediaPath",
 *     等同 chat.send 在 model supportsImages=false 时的行为。
 *     agent 通过 MsgContext.MediaPaths 拿到磁盘绝对路径,符合 SDK 现有约定。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { Logger } from "../runtime/logger.js";
import { describeError } from "../runtime/logger.js";
import type { InboundAttachment } from "../transport/frames.js";

/**
 * 通过 PluginRuntime 公开类型链反推 media 子接口,避免直接 import 未在
 * `exports` map 中暴露的 SDK 私有子路径(`openclaw/plugin-sdk/media`)。
 * 与 turn-resolver.ts 反推 ResolveTurnReturn 同款手法。
 */
type RuntimeMedia = PluginRuntime["channel"]["media"];
type FetchRemoteMediaFn = RuntimeMedia["fetchRemoteMedia"];
type SaveMediaBufferFn = RuntimeMedia["saveMediaBuffer"];

/**
 * 与 DESIGN.md §6.1 capabilities.media 对齐;改这里也要同步改 capabilities.ts。
 *
 * 关于 application/octet-stream:平台直链经常对未识别类型回 octet-stream,
 * 帧上 mime 也可能传成 octet-stream。允许它直接放行,把 mime 真伪交给下游
 * 多模态模型自行处理(它们对未知二进制要么忽略要么报错,不会污染主流程)。
 * 取舍来自 2026-05-20 用户决策:接受 agent 偶尔拿到非媒体二进制的风险,
 * 换平台/前端零改动。
 */
export const SUPPORTED_MIME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^image\//i,
  /^application\/pdf$/i,
  /^text\/plain$/i,
  /^application\/octet-stream$/i,
]);

/** 与 DESIGN.md §6.1 capabilities.media.maxSizeBytes (20MB) 对齐。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * 单次下载失败/落盘失败 → 抛出;turn-resolver 捕获后发 outbound.error。
 * 不暴露原始 URL 给前端(只放 filename),避免外链泄漏到平台 UI。
 */
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
 * ctxPayload 片段:可直接 `Object.assign(ctxPayload, fields)` 合并。
 * 当无附件命中时,返回空 fields(不写 MediaPath),让 SDK 走纯文本路径。
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
  /** 因不支持 mime 被跳过的附件;调用方可决定是否在 textForAgent 末尾追加提示。 */
  skipped: Array<{ filename: string; mime: string; reason: "unsupported-mime" }>;
}

function pickFilename(att: InboundAttachment, idx: number): string {
  const f = att.filename?.trim();
  if (f) return f;
  // 无文件名时退化为带 idx 的占位,主要给日志/错误消息用
  return `attachment-${idx + 1}`;
}

/**
 * mime 解析优先级:
 *   1. 帧上显式 mime(平台已知则最权威)
 *   2. response Content-Type(下载时返回,作为兜底)
 *   3. 文件名扩展名(不在这里推断,交给 SDK saveMediaBuffer)
 * 这里只返回"判定是否支持"用的 mime,即(1) || (2),空字符串视为 unknown。
 */
function resolveDeclaredMime(
  att: InboundAttachment,
  fetchedContentType?: string,
): string {
  const declared = att.mime?.trim() ?? "";
  if (declared) return declared.toLowerCase();
  const ct = fetchedContentType?.trim() ?? "";
  if (ct) {
    // 剥离参数(`text/plain; charset=utf-8` → `text/plain`)
    return ct.split(";")[0]!.trim().toLowerCase();
  }
  return "";
}

function isSupportedMime(mime: string): boolean {
  if (!mime) return false;
  return SUPPORTED_MIME_PATTERNS.some((re) => re.test(mime));
}

/**
 * 串行下载 + 落盘。
 *
 * 串行而非并行:
 *   - leyemeta 单轮附件量级小(平台 UI 通常 1-3 个)
 *   - 串行让日志/失败定位更可预测,避免并发竞态进 saveMediaBuffer
 *   - 后续单轮量级变大可改 Promise.all,但需重新评估失败语义
 *     (并行下半数失败时,已落盘的要不要清理)
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
      // 协议要求 url 必填;空 url 视为平台传错,不阻塞 agent,记 warn 跳过
      log?.warn?.(
        `attachment[${idx}] "${filename}": missing url, skipped (platform should always send url)`,
      );
      continue;
    }

    // 先用帧上 mime 做粗筛 —— 不支持的类型连下载都跳过,省带宽
    const preMime = (att.mime?.trim() ?? "").toLowerCase();
    if (preMime && !isSupportedMime(preMime)) {
      log?.warn?.(
        `attachment[${idx}] "${filename}": unsupported mime "${preMime}", skipped`,
      );
      skipped.push({ filename, mime: preMime, reason: "unsupported-mime" });
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

    // 帧上 mime 缺失时,基于响应 Content-Type 复查一次支持范围
    const finalMime = resolveDeclaredMime(att, fetched.contentType);
    if (!isSupportedMime(finalMime)) {
      log?.warn?.(
        `attachment[${idx}] "${filename}": mime "${finalMime || "unknown"}" not supported after fetch, skipped`,
      );
      skipped.push({
        filename,
        mime: finalMime,
        reason: "unsupported-mime",
      });
      continue;
    }

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
 * 把被跳过的不支持附件信息拼成一段提示,append 到 textForAgent 末尾,
 * 让 agent 知道用户其实发了某个文件但被忽略,避免"我没收到附件"的尴尬回答。
 *
 * 返回空字符串表示无需追加。
 */
export function buildSkippedAttachmentsNote(
  skipped: AttachmentInjection["skipped"],
): string {
  if (skipped.length === 0) return "";
  const items = skipped
    .map((s) => `${s.filename}${s.mime ? ` (${s.mime})` : ""}`)
    .join(", ");
  return `\n[已忽略不支持的附件:${items}]`;
}
