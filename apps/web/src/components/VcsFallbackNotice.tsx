import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { InfoIcon } from "lucide-react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";

export interface VcsFallbackNoticeInput {
  readonly environmentId: string;
  readonly repository: string;
  /** The server's text for a colocated jj repository it is running with Git. */
  readonly notice: string | null;
  readonly reason: string | null;
}

/** The fallback notice as a composer banner, until dismissed for that repository and text. */
export function useVcsFallbackNoticeItem(
  input: VcsFallbackNoticeInput | null,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const [dismissed, setDismissed] = useLocalStorage(
    `vcs-fallback-notice:${JSON.stringify([input?.environmentId ?? null, input?.repository ?? null])}`,
    "",
    Schema.String,
  );
  if (!input?.notice) return null;
  const fingerprint = JSON.stringify([input.notice, input.reason]);
  if (dismissed === fingerprint) return null;
  return {
    id: "vcs-fallback",
    variant: "info",
    group: "environment",
    icon: <InfoIcon />,
    title: input.notice,
    dismissLabel: gt("Dismiss repository fallback notice"),
    onDismiss: () => setDismissed(fingerprint),
  };
}
