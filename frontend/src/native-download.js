import { registerPlugin } from "@capacitor/core";

// The direct Android shell registers this plugin. On web and on older shells
// this remains unavailable, so callers retain their existing browser/share
// fallback without changing normal website behavior.
export const DirectDownload = registerPlugin("DirectDownload");
