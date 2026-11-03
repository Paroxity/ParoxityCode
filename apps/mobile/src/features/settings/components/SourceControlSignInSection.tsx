import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useGT } from "gt-react-native";
import type { SourceControlSignInPrompt } from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import * as Cause from "effect/Cause";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Linking } from "react-native";
import { m } from "../../../i18n/messages";

import * as Dialog from "../../../components/ui/Dialog";
import { serverEnvironment } from "../../../state/server";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? (errorDisplayMessage(error, m) ?? error.message) : String(error);
};

const openUrl = (url: string) => void Linking.openURL(url).catch(() => undefined);

/** Signs an environment in through a forge's own app, such as T3 Code for GitHub. */
export function AppSignInRow(props: {
  readonly environment: SettingsTarget;
  readonly label: string;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const { environment, definition, appSignIn } = props;
  const environmentId = environment.environmentId;
  const host = appSignIn.hosts[0] ?? "";
  const { signIns } = readHostCredentialSettings(
    environment.serverConfig.settings,
    definition.kind,
  );
  const signedIn = (signIns[host] ?? "").length > 0;
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  // The attempt a pending `wait` belongs to; a cancel or a newer attempt makes its outcome stale.
  const attempt = useRef<SourceControlSignInPrompt | null>(null);
  const input = { provider: definition.kind, host };
  const { label } = definition;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `sign out of ${appSignIn.appName}`,
  });
  const [pending, setPending] = useState<SourceControlSignInPrompt | "starting" | null>(null);

  const cancelButton = {
    text: gt("Cancel"),
    style: "cancel" as const,
    onPress: () => {
      attempt.current = null;
      setPending(null);
      void cancel({ environmentId, input });
    },
  };

  const showPrompt = (prompt: SourceControlSignInPrompt) => {
    const { userCode } = prompt;
    if (userCode === undefined) {
      Dialog.alert(
        gt("Waiting for approval"),
        gt(
          "Approve {app} in your browser. The server finishes signing in even if you leave the app.",
          { app: appSignIn.appName },
        ),
        [cancelButton, { text: gt("Open again"), onPress: () => openUrl(prompt.verificationUri) }],
      );
      return;
    }
    void Clipboard.setStringAsync(userCode).catch(() => undefined);
    Dialog.alert(
      userCode,
      gt(
        "Enter this code on {host}, then approve {app}. It is copied. The server finishes signing in even if you leave the app.",
        { host: label, app: appSignIn.appName },
      ),
      [
        cancelButton,
        {
          text: gt("Open {host}", { host: label }),
          onPress: () => openUrl(prompt.verificationUri),
        },
      ],
    );
  };

  const signIn = async (account?: string) => {
    setPending("starting");
    const started = await start({
      environmentId,
      input: { ...input, ...(account !== undefined && { account }) },
    });
    if (started._tag !== "Success") {
      setPending(null);
      Dialog.alert(gt("Could not start the sign-in"), failureMessage(started.cause));
      return;
    }
    const prompt = started.value;
    attempt.current = prompt;
    setPending(prompt);
    if (prompt.userCode === undefined) openUrl(prompt.verificationUri);
    else showPrompt(prompt);
    const finished = await wait({ environmentId, input });
    if (attempt.current !== prompt) return;
    attempt.current = null;
    setPending(null);
    if (finished._tag !== "Success") {
      Dialog.alert(gt("Sign-in did not finish"), failureMessage(finished.cause));
    }
  };

  const signOut = () =>
    void updateSettings({
      environmentId,
      // Send the whole map; other hosts' redaction markers preserve their sessions.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { signIns: { ...signIns, [host]: "" } } },
        },
      },
    });

  const askForAccount = (account: NonNullable<SourceControlAppSignIn["account"]>) =>
    Dialog.prompt({
      title: gt("Sign in to {host}", { host: label }),
      message: account.label,
      placeholder: account.placeholder,
      initialValue: "",
      confirmText: gt("Continue"),
      onConfirm: (value) => {
        if (value.trim() !== "") void signIn(value.trim());
      },
    });

  const onPress = () => {
    if (signedIn) {
      const { installUrl } = appSignIn;
      Dialog.alert(
        appSignIn.appName,
        installUrl === undefined
          ? gt("Signed in.")
          : gt(
              "Signed in. {host} requests use the app's higher rate limit, in repositories where the app is installed.",
              { host: label },
            ),
        [
          ...(installUrl === undefined
            ? []
            : [{ text: gt("Install on an organization"), onPress: () => openUrl(installUrl) }]),
          { text: gt("Sign out"), style: "destructive", onPress: signOut },
          { text: gt("Cancel"), style: "cancel" },
        ],
      );
    } else if (pending !== null && pending !== "starting") {
      showPrompt(pending);
    } else if (pending === null && appSignIn.account !== undefined) {
      askForAccount(appSignIn.account);
    } else if (pending === null) {
      void signIn();
    }
  };

  return (
    <SettingsRow
      icon="person.crop.circle"
      label={props.label}
      value={
        signedIn
          ? gt("Signed in")
          : pending === "starting"
            ? gt("Starting…")
            : pending === null
              ? gt("Sign in")
              : pending.userCode === undefined
                ? gt("Waiting for approval")
                : gt("Enter {code}", { code: pending.userCode })
      }
      disabled={props.disabled}
      onPress={onPress}
    />
  );
}
