import { commands, type ConfigDocumentTarget, type ConfigValue, type MainConfigDocument, type ProfileConfigDocument } from "$lib/bindings";
import { cloneDocument, writeValue, type ConfigDocument } from "$lib/config/document";
import { unwrapCommand } from "$lib/terminal/commands";

export type SaveTarget = {
  kind: ConfigDocumentTarget;
  profile?: string;
};

export async function saveConfigValue(
  target: SaveTarget,
  document: ConfigDocument,
  path: string[],
  value: ConfigValue | undefined,
) {
  if (!value) {
    await unwrapCommand(
      commands.removeConfigKey({
        target: target.kind,
        profile: target.kind === "profile" ? target.profile ?? null : null,
        path,
      }),
    );
    return;
  }

  const next = cloneDocument(document);
  writeValue(next.root, path, value);
  if (target.kind === "main") {
    await unwrapCommand(commands.updateMainConfig(next as MainConfigDocument));
    return;
  }
  const profile = target.profile;
  if (!profile) throw new Error("profile target requires profile name");
  await unwrapCommand(commands.updateProfile({ name: profile, document: next as ProfileConfigDocument }));
}
