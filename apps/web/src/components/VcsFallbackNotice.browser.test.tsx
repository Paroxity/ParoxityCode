import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { ComposerBannerStack } from "./chat/ComposerBannerStack";
import { useVcsFallbackNoticeItem, type VcsFallbackNoticeInput } from "./VcsFallbackNotice";

function emptyLocalStorage(): Disposable {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

function Notice(props: VcsFallbackNoticeInput) {
  const item = useVcsFallbackNoticeItem(props);
  return <ComposerBannerStack items={item ? [item] : []} detached />;
}

it("persists fallback dismissal per repository and resurfaces changed text or reason", async () => {
  using _storage = emptyLocalStorage();
  const repository = "/fallback-notice";
  const props = {
    environmentId: "test",
    repository,
    notice: "Jujutsu unavailable; using Git",
    reason: null as string | null,
  };
  const dismiss = { name: "Dismiss repository fallback notice" };
  await using screen = await render(<Notice {...props} />);
  await expect.element(screen.getByText(props.notice, { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", dismiss));
  await expect.element(screen.getByText(props.notice, { exact: true })).not.toBeInTheDocument();
  await screen.rerender(<Notice {...props} key="remount" />);
  await expect.element(screen.getByText(props.notice, { exact: true })).not.toBeInTheDocument();
  await screen.rerender(<Notice {...props} repository={`${repository}/other`} />);
  await expect.element(screen.getByText(props.notice, { exact: true })).toBeVisible();
  await screen.rerender(<Notice {...props} notice="Jujutsu configuration changed; using Git" />);
  await expect.element(screen.getByText("configuration changed", { exact: false })).toBeVisible();
  await userEvent.click(screen.getByRole("button", dismiss));
  await screen.rerender(
    <Notice
      {...props}
      notice="Jujutsu configuration changed; using Git"
      reason="Unsupported workspace"
    />,
  );
  await expect.element(screen.getByText("configuration changed", { exact: false })).toBeVisible();
});
