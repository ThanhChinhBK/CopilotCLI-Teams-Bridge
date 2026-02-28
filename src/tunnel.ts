import * as vscode from "vscode";

/**
 * Opens a VS Code Dev Tunnel on the given local port and returns the
 * public URI that Azure Bot Service should POST to.
 */
export async function openTunnel(localPort: number): Promise<vscode.Uri> {
  const localUri = vscode.Uri.parse(`http://localhost:${localPort}`);
  const tunnelUri = await vscode.env.asExternalUri(localUri);
  return tunnelUri;
}
