import type { ChannelMeta } from "openclaw/plugin-sdk/channel-contract";

import { LEYEMETA_CHANNEL_ID } from "../types.js";

export const meta: ChannelMeta = {
  id: LEYEMETA_CHANNEL_ID,
  label: "乐椰星球",
  selectionLabel: "乐椰星球（平台对接）",
  docsPath: "/channels/leyemeta",
  blurb: "把 乐椰星球 平台智能体接入 OpenClaw",
};
