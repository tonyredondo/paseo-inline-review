import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

declare function contribute(client: PluginClientContext): PluginCleanup;

export default contribute;
