/**
 * leyemeta WebSocket 握手参数构造器。
 *
 * - `Authorization: Bearer <member_key>` 走标准 HTTP 鉴权,upgrade 阶段被拒 ⇒ 401
 * - `Sec-WebSocket-Protocol: leyemeta.openclaw.v1` 仅传协议版本,不放密钥
 * - `X-Plugin-Version` / `X-Account-Id` 仅诊断用,不参与鉴权
 */

export const LEYEMETA_SUBPROTOCOL = "leyemeta.openclaw.v1" as const;

export interface BuildHandshakeOptions {
  memberKey: string;
  accountId: string;
  /** 排障用,一般取 package.json.version,由调用方注入。 */
  pluginVersion: string;
}

export interface HandshakeArtifacts {
  headers: Record<string, string>;
  protocols: readonly string[];
}

export function buildHandshake(opts: BuildHandshakeOptions): HandshakeArtifacts {
  if (!opts.memberKey) {
    throw new Error("buildHandshake: memberKey is required");
  }
  if (!opts.accountId) {
    throw new Error("buildHandshake: accountId is required");
  }

  return {
    headers: {
      Authorization: `Bearer ${opts.memberKey}`,
      "X-Plugin-Version": opts.pluginVersion,
      "X-Account-Id": opts.accountId,
    },
    protocols: [LEYEMETA_SUBPROTOCOL],
  };
}
