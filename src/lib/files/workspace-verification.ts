export const FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT =
  "nocturne:workspace-ssh-verification-submitted";

export type FilesWorkspaceSshVerificationSubmittedDetail = {
  workspaceId: string;
};

export function isFilesWorkspaceVerificationPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SshWorkspaceChallenge") ||
    message.includes("SSH credential required") ||
    message.includes("Waiting for Workspace verification")
  );
}

