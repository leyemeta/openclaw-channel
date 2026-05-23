import type { ChannelCapabilities } from "openclaw/plugin-sdk/channel-contract";

export const capabilities: ChannelCapabilities = {
  chatTypes: ["direct"],
  reactions: false,
  edit: false,
  threads: false,
  reply: false,
  media: true,
};
