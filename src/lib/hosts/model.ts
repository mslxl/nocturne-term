import type { ConnectionHostDocument, ConnectionProtocol, ConnectionHostEntry, LocalConnectionConfig, SshConnectionConfig } from "$lib/bindings";
import { catalogIcon } from "$lib/hosts/icons";

export type HostFolderTreeNode = {
  key: string;
  name: string;
  path: string;
  children: HostFolderTreeNode[];
  hosts: ConnectionHostEntry[];
};

export function emptySshHostDocument(id = ""): ConnectionHostDocument {
  return {
    version: 1,
    id,
    name: "New Host",
    folder: null,
    icon: catalogIcon("lucide:server"),
    files: null,
    resources: null,
    protocol: "ssh",
    local: null,
    ssh: {
      hostname: "",
      port: 22,
      username: null,
      identity_file: null,
      proxy_jump: null,
      forward_agent: false,
      server_alive_interval: null,
    },
    telnet: null,
  };
}

export function emptyLocalHostDocument(id = ""): ConnectionHostDocument {
  return {
    version: 1,
    id,
    name: "Local Shell",
    folder: null,
    icon: catalogIcon("lucide:terminal"),
    files: null,
    resources: null,
    protocol: "local",
    local: {
      command: null,
      args: [],
      cwd: null,
      env: {},
    },
    ssh: null,
    telnet: null,
  };
}

export function setHostProtocol(document: ConnectionHostDocument, protocol: ConnectionProtocol): ConnectionHostDocument {
  const next = cloneHostDocument(document);
  next.protocol = protocol;
  if (protocol === "local") {
    next.local ??= { command: null, args: [], cwd: null, env: {} };
    next.ssh = null;
    next.telnet = null;
  } else if (protocol === "ssh") {
    next.local = null;
    next.ssh ??= emptySshHostDocument(next.id).ssh;
    next.telnet = null;
  } else {
    next.local = null;
    next.ssh = null;
    next.telnet ??= { hostname: "", port: 23 };
  }
  return next;
}

export function cloneHostDocument(document: ConnectionHostDocument): ConnectionHostDocument {
  return JSON.parse(JSON.stringify(document)) as ConnectionHostDocument;
}

export function hostAddress(entry: ConnectionHostEntry): string {
  if (entry.document.protocol === "local" && entry.document.local) {
    return localCommandLabel(entry.document.local);
  }
  if (entry.document.protocol === "ssh" && entry.document.ssh) {
    return sshDisplayAddress(entry.document.ssh);
  }
  if (entry.document.protocol === "telnet" && entry.document.telnet) {
    return `${entry.document.telnet.hostname}:${entry.document.telnet.port}`;
  }
  return "";
}

export function hostSubtitle(entry: ConnectionHostEntry): string {
  return hostAddress(entry);
}

export function hostFolderLabel(entry: ConnectionHostEntry): string {
  return entry.document.folder?.trim() || "Hosts";
}

export function hostFolderPath(entry: ConnectionHostEntry): string {
  return entry.document.folder?.trim() || "";
}

export function buildHostFolderTree(hosts: ConnectionHostEntry[]): HostFolderTreeNode {
  const root: HostFolderTreeNode = { key: "__root__", name: "Hosts", path: "", children: [], hosts: [] };
  const nodes = new Map<string, HostFolderTreeNode>([[root.path, root]]);
  const sortedHosts = [...hosts].sort((a, b) => a.document.name.localeCompare(b.document.name) || a.id.localeCompare(b.id));
  for (const host of sortedHosts) {
    const folder = hostFolderPath(host);
    if (!folder) {
      root.hosts.push(host);
      continue;
    }
    const parts = folder.split("/").map((part) => part.trim()).filter(Boolean);
    let current = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let child = nodes.get(path);
      if (!child) {
        child = { key: path, name: part, path, children: [], hosts: [] };
        nodes.set(path, child);
        current.children.push(child);
        current.children.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      }
      current = child;
    }
    current.hosts.push(host);
  }
  return root;
}

export function hostFolderPaths(tree: HostFolderTreeNode): string[] {
  const paths: string[] = [];
  function visit(node: HostFolderTreeNode) {
    for (const child of node.children) {
      paths.push(child.path);
      visit(child);
    }
  }
  visit(tree);
  return paths;
}

export function hostSourceLabel(entry: ConnectionHostEntry): string {
  if (entry.source === "virtual") return "Nocturne";
  if (entry.source === "open_ssh_config") return "~/.ssh/config";
  if (entry.path) return entry.path;
  return "Nocturne";
}

export function hostHasBlockingDiagnostics(entry: ConnectionHostEntry): boolean {
  return entry.diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function sshAddress(config: SshConnectionConfig): string {
  const host = config.hostname.includes(":") && !config.hostname.startsWith("[") ? `[${config.hostname}]` : config.hostname;
  return `${host}:${config.port}`;
}

export function sshDisplayAddress(config: SshConnectionConfig): string {
  const address = sshAddress(config);
  const username = config.username?.trim();
  return username ? `${username}@${address}` : address;
}

export function localCommandLabel(config: LocalConnectionConfig): string {
  return config.command?.trim() || "System shell";
}

export function compactOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
